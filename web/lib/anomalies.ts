/** Shared parent-series anomaly markers for Live and Time Machine. */

import type { Case, Direction, Metric, Series } from '@/lib/types';

export interface AnomalyObservation {
  t: string;
  observed: number;
  expected: number;
  lo: number;
  hi: number;
  /** (observed - expected) / expected on the parent series — not the segment effect. */
  parent_effect: number;
}

export interface GraphMarker {
  case_id: string;
  metric: Metric | string;
  segment: string;
  /** Segment relative effect from the case — shown after localization when known. */
  relative_effect: number;
  direction: Direction;
  window_start: string;
  window_end: string;
  active: boolean;
  localizeDone: boolean;
  /**
   * Real parent-series observation inside the case window.
   * This is an anomalous observation on `__all__`, not the investigation detection clock.
   */
  observation: AnomalyObservation | null;
}

export function parseMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** Prefer the hour farthest outside the expected band; else largest |relative| in-window. */
export function findParentAnomaly(
  seriesList: Series[],
  metric: string,
  windowStart: string,
  windowEnd: string,
): AnomalyObservation | null {
  const series = seriesList.find(s => s.metric === metric);
  if (!series?.points.length) return null;

  const lo = parseMs(windowStart);
  const hi = parseMs(windowEnd);
  const inWindow = series.points.filter(p => {
    const t = parseMs(p.t);
    return t >= lo && t < hi;
  });
  if (!inWindow.length) return null;

  const score = (p: (typeof inWindow)[0]) => {
    const effect = p.expected !== 0 ? (p.observed - p.expected) / p.expected : 0;
    const outside = p.observed < p.lo || p.observed > p.hi;
    return { effect, outside, abs: Math.abs(effect) };
  };

  const outside = inWindow.filter(p => score(p).outside);
  const pool = outside.length ? outside : inWindow;
  let best = pool[0];
  let bestAbs = score(best).abs;
  for (const p of pool.slice(1)) {
    const s = score(p);
    if (s.abs > bestAbs) {
      best = p;
      bestAbs = s.abs;
    }
  }

  const parent_effect = best.expected !== 0 ? (best.observed - best.expected) / best.expected : 0;
  return {
    t: best.t,
    observed: best.observed,
    expected: best.expected,
    lo: best.lo,
    hi: best.hi,
    parent_effect,
  };
}

/** Build markers for a set of cases against parent series. Used by Live and Time Machine. */
export function markersFromCases(
  cases: Case[],
  series: Series[],
  opts?: {
    selectedCaseId?: string | null;
    localizeDone?: (c: Case) => boolean;
    /** When set, only include markers whose observation hour has arrived. */
    simTimeMs?: number | null;
  },
): GraphMarker[] {
  const selected = opts?.selectedCaseId ?? null;
  const sim = opts?.simTimeMs;
  const out: GraphMarker[] = [];

  for (const c of cases) {
    const observation = findParentAnomaly(series, c.metric, c.window_start, c.window_end);
    if (!observation) continue;
    if (sim != null && parseMs(observation.t) > sim) continue;

    out.push({
      case_id: c.case_id,
      metric: c.metric,
      segment: c.segment,
      relative_effect: c.relative_effect,
      direction: c.direction,
      window_start: c.window_start,
      window_end: c.window_end,
      active: c.case_id === selected,
      localizeDone: opts?.localizeDone ? opts.localizeDone(c) : true,
      observation,
    });
  }
  return out;
}
