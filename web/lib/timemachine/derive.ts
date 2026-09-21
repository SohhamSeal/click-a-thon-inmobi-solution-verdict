/** Pure functions: simTime → everything visible. Scrubbing backward is free. */

import { markersFromCases, parseMs } from '@/lib/anomalies';
import type { Case, Series, Step } from '@/lib/types';
import type {
  CaseView,
  DerivedReplay,
  ReplayCase,
  StepRow,
  TimeMachineFixture,
} from './types';

export { parseMs };

const MS = {
  localize: (name: string) => name.startsWith('localize:'),
  confidence: (name: string) => name === 'confidence' || name.startsWith('confidence'),
  narrate: (name: string) => name === 'narrate' || name.startsWith('narrate'),
  correct: (name: string) => name === 'correct',
  detect: (name: string) => name === 'detect' || name.startsWith('temporal:') || name.startsWith('structural:'),
};

function maxOffset(steps: StepRow[]): number {
  if (!steps.length) return 1;
  return Math.max(1, ...steps.map(s => s.offset_ms));
}

function runMaxOffset(cases: ReplayCase[]): number {
  let m = 1;
  for (const c of cases) m = Math.max(m, maxOffset(c.steps_flat));
  return m;
}

function progressInInvestigation(
  simTimeMs: number,
  windowStartMs: number,
  windowEndMs: number,
  fraction: number,
): number {
  const span = Math.max(1, windowEndMs - windowStartMs);
  const investEnd = windowStartMs + span * fraction;
  if (simTimeMs <= windowStartMs) return 0;
  if (simTimeMs >= investEnd) return 1;
  return (simTimeMs - windowStartMs) / (investEnd - windowStartMs);
}

function revealedIds(steps: StepRow[], progress01: number, offsetCap: number): Set<string> {
  const threshold = progress01 * offsetCap;
  const out = new Set<string>();
  for (const s of steps) {
    if (s.offset_ms <= threshold + 1e-9) out.add(s.step_id);
  }
  return out;
}

function hasRevealed(steps: StepRow[], ids: Set<string>, pred: (name: string) => boolean): boolean {
  return steps.some(s => pred(s.name) && ids.has(s.step_id));
}

function filterTree(root: Step | null, ids: Set<string>): Step | null {
  if (!root) return null;
  const walk = (n: Step): Step | null => {
    if (!ids.has(n.step_id) && n.step_id !== 'synthetic-root') {
      // Keep a parent if any descendant is revealed.
      const kids = (n.children ?? []).map(walk).filter((c): c is Step => c != null);
      if (!kids.length) return null;
      return { ...n, children: kids };
    }
    const children = (n.children ?? []).map(walk).filter((c): c is Step => c != null);
    return { ...n, children };
  };
  return walk(root);
}

/** Apply progressive unlocks so the existing drawer keeps working unchanged. */
export function maskCase(c: ReplayCase, view: CaseView): Case {
  const trace = filterTree(c.trace, view.revealedStepIds);
  return {
    ...c,
    trace,
    candidates: view.evidenceUnlocked ? c.candidates : [],
    coverage: view.evidenceUnlocked ? c.coverage : [],
    coverage_total: view.evidenceUnlocked ? c.coverage_total : 0,
    narrative: view.narrativeDone ? c.narrative : '',
    narrative_source: view.narrativeDone ? c.narrative_source : 'template',
    unsupported: view.narrativeDone ? c.unsupported : [],
    // While investigating, keep the real verdict_kind for when we flip; table uses uiStatus.
    confidence: view.confidenceDone ? c.confidence : 0,
    publishable: view.confidenceDone ? c.publishable : false,
  };
}

function clipSeries(series: Series[], simTimeMs: number): Series[] {
  return series.map(s => {
    const points = s.points.filter(p => parseMs(p.t) <= simTimeMs);
    if (!points.length) {
      return { ...s, points: [], from: -1, to: -1, effect: 0 };
    }
    const outside = points
      .map((p, i) => (p.observed < p.lo || p.observed > p.hi ? i : -1))
      .filter(i => i >= 0);
    const from = outside.length ? outside[0] : -1;
    const to = outside.length ? outside[outside.length - 1] : -1;
    let effect = 0;
    if (from >= 0) {
      const span = points.slice(from, to + 1);
      const obs = span.reduce((a, p) => a + p.observed, 0);
      const exp = span.reduce((a, p) => a + p.expected, 0);
      effect = exp !== 0 ? (obs - exp) / exp : 0;
    }
    return { ...s, points, from, to, effect };
  });
}

/** Prefer the hour farthest outside the expected band; else largest |relative| in-window. */
export { findParentAnomaly } from '@/lib/anomalies';

