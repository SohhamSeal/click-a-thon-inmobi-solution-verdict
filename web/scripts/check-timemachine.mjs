/** Deterministic smoke check for Time Machine derive. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/timemachine/jul05.json'), 'utf8'),
);

function parseMs(iso) {
  return Date.parse(iso);
}

function runCap(cases) {
  let m = 1;
  for (const c of cases) {
    for (const s of c.steps_flat) m = Math.max(m, s.offset_ms);
  }
  return m;
}

function progressInInvestigation(sim, start, end, fraction) {
  const span = Math.max(1, end - start);
  const investEnd = start + span * fraction;
  if (sim <= start) return 0;
  if (sim >= investEnd) return 1;
  return (sim - start) / (investEnd - start);
}

function revealed(steps, p01, cap) {
  const thr = p01 * cap;
  return new Set(steps.filter(s => s.offset_ms <= thr + 1e-9).map(s => s.step_id));
}

function has(steps, ids, pred) {
  return steps.some(s => pred(s.name) && ids.has(s.step_id));
}

function caseCountAt(progress01) {
  const start = parseMs(fixture.timeline.start);
  const end = parseMs(fixture.timeline.end);
  const sim = start + progress01 * (end - start);
  const fraction = fixture.meta.playback.investigation_fraction;
  const cap = runCap(fixture.cases);
  let n = 0;
  let localized = 0;
  for (const c of fixture.cases) {
    if (sim < parseMs(c.window_start)) continue;
    const p = progressInInvestigation(sim, parseMs(c.window_start), parseMs(c.window_end), fraction);
    const ids = revealed(c.steps_flat, p, cap);
    const sweep = has(
      c.steps_flat,
      ids,
      name => name === 'correct' || name === 'detect' || name.startsWith('temporal:') || name.startsWith('structural:'),
    );
    if (!sweep) continue;
    n++;
    if (has(c.steps_flat, ids, name => name.startsWith('localize:'))) localized++;
  }
  return { n, localized, cap };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(caseCountAt(0).n === 0, 'start empty');
const mid = caseCountAt(0.16);
assert(mid.n === 8, `mid cases ${mid.n}`);
const late = caseCountAt(0.22);
assert(late.localized > 0, `late localize ${late.localized}`);
assert(caseCountAt(0).n === 0, 'back to start');

// Parent anomaly for CTR must be a real series hour (fixture peak outside band at 02:00).
const ctr = fixture.series.find(s => s.metric === 'ctr');
const winLo = Date.parse(fixture.timeline.start);
const winHi = Date.parse(fixture.timeline.end);
const inWin = ctr.points.filter(p => {
  const t = Date.parse(p.t);
  return t >= winLo && t < winHi;
});
const outside = inWin.filter(p => p.observed < p.lo || p.observed > p.hi);
const peak = outside.sort(
  (a, b) =>
    Math.abs((b.observed - b.expected) / b.expected) - Math.abs((a.observed - a.expected) / a.expected),
)[0];
assert(peak && peak.t === '2026-07-05T02:00:00.000Z', `CTR peak hour ${peak?.t}`);

// Observation markers follow parent-series hours; case unlock is separate.
assert(caseCountAt(2 / 24).n === 0, 'cases still locked at 02:00 fraction');

// Per-case coverage must not be the run-level total on every row.
{
  const totals = [...new Set(fixture.cases.map(c => c.coverage_total))];
  assert(totals.length > 1, `expected varied per-case coverage, got ${totals}`);
  assert(!totals.every(t => t === fixture.coverage.total_gaps), 'per-case gaps collapsed to run total');
}

console.log('timemachine smoke OK', {
  cases: fixture.cases.length,
  steps: fixture.spans,
  mid,
  late,
  ctr_parent_anomaly: peak.t,
  coverage_totals: [...new Set(fixture.cases.map(c => c.coverage_total))],
  booth_ms: fixture.meta.playback.booth_duration_ms_at_1x,
});
