'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CasePanel } from './CasePanel';
import { CaseTable, type Sort } from './CaseTable';
import { IngestPanel } from './IngestPanel';
import { MetricChart } from './MetricChart';
import { SearchIcon } from './icons';
import { TimeMachineBar } from './TimeMachineBar';
import { TopBar } from './TopBar';
import { markersFromCases } from '@/lib/anomalies';
import { KINDS, kpiOf } from '@/lib/data';
import { KIND_FILL, KIND_LABEL, money, priority } from '@/lib/format';
import { boothFixture, useReplay } from '@/lib/timemachine';
import type { Case, RecommendationSet, Run, Series, VerdictKind } from '@/lib/types';

type Mode = 'live' | 'timemachine';

/** Unpriced cases sort last within their bucket rather than as zero. A case nobody could
 *  convert to revenue is of unknown size, and sorting it among the genuinely small ones
 *  hides it exactly where a reader has stopped looking. */
const byRevenue = (a: Case, b: Case) => {
  const x = a.impact_json.revenue;
  const y = b.impact_json.revenue;
  if (x == null && y == null) return b.confidence - a.confidence;
  if (x == null) return 1;
  if (y == null) return -1;
  return x - y;
};

const SORTERS: Record<Sort, (a: Case, b: Case) => number> = {
  priority: (a, b) =>
    priority(a.impact_json.revenue, a.confidence) - priority(b.impact_json.revenue, b.confidence) || byRevenue(a, b),
  effect: (a, b) => Math.abs(b.relative_effect) - Math.abs(a.relative_effect),
  confidence: (a, b) => b.confidence - a.confidence,
  impact: byRevenue,
};

interface Props {
  run: Run | null;
  runs: Run[];
  cases: Case[];
  series: Series[];
  spans: number;
  coverageGaps: number;
  recommendationsEnabled: boolean;
  /** Max concurrent case recommendation jobs when the AI toggle is on (default 8). */
  recommendParallelism?: number;
  ingestEnabled: boolean;
  empty: boolean;
}

/** Shown only when the database answered successfully but has no cases. Failed reads throw
 *  into the route error boundary, so they can never render as a clean empty run. */
function Empty({ runs, coverageGaps }: { runs: Run[]; coverageGaps: number }) {
  return (
    <div className="wrap">
      <div className="panelbox" style={{ padding: 28 }}>
        <div className="hd" style={{ marginBottom: 10 }}>
          No cases to show
        </div>
        <p className="dim" style={{ maxWidth: 620, lineHeight: 1.6, margin: '0 0 14px' }}>
          {runs.length
            ? 'The most recent runs completed without publishing a case. Either the windows were quiet, or the sweep has not been pointed at a window containing an incident.'
            : 'No runs have been recorded yet. The console reads what the engine writes, so it stays empty until an investigation has been persisted.'}
        </p>
        {coverageGaps > 0 && (
          <p className="dim" style={{ maxWidth: 620, lineHeight: 1.6, margin: '0 0 14px' }}>
            The selected run also recorded {coverageGaps.toLocaleString()} cells it could not
            test. No case is required for a coverage gap to exist.
          </p>
        )}
        <div className="sql">verdict investigate --start 2026-06-23T00:00:00 --hours 48</div>
      </div>
    </div>
  );
}

/** Priority is not a stored column. It is impact ranked by confidence, bucketed, so the
 *  filter has to describe what the buckets mean -- "P0" is otherwise just a colour. */
const PRIORITIES = [0, 1, 2, 3] as const;

const PRI_HINT: Record<number, string> = {
  0: 'Large impact and high confidence. Look at these first.',
  1: 'Material impact, or a large one held back by a weaker verdict.',
  2: 'Small but proven, or large and speculative.',
  3: 'Marginal on both counts. Kept so the ledger is complete.',
};

const PRI_FILL = ['var(--err)', 'var(--warn)', 'var(--tx2)', 'var(--line2)'];

const AI_HINT =
  'Off by default. When on, each case gains an Actions tab: one model drafts remediations from ' +
  'the case evidence, then a second reviews the draft independently and deletes anything the ' +
  'evidence does not support. Proposals, not findings — nothing here is verified against the ' +
  'numbers the way the narrative is.';

const KIND_HINT: Record<VerdictKind, string> = {
  localized: 'A segment was named and removing it returned the parent to its expected band.',
  unlocalized: 'The movement is real but no segment explains it — the signature of a change upstream of the auction.',
  undecomposed: 'A segment was named but failed its breadth checks. A lead, not a verdict.',
  no_data: 'Too little traffic to decompose. Published so it is not silently dropped.',
};

