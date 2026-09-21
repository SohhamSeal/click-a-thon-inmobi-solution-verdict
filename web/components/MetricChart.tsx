'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { axisValue, metricValue, pct, stamp, ticks } from '@/lib/format';
import type { GraphMarker } from '@/lib/anomalies';
import { parseMs } from '@/lib/anomalies';
import type { Direction, Metric, Series } from '@/lib/types';

const H_MIN = 132;
const PAD = { t: 8, r: 12, b: 28, l: 50 };

const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

/** Shared preview/selection target for graph ↔ table sync. */
export interface ChartFocus {
  case_id: string;
  metric: Metric | string;
  segment: string;
  relative_effect: number;
  direction: Direction;
  window_start: string;
  window_end: string;
  localizeDone: boolean;
}

export function MetricChart({
  series,
  markers,
  focus,
  hoverCaseId,
  selectedCaseId,
  onMarkerHover,
  onMarkerClick,
}: {
  series: Series[];
  markers?: GraphMarker[];
  /** Hover or selection — single source for metric tab, window, callout. */
  focus?: ChartFocus | null;
  hoverCaseId?: string | null;
  selectedCaseId?: string | null;
  onMarkerHover?: (caseId: string | null) => void;
  onMarkerClick?: (caseId: string) => void;
}) {
  const [which, setWhich] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1200);
  const [H, setH] = useState(H_MIN);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setW(Math.max(320, Math.round(e.contentRect.width)));
      setH(Math.max(H_MIN, Math.round(e.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Case focus owns the metric tab — not whichever series was last clicked manually.
  useEffect(() => {
    if (!focus || !series.length) return;
    const idx = series.findIndex(s => s.metric === focus.metric);
    if (idx >= 0) setWhich(idx);
  }, [focus?.case_id, focus?.metric, series]);

  const safeWhich = Math.min(which, Math.max(0, series.length - 1));
  const shape = series[safeWhich];
  const metric = (shape?.metric ?? 'ctr') as Metric;

  const { points, geo } = useMemo(() => {
    const points = shape?.points ?? [];
    if (!points.length) {
      return { points, geo: { x: () => PAD.l, y: () => H / 2, min: 0, max: 1 } };
    }
    const lo = Math.min(...points.map(p => Math.min(p.observed, p.lo)));
    const hi = Math.max(...points.map(p => Math.max(p.observed, p.hi)));
    const span = hi - lo || Math.abs(hi) || 1;
    const min = lo - span * 0.2;
    const max = hi + span * 0.12;
    const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * (w - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
    return { points, geo: { x, y, min, max } };
  }, [shape, w, H]);

  const metricMarkers = (markers ?? []).filter(m => m.metric === metric);
  const focusMarker = focus ? (markers ?? []).find(m => m.case_id === focus.case_id) : undefined;
  const previewing = Boolean(hoverCaseId);
  const tooltipMarker =
    previewing && focusMarker?.observation && focusMarker.case_id === hoverCaseId ? focusMarker : undefined;
  const hasSeriesForFocus = focus ? series.some(s => s.metric === focus.metric) : true;

  // Snap the series cursor to the parent observation while a case is previewed/selected.
  useEffect(() => {
    if (!focusMarker?.observation || !points.length) return;
    const i = points.findIndex(p => parseMs(p.t) === parseMs(focusMarker.observation!.t));
    if (i >= 0) setHover(i);
  }, [focusMarker?.case_id, focusMarker?.observation?.t, points]);

  if (!shape || !points.length) {
    return (
      <div className="panelbox chartbox">
        <div className="pbhead">
          <span className="hd">Parent series</span>
          <div className="seg" role="group" aria-label="Metric">
            {series.map((s, i) => (
              <button key={s.metric} className={i === which ? 'on' : ''} aria-pressed={i === which} onClick={() => setWhich(i)}>
                {s.metric}
              </button>
            ))}
          </div>
        </div>
        <div className="empty" style={{ padding: 24 }}>
          {focus && !hasSeriesForFocus
            ? `No parent series loaded for ${focus.metric}`
            : 'Waiting for series points…'}
        </div>
      </div>
    );
  }

  const obs = points.map((p, i) => ({ x: geo.x(i), y: geo.y(p.observed) }));
  const exp = points.map((p, i) => ({ x: geo.x(i), y: geo.y(p.expected) }));
  const bandTop = points.map((p, i) => ({ x: geo.x(i), y: geo.y(p.hi) }));
  const bandBottom = points.map((p, i) => ({ x: geo.x(i), y: geo.y(p.lo) })).reverse();
  const axis = ticks(geo.min, geo.max);

  const cursor = hover ?? points.length - 1;
  const at = points[cursor];
  const delta = at.expected !== 0 ? (at.observed - at.expected) / at.expected : 0;
  const baselineLabel = at.baseline_weeks_seen
    ? `${at.baseline_weeks_used}${
        at.baseline_weeks_used === at.baseline_weeks_seen ? '' : ` of ${at.baseline_weeks_seen}`
      } aligned baseline wk used`
    : 'no usable baseline';

  const t0 = parseMs(points[0].t);
  const t1 = parseMs(points[points.length - 1].t);
  const xAtTime = (iso: string) => {
    if (t1 <= t0) return PAD.l;
    const t = parseMs(iso);
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return PAD.l + u * (w - PAD.l - PAD.r);
  };
  const indexAt = (iso: string): number => points.findIndex(p => parseMs(p.t) === parseMs(iso));

  const guideObs =
    tooltipMarker?.observation ??
    (focusMarker?.observation && (hoverCaseId === focusMarker.case_id || selectedCaseId === focusMarker.case_id)
      ? focusMarker.observation
      : null);
  const guideX = guideObs ? xAtTime(guideObs.t) : null;

  // Only the focused case paints a window — stacking every case window washed the chart red.
  const windowFocus = focus && focus.metric === metric ? focus : null;

  return (
    <div className="panelbox chartbox">
      <div className="pbhead">
        <span className="hd">Parent series</span>
        <div className="seg" role="group" aria-label="Metric">
          {series.map((s, i) => (
            <button key={s.metric} className={i === which ? 'on' : ''} aria-pressed={i === which} onClick={() => setWhich(i)}>
              {s.metric}
            </button>
          ))}
        </div>
      </div>

      <div className="readout">
        <span className="mono dim2" style={{ fontSize: 11 }}>
          {stamp(at.t)}
        </span>
        <span className="big">{metricValue(metric, at.observed)}</span>
        <span className={`num ${delta < 0 ? 'fall' : delta > 0 ? 'rise' : ''}`}>{pct(delta)}</span>
        <span className="mono dim2 sp" style={{ fontSize: 11 }}>
          expected {metricValue(metric, at.expected)}
        </span>
        <span className="clegend">
          <span>
            <i style={{ borderColor: 'var(--acc)' }} /> observed
          </span>
          <span>
            <i style={{ borderColor: 'var(--tx3)', borderTopStyle: 'dashed' }} /> expected
          </span>
          <span>
            <i style={{ borderColor: 'var(--err)' }} /> parent anomaly observation
          </span>
          <span>
            <i style={{ borderColor: 'var(--tx3)', opacity: 0.35 }} /> {baselineLabel}
          </span>
        </span>
      </div>

      <div className="chartw" ref={box} style={{ position: 'relative' }}>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`}>
          {axis.values.map(v => (
            <g key={v}>
              <line className="gridline" x1={PAD.l} x2={w - PAD.r} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="axistx" x={PAD.l - 8} y={geo.y(v) + 3} textAnchor="end">
                {axisValue(metric, v, axis.step)}
              </text>
            </g>
          ))}

          {windowFocus && (
            <rect
              x={xAtTime(windowFocus.window_start)}
              y={PAD.t}
              width={Math.max(2, xAtTime(windowFocus.window_end) - xAtTime(windowFocus.window_start))}
              height={H - PAD.t - PAD.b}
              fill="rgba(232, 93, 111, 0.06)"
              stroke="rgba(232, 93, 111, 0.35)"
              strokeWidth={1}
              strokeDasharray="4 3"
              pointerEvents="none"
            />
          )}

          <path className="bandfill" d={`${path(bandTop)} ${path(bandBottom).replace('M', 'L')} Z`} />
          <path className="expline" d={path(exp)} />
          <path className="obsline" d={path(obs)} />

          {guideX != null && (
            <line
              x1={guideX}
              x2={guideX}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="var(--err)"
              strokeWidth={1.2}
              strokeDasharray="3 3"
              opacity={0.85}
              pointerEvents="none"
            />
          )}

          <line className="gridline" x1={obs[cursor].x} x2={obs[cursor].x} y1={PAD.t} y2={H - PAD.b} opacity={guideX != null ? 0.25 : 1} />
          <circle cx={obs[cursor].x} cy={obs[cursor].y} r={3} fill="var(--acc)" stroke="var(--bg)" strokeWidth={1.4} />

          {points.map((p, i) =>
            i % 8 === 0 ? (
              <text key={i} className="axistx" x={geo.x(i)} y={H - 6} textAnchor="middle">
                {p.t.slice(11, 16)}
              </text>
            ) : null,
          )}

          {points.map((_, i) => (
            <rect
              key={i}
              x={geo.x(i) - (w - PAD.l - PAD.r) / points.length / 2}
              y={PAD.t}
              width={(w - PAD.l - PAD.r) / points.length}
              height={H - PAD.t - PAD.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}

          {metricMarkers.map(m => {
            if (!m.observation) return null;
            const i = indexAt(m.observation.t);
            if (i < 0) return null;
            const lit = m.case_id === focus?.case_id;
            const cx = geo.x(i);
            const cy = geo.y(m.observation.observed);
            return (
              <g
                key={`dot-${m.case_id}`}
                style={{ cursor: 'pointer' }}
                onClick={e => {
                  e.stopPropagation();
                  onMarkerClick?.(m.case_id);
                }}
                onMouseEnter={() => {
                  setHover(i);
                  onMarkerHover?.(m.case_id);
                }}
                onMouseLeave={() => onMarkerHover?.(null)}
              >
                {lit && <circle cx={cx} cy={cy} r={12} fill="var(--err)" opacity={0.2} />}
                <circle cx={cx} cy={cy} r={lit ? 6 : 4.5} fill="var(--err)" stroke="var(--bg)" strokeWidth={1.8} />
                <circle cx={cx} cy={cy} r={16} fill="transparent" />
              </g>
            );
          })}
        </svg>

        {tooltipMarker?.observation && (
          <div
            className="anomtip"
            style={{
              left: Math.min(w - 220, Math.max(8, xAtTime(tooltipMarker.observation.t) - 90)),
            }}
          >
            <div className="anomtip-t">{stamp(tooltipMarker.observation.t)} UTC</div>
            <div className="anomtip-row">
              <span>Observed</span>
              <strong>{metricValue(metric, tooltipMarker.observation.observed)}</strong>
            </div>
            <div className="anomtip-row">
              <span>Expected</span>
              <strong>{metricValue(metric, tooltipMarker.observation.expected)}</strong>
            </div>
            <div className="anomtip-row">
              <span>Parent Δ</span>
              <strong className={tooltipMarker.observation.parent_effect < 0 ? 'fall' : 'rise'}>
                {pct(tooltipMarker.observation.parent_effect)}
              </strong>
            </div>
            <div className="anomtip-note">Parent-series observation — not investigation clock</div>
            {tooltipMarker.localizeDone && (
              <div className="anomtip-seg">
                {tooltipMarker.segment} · {pct(tooltipMarker.relative_effect)} segment
              </div>
            )}
          </div>
        )}
      </div>

      <div className="cfoot">
        {focusMarker?.observation && focus?.metric === metric ? (
          <>
            <span className="badge d">observation {stamp(focusMarker.observation.t)}</span>
            <span className="mono" style={{ fontSize: 11 }}>
              parent {pct(focusMarker.observation.parent_effect)}
              <span className="dim2">
                {' '}
                · {metricValue(metric, focusMarker.observation.observed)} vs{' '}
                {metricValue(metric, focusMarker.observation.expected)}
              </span>
            </span>
            {focus.localizeDone ? (
              <span className="mono" style={{ fontSize: 11 }}>
                <strong>{focus.segment}</strong>
                <span className={`num ${focus.direction}`} style={{ marginLeft: 8 }}>
                  {pct(focus.relative_effect)} segment
                </span>
              </span>
            ) : (
              <span className="mono dim2" style={{ fontSize: 11 }}>
                investigation timing follows recorded case_steps, not this hour
              </span>
            )}
          </>
        ) : focus && focus.metric === metric ? (
          <>
            <span className="badge q">investigation window</span>
            <span className="mono" style={{ fontSize: 11 }}>
              <strong>{focus.segment}</strong>
              {focus.localizeDone && (
                <span className={`num ${focus.direction}`} style={{ marginLeft: 8 }}>
                  {pct(focus.relative_effect)} segment
                </span>
              )}
            </span>
            <span className="mono dim2" style={{ fontSize: 11 }}>
              no out-of-band parent observation on this series
            </span>
          </>
        ) : (
          <span className="mono dim2" style={{ fontSize: 11 }}>
            {shape.label} · hover a case or anomaly marker
          </span>
        )}
      </div>
    </div>
  );
}
