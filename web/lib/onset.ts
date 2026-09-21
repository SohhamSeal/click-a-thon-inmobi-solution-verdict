/** Historical segment onset — sustained deviation, not parent peak. */

import type { Direction, Grain, VerdictKind } from '@/lib/types';

export type OnsetStatus = 'determined' | 'weak' | 'undetermined';

export interface OnsetHour {
  t: string;
  observed: number;
  expected: number;
  lo: number;
  hi: number;
  flagged: boolean;
}

export interface OnsetResult {
  status: OnsetStatus;
  /** ISO timestamp of onset hour when determined/weak; null if undetermined. */
  at: string | null;
  k: number;
  grain: Grain;
  hours: OnsetHour[];
}

export interface TimingDisplay {
  /** Primary onset line value (after the "Onset" label). */
  onsetValue: string;
  /** Secondary detail under not-established; omit when null. */
  onsetDetail: string | null;
  /** weak qualifier on the primary line. */
  weak: boolean;
  /** established vs not — drives strip chrome. */
  established: boolean;
  /** Peak parent observation clock HH:MM, if any. */
  peakStamp: string | null;
}

/** Persistence at 1h grain: two consecutive directed band outs. */
export function persistenceK(grain: Grain): number {
  switch (grain) {
    case '5m':
      return 3;
    case '1h':
      return 2;
    case '1d':
      return 2;
    default: {
      const _exhaustive: never = grain;
      return _exhaustive;
    }
  }
}

function directedFlag(
  observed: number,
  lo: number,
  hi: number,
  direction: Direction,
): boolean {
  switch (direction) {
    case 'rise':
      return observed > hi;
    case 'fall':
      return observed < lo;
    case 'flat':
      return observed < lo || observed > hi;
    default: {
      const _exhaustive: never = direction;
      return _exhaustive;
    }
  }
}

/** Pure onset from hourly (or grain) points that already carry expected/lo/hi. */
export function computeOnset(
  points: Array<{ t: string; observed: number; expected: number; lo: number; hi: number }>,
  direction: Direction,
  grain: Grain,
): OnsetResult {
  const k = persistenceK(grain);
  const hours: OnsetHour[] = points.map(p => ({
    t: p.t,
    observed: p.observed,
    expected: p.expected,
    lo: p.lo,
    hi: p.hi,
    flagged: directedFlag(p.observed, p.lo, p.hi, direction),
  }));

  if (hours.length < k) {
    return { status: 'undetermined', at: null, k, grain, hours };
  }

  // Earliest run of length ≥ k — onset is the start of the break, not the peak hour.
  let onsetIdx = -1;
  for (let j = 0; j <= hours.length - k; j++) {
    if (hours.slice(j, j + k).every(h => h.flagged)) {
      onsetIdx = j;
      break;
    }
  }

  if (onsetIdx < 0) {
    return { status: 'undetermined', at: null, k, grain, hours };
  }

  const runLen = (() => {
    let n = 0;
    for (let j = onsetIdx; j < hours.length && hours[j].flagged; j++) n += 1;
    return n;
  })();

  const status: OnsetStatus = runLen > k ? 'determined' : 'weak';
  return {
    status,
    at: hours[onsetIdx].t,
    k,
    grain,
    hours,
  };
}

function stamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

/**
 * Promote onset into the Timing strip.
 * No confidence gate. Unlocalized never shows a timestamp.
 */
export function timingDisplay(
  verdictKind: VerdictKind,
  onset: OnsetResult | null,
  peakIso: string | null,
): TimingDisplay {
  const peakStamp = stamp(peakIso);
  const promote = verdictKind === 'localized' && onset && onset.status !== 'undetermined' && onset.at;

  if (promote && onset) {
    const hh = stamp(onset.at) ?? '—';
    return {
      onsetValue: `≈ ${hh}`,
      onsetDetail: null,
      weak: onset.status === 'weak',
      established: true,
      peakStamp,
    };
  }

  return {
    onsetValue: 'not established',
    onsetDetail: 'No sustained segment deviation found',
    weak: false,
    established: false,
    peakStamp: verdictKind === 'localized' ? peakStamp : peakStamp,
  };
}