export function Console({
  run,
  runs,
  cases: liveCases,
  series: liveSeries,
  spans: liveSpans,
  coverageGaps: liveCoverageGaps,
  recommendationsEnabled,
  recommendParallelism = 8,
  ingestEnabled,
  empty: liveEmpty,
}: Props) {
  const [mode, setMode] = useState<Mode>('live');
  const replay = useReplay(boothFixture);
  const tm = mode === 'timemachine';

  const cases = tm ? replay.derived.cases : liveCases;
  const series = tm ? replay.derived.visibleSeries : liveSeries;
  const spans = tm ? replay.derived.spans : liveSpans;
  const coverageGaps = tm ? replay.derived.coverageGaps : liveCoverageGaps;
  const empty = tm ? false : liveEmpty;
  const activeRun = tm ? boothFixture.run : run;

  const uiStatusById = useMemo(() => {
    if (!tm) return undefined;
    const m = new Map<string, 'investigating' | 'verdict'>();
    for (const v of replay.derived.caseViews) m.set(v.case.case_id, v.uiStatus);
    return m;
  }, [tm, replay.derived.caseViews]);

  const [kind, setKind] = useState<VerdictKind | null>(null);
  const [pri, setPri] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('priority');
  const [openId, setOpenId] = useState<string | null>(null);
  const [hoverCaseId, setHoverCaseId] = useState<string | null>(null);
  const pushed = useRef(false);

  const kpi = useMemo(() => kpiOf(cases, spans, coverageGaps), [cases, spans, coverageGaps]);

  const graphMarkers = useMemo(() => {
    if (tm) return replay.derived.graphMarkers;
    return markersFromCases(liveCases, liveSeries, { selectedCaseId: openId });
  }, [tm, replay.derived.graphMarkers, liveCases, liveSeries, openId]);

  const focusId = hoverCaseId || openId;
  const chartFocus = useMemo(() => {
    if (!focusId) return null;
    const c = cases.find(x => x.case_id === focusId);
    if (!c) return null;
    const view = tm ? replay.derived.caseViews.find(v => v.case.case_id === c.case_id) : undefined;
    return {
      case_id: c.case_id,
      metric: c.metric,
      segment: c.segment,
      relative_effect: c.relative_effect,
      direction: c.direction,
      window_start: c.window_start,
      window_end: c.window_end,
      localizeDone: tm ? Boolean(view?.localizeDone) : true,
    };
  }, [focusId, cases, tm, replay.derived.caseViews]);

  const replayCards = useMemo(() => {
    if (!tm) return null;
    const anomalies = replay.derived.graphMarkers.filter(m => m.observation).length;
    const investigating = replay.derived.caseViews.filter(v => v.uiStatus === 'investigating').length;
    const localized = replay.derived.caseViews.filter(
      v => v.localizeDone && v.case.verdict_kind === 'localized',
    ).length;
    const verdicts = replay.derived.caseViews.filter(v => v.uiStatus === 'verdict').length;
    return { anomalies, cases: kpi.cases, investigating, localized, verdicts };
  }, [tm, replay.derived.graphMarkers, replay.derived.caseViews, kpi.cases]);

  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1);
      const id = h ? (cases.find(c => c.case_id.startsWith(h))?.case_id ?? null) : null;
      setOpenId(id);
      if (tm) replay.selectCase(id);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [cases, tm]);

  const open = (id: string) => {
    if (!cases.some(c => c.case_id === id)) return;
    pushed.current = true;
    window.location.hash = id.slice(0, 12);
    if (tm) replay.selectCase(id);
  };
  const close = () => {
    if (tm) replay.selectCase(null);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, '', window.location.pathname);
      setOpenId(null);
    }
  };

  const enterTimeMachine = () => {
    if (mode === 'timemachine') return;
    setMode('timemachine');
    replay.reset();
    setKind(null);
    setPri(null);
    setQuery('');
    setOpenId(null);
    setHoverCaseId(null);
    window.history.replaceState(null, '', window.location.pathname);
  };
  const enterLive = () => {
    if (mode === 'live') return;
    setMode('live');
    replay.pause();
    setOpenId(null);
    setHoverCaseId(null);
    window.history.replaceState(null, '', window.location.pathname);
  };

  const [recsOn, setRecsOn] = useState(false);
  const [recs, setRecs] = useState<Map<string, RecommendationSet>>(new Map());
  const [generating, setGenerating] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(0);
  /** When a wave ends while the toggle is still on, bump so leftovers can resume once. */
  const [batchNonce, setBatchNonce] = useState(0);
  const inFlight = useRef(new Set<string>());
  const batchRunId = useRef<string | null>(null);
  const lastRunId = useRef<string | null>(null);
  const recsOnRef = useRef(recsOn);
  recsOnRef.current = recsOn;

  const store = (set: RecommendationSet) => setRecs(prev => new Map(prev).set(set.case_id, set));

  const setBusy = (caseId: string, on: boolean) => {
    setGenerating(prev => {
      const next = new Set(prev);
      if (on) next.add(caseId);
      else next.delete(caseId);
      return next;
    });
  };

  async function generateFor(caseId: string, force: boolean) {
    if (!recommendationsEnabled || !activeRun) return;
    if (!force && inFlight.current.has(caseId)) return;
    if (!force) {
      const existing = recs.get(caseId);
      if (existing?.status === 'completed') return;
    }

    inFlight.current.add(caseId);
    setBusy(caseId, true);
    try {
      const res = await fetch('/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run: activeRun.run_id, case_id: caseId, force }),
      });
      let body: { set?: RecommendationSet; error?: string; cached?: boolean } = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (body.set) {
        store(body.set);
        return;
      }
      const message =
        body.error ||
        (!res.ok
          ? `Recommendation request failed (${res.status})`
          : 'Recommendation service returned no result');
      store({
        case_id: caseId,
        generated_at: new Date().toISOString(),
        status: 'failed',
        summary: '',
        drafted: 0,
        recommendations: [],
        generation_model: '',
        validation_model: '',
        job_id: '',
        error: message,
      });
    } catch (err) {
      store({
        case_id: caseId,
        generated_at: new Date().toISOString(),
        status: 'failed',
        summary: '',
        drafted: 0,
        recommendations: [],
        generation_model: '',
        validation_model: '',
        job_id: '',
        error: (err as Error).message || 'Network error while generating advice',
      });
    } finally {
      inFlight.current.delete(caseId);
      setBusy(caseId, false);
    }
  }

  const runId = activeRun?.run_id ?? null;

  useEffect(() => {
    if (!recommendationsEnabled || !recsOn || !runId) return;

    if (lastRunId.current !== runId) {
      lastRunId.current = runId;
      batchRunId.current = null;
    }

    // Toggle off/on mid-flight must not start a second wave for the same run.
    if (batchRunId.current === runId) return;
    batchRunId.current = runId;

    let cancelled = false;
    const limit = Math.max(1, Math.min(32, Math.floor(recommendParallelism) || 8));

    (async () => {
      let missing: string[] = [];
      try {
        const res = await fetch(`/api/recommendations?run=${encodeURIComponent(runId)}`);
        const body = (await res.json()) as {
          sets?: Record<string, RecommendationSet>;
          missing?: string[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          console.warn('recommendations GET failed', body.error || res.status);
          return;
        }
        if (body.sets) setRecs(new Map(Object.entries(body.sets)));
        missing = (body.missing ?? []).filter(id => !inFlight.current.has(id));
      } catch (err) {
        console.warn('recommendations GET failed', err);
        return;
      }

      setPending(missing.length);
      if (!missing.length) {
        if (batchRunId.current === runId) batchRunId.current = null;
        return;
      }

      let next = 0;
      const worker = async () => {
        while (!cancelled) {
          const i = next++;
          if (i >= missing.length) return;
          await generateFor(missing[i], false);
          if (cancelled) return;
          setPending(n => Math.max(0, n - 1));
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(limit, missing.length) }, () => worker()));
      } finally {
        if (batchRunId.current === runId) batchRunId.current = null;
        if (!cancelled) setPending(0);
        // Resume leftovers if the toggle is still on (e.g. after a mid-run abort released ownership).
        if (recsOnRef.current) setBatchNonce(n => n + 1);
      }
    })();

    return () => {
      cancelled = true;
      setPending(0);
    };
  }, [recommendationsEnabled, recsOn, runId, recommendParallelism, batchNonce]);

  const recsReady = useMemo(
    () => [...recs.values()].filter(s => s.status === 'completed').length,
    [recs],
  );

  const byPri = useMemo(() => {
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const c of cases) counts[priority(c.impact_json.revenue, c.confidence)]++;
    return counts;
  }, [cases]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cases
      .filter(
        c =>
          (!kind || c.verdict_kind === kind) &&
          (pri === null || priority(c.impact_json.revenue, c.confidence) === pri) &&
          (!q || `${c.metric} ${c.segment}`.toLowerCase().includes(q)),
      )
      .sort(SORTERS[sort]);
  }, [cases, kind, pri, query, sort]);

  const openCase = openId ? cases.find(c => c.case_id === openId) : null;
  const openUiStatus = openId && uiStatusById ? uiStatusById.get(openId) : undefined;
  const window0 = cases[0];

  useEffect(() => {
    if (hoverCaseId && !cases.some(c => c.case_id === hoverCaseId)) setHoverCaseId(null);
  }, [hoverCaseId, cases]);

  return (
    <div className="app">
      <TopBar mode={mode} onModeLive={enterLive} onModeTimeMachine={enterTimeMachine} />
      <div className="body">
        <div className="scroll">
          {empty ? (
            <Empty runs={runs} coverageGaps={coverageGaps} />
          ) : (
            <div className="wrap">
              {tm && <TimeMachineBar label={boothFixture.meta.label} replay={replay} />}

              <div className="kpis">
                {tm && replayCards ? (
                  <>
                    <div
                      className="kpi"
                      title="Parent-series observations revealed so far — anomalous hours on __all__, not investigation clock"
                    >
                      <span className="hd">Anomalies</span>
                      <span className="v">{replayCards.anomalies}</span>
                      <span className="def">parent-series observations</span>
                    </div>
                    <div className="kpi" title="Cases unlocked by recorded detect/correct steps at this simTime">
                      <span className="hd">Investigations</span>
                      <span className="v">{replayCards.cases}</span>
                      <span className="def">
                        {replayCards.investigating > 0
                          ? `${replayCards.investigating} still investigating`
                          : 'cases in this window'}
                      </span>
                    </div>
                    <div className="kpi" title="Cases whose localize step has revealed and whose stored verdict is localized">
                      <span className="hd">Localized</span>
                      <span className="v">{replayCards.localized}</span>
                      <span className="def">segment named · removal held</span>
                    </div>
                    <div className="kpi" title="Cases past localization — verdict badge shown in the table">
                      <span className="hd">Verdicts</span>
                      <span className="v">{replayCards.verdicts}</span>
                      <span className="split" title={KINDS.map(k => `${kpi.byKind[k]} ${KIND_LABEL[k]}`).join(' · ')}>
                        {KINDS.map(k => (
                          <i
                            key={k}
                            style={{
                              width: `${(kpi.byKind[k] / Math.max(1, kpi.cases)) * 100}%`,
                              background: KIND_FILL[k],
                            }}
                          />
                        ))}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="kpi">
                      <span className="hd">Open cases</span>
                      <span className="v">{kpi.cases}</span>
                      <span className="split" title={KINDS.map(k => `${kpi.byKind[k]} ${KIND_LABEL[k]}`).join(' · ')}>
                        {KINDS.map(k => (
                          <i key={k} style={{ width: `${(kpi.byKind[k] / Math.max(1, kpi.cases)) * 100}%`, background: KIND_FILL[k] }} />
                        ))}
                      </span>
                    </div>

                    <div
                      className="kpi"
                      title={
                        kpi.unpriced
                          ? `Losses only, never netted against recoveries. ${kpi.unpriced} of ${kpi.cases} cases measure a count that could not be converted to revenue and are excluded, so this is a floor.`
                          : 'Losses only, never netted against recoveries: a quiet total would hide an hour in which one thing broke and another improved.'
                      }
                    >
                      <span className="hd">Revenue at risk</span>
                      <span className="v fall">{money(kpi.revenueAtRisk)}</span>
                      <span className="def">
                        losses only · not netted
                        {kpi.unpriced > 0 && <span style={{ color: 'var(--warn)' }}> · {kpi.unpriced} unpriced</span>}
                      </span>
                    </div>

                    <div className="kpi">
                      <span className="hd">Mean confidence</span>
                      <span className="v">{kpi.meanConfidence.toFixed(2)}</span>
                      <span className="def">
                        {kpi.published} / {kpi.cases} engine-publishable
                      </span>
                    </div>

                    <div className="kpi">
                      <span className="hd">Coverage gaps</span>
                      <span className="v">{kpi.coverageGaps.toLocaleString()}</span>
                      <span className="def">all untestable cells in this run</span>
                    </div>
                  </>
                )}
              </div>

              {series.length > 0 && (
                <MetricChart
                  series={series}
                  markers={graphMarkers}
                  focus={chartFocus}
                  selectedCaseId={openId}
                  hoverCaseId={hoverCaseId}
                  onMarkerHover={setHoverCaseId}
                  onMarkerClick={open}
                />
              )}

              <div className="strip">
                <div className="fchips" role="group" aria-label="Filter by priority">
                  <button
                    className={`fchip${pri === null ? ' on' : ''}`}
                    aria-pressed={pri === null}
                    onClick={() => setPri(null)}
                    title="Every priority"
                  >
                    All <span className="n">{kpi.cases}</span>
                  </button>
                  {PRIORITIES.filter(p => byPri[p] > 0).map(p => (
                    <button
                      key={p}
                      className={`fchip pchip${pri === p ? ' on' : ''}`}
                      aria-pressed={pri === p}
                      onClick={() => setPri(pri === p ? null : p)}
                      title={PRI_HINT[p]}
                    >
                      <span className="dot" style={{ background: PRI_FILL[p] }} />P{p} <span className="n">{byPri[p]}</span>
                    </button>
                  ))}
                </div>

                <div className="fchips" role="group" aria-label="Filter by verdict" style={{ marginLeft: 4 }}>
                  {KINDS.filter(k => kpi.byKind[k] > 0).map(k => (
                    <button
                      key={k}
                      className={`fchip${kind === k ? ' on' : ''}`}
                      aria-pressed={kind === k}
                      onClick={() => setKind(kind === k ? null : k)}
                      title={KIND_HINT[k]}
                    >
                      <span className="sw" style={{ background: KIND_FILL[k] }} />
                      {KIND_LABEL[k]} <span className="n">{kpi.byKind[k]}</span>
                    </button>
                  ))}
                </div>

                <div className="push" />

                {recommendationsEnabled && (
                  <label className="aitog" title={AI_HINT}>
                    <input
                      type="checkbox"
                      checked={recsOn}
                      onChange={e => setRecsOn(e.target.checked)}
                      aria-label="AI recommendations"
                    />
                    <span className="track">
                      <span className="knob" />
                    </span>
                    <span className="lbl">
                      AI Recommendations
                      {recsOn && pending > 0 && (
                        <span className="n busy" title={`${pending} case(s) still to generate`}>
                          <span className="spin xs" />
                          {pending}
                        </span>
                      )}
                      {recsOn && pending === 0 && recsReady > 0 && <span className="n">{recsReady}</span>}
                    </span>
                  </label>
                )}

                {ingestEnabled && !tm && <IngestPanel />}

                <div className="row" style={{ gap: 6, width: 232 }}>
                  <span className="dim2" style={{ display: 'inline-flex' }}>
                    <SearchIcon />
                  </span>
                  <input
                    className="inp"
                    placeholder="filter metric or segment…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    aria-label="Filter cases"
                  />
                </div>
              </div>

              <CaseTable
                cases={rows}
                openId={openId}
                highlightId={hoverCaseId}
                sort={sort}
                onSort={setSort}
                onOpen={open}
                onHover={setHoverCaseId}
                uiStatusById={uiStatusById}
              />
            </div>
          )}
        </div>
      </div>

      <div className="status">
        <span>{activeRun ? activeRun.run_id.slice(0, 8) : 'no run'}</span>
        {tm && <span>recorded replay</span>}
        <span title="Temporal segment-and-metric tests; structural sibling-grid tests are separate">
          {kpi.cellsTested.toLocaleString()} temporal tests
        </span>
        {activeRun && activeRun.duration_ms > 0 && (
          <span title="Wall clock for the whole run: detection, localization and persistence">
            {activeRun.duration_ms < 1000
              ? `${activeRun.duration_ms} ms`
              : `${(activeRun.duration_ms / 1000).toFixed(1)}s`}
          </span>
        )}
        <span>{kpi.spans.toLocaleString()} spans</span>
        <span>{kpi.llmVerified} narratives verified</span>
        <span>
          {rows.length} of {kpi.cases} shown
        </span>
        <span className="sp">{activeRun ? `${activeRun.finished_at.slice(11, 16)} UTC` : ''}</span>
      </div>

      {openCase && (
        <CasePanel
          key={openCase.case_id}
          c={openCase}
          onClose={close}
          recommendations={recs.get(openCase.case_id) ?? null}
          recsEnabled={recommendationsEnabled && recsOn}
          recsBusy={generating.has(openCase.case_id)}
          onGenerate={force => generateFor(openCase.case_id, force)}
          uiStatus={openUiStatus}
          series={series}
        />
      )}
    </div>
  );
}