function caseView(
  c: ReplayCase,
  simTimeMs: number,
  fraction: number,
  offsetCap: number,
): CaseView | null {
  const start = parseMs(c.window_start);
  const end = parseMs(c.window_end);
  if (simTimeMs < start) return null;

  const progress01 = progressInInvestigation(simTimeMs, start, end, fraction);
  const ids = revealedIds(c.steps_flat, progress01, offsetCap);

  // Cases land after the shared detect/correct sweep — matching how the engine found them.
  const hasSweep = c.steps_flat.some(s => MS.detect(s.name) || MS.correct(s.name));
  const sweepDone =
    hasRevealed(c.steps_flat, ids, MS.correct) || hasRevealed(c.steps_flat, ids, MS.detect);
  if (hasSweep && !sweepDone) return null;

  const localizeDone = hasRevealed(c.steps_flat, ids, MS.localize);
  const confidenceDone = hasRevealed(c.steps_flat, ids, MS.confidence);
  const narrativeDone =
    hasRevealed(c.steps_flat, ids, MS.narrate) ||
    (confidenceDone && !c.steps_flat.some(s => MS.narrate(s.name)));

  return {
    case: c,
    uiStatus: localizeDone ? 'verdict' : 'investigating',
    revealedStepIds: ids,
    localizeDone,
    confidenceDone,
    narrativeDone,
    evidenceUnlocked: localizeDone,
  };
}

export function deriveReplay(fixture: TimeMachineFixture, simTimeMs: number, selectedCaseId: string | null): DerivedReplay {
  const timelineStartMs = parseMs(fixture.timeline.start);
  const timelineEndMs = parseMs(fixture.timeline.end);
  const clamped = Math.min(timelineEndMs, Math.max(timelineStartMs, simTimeMs));
  const span = Math.max(1, timelineEndMs - timelineStartMs);
  const fraction = fixture.meta.playback.investigation_fraction;
  const offsetCap = runMaxOffset(fixture.cases);

  const views: CaseView[] = [];
  for (const c of fixture.cases) {
    const v = caseView(c, clamped, fraction, offsetCap);
    if (v) views.push(v);
  }

  const masked = new Map<string, Case>();
  const cases: Case[] = [];
  for (const v of views) {
    const m = maskCase(v.case, v);
    // Surface presentation status via a transient field the table can read: when still
    // investigating, force verdict badge via a shallow override using undecomposed? Better:
    // keep real verdict_kind on masked case but CaseTable gets uiStatus separately.
    masked.set(v.case.case_id, m);
    cases.push(m);
  }

  const localizeById = new Map(views.map(v => [v.case.case_id, v.localizeDone]));
  // Markers come from the full fixture case list so the observation hour can appear
  // on the graph before the investigation unlocks the table row. simTime gates the hour;
  // caseViews gate localization callouts.
  const markers = markersFromCases(fixture.cases, fixture.series, {
    selectedCaseId,
    simTimeMs: clamped,
    localizeDone: c => localizeById.get(c.case_id) ?? false,
  });

  // Coverage gaps unlock once any case has passed detect (same run sweep).
  const detectPhaseDone = views.some(v =>
    hasRevealed(v.case.steps_flat, v.revealedStepIds, MS.detect) ||
    hasRevealed(v.case.steps_flat, v.revealedStepIds, MS.correct),
  );

  const spans = views.reduce((n, v) => n + v.revealedStepIds.size, 0);

  return {
    simTimeMs: clamped,
    timelineStartMs,
    timelineEndMs,
    progress01: (clamped - timelineStartMs) / span,
    visibleSeries: clipSeries(fixture.series, clamped),
    caseViews: views,
    cases,
    maskedCases: masked,
    graphMarkers: markers,
    coverageGaps: detectPhaseDone ? fixture.coverage.total_gaps : 0,
    spans,
    detectPhaseDone,
  };
}

/** Map booth wall-clock delta into data timeline advance at a given speed. */
export function advanceSimTime(
  fixture: TimeMachineFixture,
  simTimeMs: number,
  wallDeltaMs: number,
  speed: number,
): number {
  const start = parseMs(fixture.timeline.start);
  const end = parseMs(fixture.timeline.end);
  const dataSpan = Math.max(1, end - start);
  const booth = Math.max(1, fixture.meta.playback.booth_duration_ms_at_1x);
  const dataPerWall = (dataSpan / booth) * speed;
  return Math.min(end, Math.max(start, simTimeMs + wallDeltaMs * dataPerWall));
}

export function scrubToProgress(fixture: TimeMachineFixture, progress01: number): number {
  const start = parseMs(fixture.timeline.start);
  const end = parseMs(fixture.timeline.end);
  const p = Math.min(1, Math.max(0, progress01));
  return start + p * (end - start);
}
