/** Time Machine fixture + derived replay view types. */

import type { GraphMarker } from '@/lib/anomalies';
import type { Case, CoverageGap, Run, Series } from '@/lib/types';

export type { GraphMarker } from '@/lib/anomalies';

export type ReplaySpeed = 1 | 2 | 5 | 10;

export type UiCaseStatus = 'investigating' | 'verdict';

export interface PlaybackConfig {
  booth_duration_ms_at_1x: number;
  investigation_fraction: number;
}

export interface FixtureMeta {
  id: string;
  label: string;
  honesty: 'recorded_replay';
  source: {
    run_id: string;
    exported_at: string;
    clickhouse_database: string;
  };
  playback: PlaybackConfig;
}

export interface StepRow {
  step_id: string;
  parent_id: string;
  ordinal: number;
  name: string;
  kind: string;
  what: string;
  why: string;
  result: string;
  sql: string;
  duration_ms: number;
  offset_ms: number;
  span_id: string;
}

export interface ReplayCase extends Case {
  steps_flat: StepRow[];
}

export interface TimeMachineFixture {
  meta: FixtureMeta;
  timeline: { start: string; end: string };
  run: Run;
  series: Series[];
  coverage: { total_gaps: number; gaps: CoverageGap[] };
  spans: number;
  cases: ReplayCase[];
}

export interface CaseView {
  case: ReplayCase;
  uiStatus: UiCaseStatus;
  revealedStepIds: Set<string>;
  localizeDone: boolean;
  confidenceDone: boolean;
  narrativeDone: boolean;
  evidenceUnlocked: boolean;
}

export interface DerivedReplay {
  simTimeMs: number;
  timelineStartMs: number;
  timelineEndMs: number;
  progress01: number;
  visibleSeries: Series[];
  caseViews: CaseView[];
  cases: Case[];
  maskedCases: Map<string, Case>;
  graphMarkers: GraphMarker[];
  coverageGaps: number;
  spans: number;
  detectPhaseDone: boolean;
}
