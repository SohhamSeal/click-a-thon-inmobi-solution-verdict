#!/usr/bin/env python3
"""Export a Time Machine fixture from a completed ClickHouse investigation run.

Writes the same shapes the Live console already reads: run, cases, candidates,
case_steps trees, coverage, and parent-series points. Playback never queries
ClickHouse again — the JSON is the booth source of truth.
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


def _client():
    import clickhouse_connect

    secure = os.environ.get("CLICKHOUSE_SECURE", "true").lower() == "true"
    port = int(os.environ.get("CLICKHOUSE_PORT") or (8443 if secure else 8123))
    return clickhouse_connect.get_client(
        host=os.environ["CLICKHOUSE_HOST"],
        port=port,
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        database=os.environ.get("CLICKHOUSE_DATABASE", "default"),
        secure=secure,
    )


def _parse_utc(value) -> datetime:
    """Parse CH wall-clock values as UTC (avoid client-local naive datetimes)."""
    if value is None:
        raise ValueError("missing datetime")
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    text = str(value).strip().replace("T", " ").replace("Z", "")
    if "." in text:
        text = text.split(".", 1)[0]
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def _iso(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str) and value.endswith("Z") and "T" in value:
        return value if value.endswith(".000Z") else value.replace("Z", ".000Z") if "." not in value else value
    return _parse_utc(value).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _num(value, default=0.0):
    try:
        n = float(value)
        return default if math.isnan(n) or math.isinf(n) else n
    except (TypeError, ValueError):
        return default


FORMULA = {
    "requests": ("requests", None, 1.0),
    "fills": ("fills", None, 1.0),
    "fill_rate": ("fills", "requests", 1.0),
    "impressions": ("impressions", None, 1.0),
    "render_rate": ("impressions", "fills", 1.0),
    "clicks": ("clicks", None, 1.0),
    "ctr": ("clicks", "impressions", 1.0),
    "revenue": ("revenue", None, 1.0),
    "ecpm": ("revenue", "impressions", 1000.0),
    "rpr": ("revenue", "requests", 1.0),
}

CHART_METRICS = ["fill_rate", "revenue", "ecpm", "ctr", "requests", "render_rate"]
# Count metrics appear as cases; export their parent series so graph ↔ case sync can switch tabs.
CASE_SERIES_EXTRAS = ["clicks", "impressions", "fills"]
LABEL = {
    "requests": "Requests / hour",
    "fills": "Fills / hour",
    "fill_rate": "Fill rate",
    "impressions": "Impressions / hour",
    "render_rate": "Render rate",
    "clicks": "Clicks / hour",
    "ctr": "CTR",
    "revenue": "Revenue / hour",
    "ecpm": "eCPM",
    "rpr": "Revenue per request",
}


def _value(metric: str, row: dict) -> float | None:
    num_col, den_col, scale = FORMULA[metric]
    numerator = _num(row[num_col])
    if den_col is None:
        return numerator
    denominator = _num(row[den_col])
    if denominator <= 0:
        return None
    return (numerator / denominator) * scale


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def _series_for(client, metric: str, start: datetime, end: datetime, weeks: int = 4) -> dict:
    from datetime import timedelta

    fetch_from = start - timedelta(weeks=weeks)
    rows = client.query(
        """
        SELECT bucket,
               sum(requests) AS requests, sum(fills) AS fills,
               sum(impressions) AS impressions, sum(clicks) AS clicks,
               sum(revenue) AS revenue
        FROM rollup_1h
        WHERE combo = '__all__'
          AND bucket >= {lo:DateTime}
          AND bucket <  {hi:DateTime}
        GROUP BY bucket
        ORDER BY bucket
        """,
        parameters={
            "lo": fetch_from.astimezone(timezone.utc).replace(tzinfo=None),
            "hi": end.astimezone(timezone.utc).replace(tzinfo=None),
        },
    ).result_rows

    by_ms: dict[int, dict] = {}
    for bucket, requests, fills, impressions, clicks, revenue in rows:
        # Local CH returns UTC wall clocks as naive datetimes — treat as UTC.
        ts = _parse_utc(bucket)
        by_ms[int(ts.timestamp() * 1000)] = {
            "requests": requests,
            "fills": fills,
            "impressions": impressions,
            "clicks": clicks,
            "revenue": revenue,
        }

    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    hour = 3_600_000
    week = 7 * 24 * hour

    points = []
    for t in range(start_ms, end_ms, hour):
        counters = by_ms.get(t)
        if not counters:
            continue
        observed = _value(metric, counters)
        if observed is None:
            continue
        history = []
        for w in range(1, weeks + 1):
            past = by_ms.get(t - w * week)
            if past:
                v = _value(metric, past)
                if v is not None:
                    history.append(v)
        expected = _median(history) if history else observed
        centre = _median(history) if history else expected
        if history and centre is not None:
            sigma = (_median([abs(v - centre) for v in history]) or 0) * 1.4826
            pad = sigma if sigma > 0 else max(abs(expected) * 0.03, 1e-12)
        else:
            pad = max(abs(expected) * 0.03, 1e-12)
        points.append(
            {
                "t": datetime.fromtimestamp(t / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "observed": observed,
                "expected": expected,
                "lo": max(0.0, expected - pad),
                "hi": expected + pad,
                "baseline_weeks_seen": len(history),
                "baseline_weeks_used": len(history),
            }
        )

    outside = [i for i, p in enumerate(points) if p["observed"] < p["lo"] or p["observed"] > p["hi"]]
    from_idx = outside[0] if outside else -1
    to_idx = outside[-1] if outside else -1
    effect = 0.0
    if from_idx >= 0:
        span = points[from_idx : to_idx + 1]
        obs = sum(p["observed"] for p in span)
        exp = sum(p["expected"] for p in span)
        effect = (obs - exp) / exp if exp else 0.0

    return {
        "metric": metric,
        "label": LABEL[metric],
        "points": points,
        "from": from_idx,
        "to": to_idx,
        "effect": effect,
    }


def _build_tree(steps: list[dict]) -> dict | None:
    if not steps:
        return None
    nodes = {}
    for s in steps:
        nodes[s["step_id"]] = {**s, "children": []}
    roots = []
    for node in nodes.values():
        parent = nodes.get(node["parent_id"]) if node["parent_id"] else None
        if parent:
            parent["children"].append(node)
        else:
            roots.append(node)
    for node in nodes.values():
        node["children"].sort(key=lambda n: n["ordinal"])
    roots.sort(key=lambda n: n["ordinal"])
    if len(roots) == 1:
        return roots[0]
    return {
        "step_id": "synthetic-root",
        "parent_id": "",
        "span_id": "",
        "ordinal": 0,
        "name": "investigation",
        "kind": "pipeline",
        "what": f"{len(roots)} top-level stages",
        "why": "Grouped for reading.",
        "result": "",
        "sql": "",
        "duration_ms": max(r["offset_ms"] + r["duration_ms"] for r in roots) - min(r["offset_ms"] for r in roots),
        "offset_ms": min(r["offset_ms"] for r in roots),
        "children": roots,
    }


def export(run_id: str, out_path: Path) -> None:
    client = _client()

    run_rows = client.query(
        """
        SELECT run_id, toString(started_at), toString(finished_at), status, cases_found,
               git_sha, trace_id, note, duration_ms
        FROM runs FINAL WHERE run_id = {id:String}
        """,
        parameters={"id": run_id},
    ).result_rows
    if not run_rows:
        raise SystemExit(f"No run {run_id}")

    r = run_rows[0]
    run = {
        "run_id": r[0],
        "started_at": _iso(r[1]),
        "finished_at": _iso(r[2]),
        "status": r[3] or "complete",
        "cases_found": int(r[4] or 0),
        "git_sha": r[5] or "",
        "trace_id": r[6] or "",
        "note": r[7] or "",
        "duration_ms": int(r[8] or 0),
    }

    case_rows = client.query(
        """
        SELECT case_id, run_id, toString(detected_at), metric, grain,
               toString(window_start), toString(window_end), direction,
               observed, expected, relative_effect, p_value, dispersion, verdict_kind,
               segment, segment_json, confidence, confidence_json, gates_json, impact_json,
               narrative, narrative_source, narrative_model, narrative_verified, narrative_rejected,
               fingerprint, trace_id, recurrence_of, detector, mode, cells_tested
        FROM cases FINAL WHERE run_id = {id:String}
        ORDER BY confidence DESC, abs(relative_effect) DESC
        """,
        parameters={"id": run_id},
    ).result_rows

    case_ids = [row[0] for row in case_rows]
    if not case_ids:
        raise SystemExit("Run has no cases")

    window_start = _parse_utc(case_rows[0][5])
    window_end = _parse_utc(case_rows[0][6])

    cand_rows = client.query(
        """
        SELECT case_id, candidate, depth, observed, expected, predicted, residual,
               sufficiency, minimality, maximality, holdout, status, reason
        FROM case_candidates WHERE case_id IN {ids:Array(String)}
        ORDER BY case_id, status = 'accused' DESC, sufficiency DESC
        """,
        parameters={"ids": case_ids},
    ).result_rows
    cands: dict[str, list] = {cid: [] for cid in case_ids}
    for row in cand_rows:
        cands[row[0]].append(
            {
                "candidate": row[1],
                "depth": int(row[2] or 0),
                "observed": _num(row[3]),
                "expected": _num(row[4]),
                "predicted": _num(row[5]),
                "residual": _num(row[6]),
                "sufficiency": _num(row[7]),
                "minimality": _num(row[8]),
                "maximality": _num(row[9]),
                "holdout": _num(row[10]),
                "status": row[11] or "considered",
                "reason": row[12] or "",
            }
        )

    step_rows = client.query(
        """
        SELECT case_id, step_id, parent_id, ordinal, name, kind, what, why, result, sql,
               duration_ms, offset_ms, span_id
        FROM case_steps WHERE case_id IN {ids:Array(String)}
        ORDER BY case_id, ordinal
        """,
        parameters={"ids": case_ids},
    ).result_rows
    steps_by: dict[str, list] = {cid: [] for cid in case_ids}
    for row in step_rows:
        steps_by[row[0]].append(
            {
                "step_id": row[1],
                "parent_id": row[2] or "",
                "ordinal": int(row[3] or 0),
                "name": row[4],
                "kind": row[5] or "step",
                "what": row[6] or "",
                "why": row[7] or "",
                "result": row[8] or "",
                "sql": row[9] or "",
                "duration_ms": int(row[10] or 0),
                "offset_ms": int(row[11] or 0),
                "span_id": row[12] or "",
            }
        )

    cov_count = client.query(
        "SELECT count() FROM coverage_ledger WHERE run_id = {id:String}",
        parameters={"id": run_id},
    ).first_item
    coverage_total = int(cov_count) if isinstance(cov_count, int) else int(list(cov_count.values())[0])

    # Per (metric, grain, window) gap counts — same keying as Live getCoverage().
    cov_grouped = client.query(
        """
        SELECT metric, grain, window_start, count() AS gap_count
        FROM coverage_ledger
        WHERE run_id = {id:String}
        GROUP BY metric, grain, window_start
        """,
        parameters={"id": run_id},
    ).result_rows
    count_by_key: dict[str, int] = {}
    for row in cov_grouped:
        key = f"{row[0]}|{row[1]}|{_iso(row[2])}"
        count_by_key[key] = int(row[3] or 0)

    cov_sample = client.query(
        """
        SELECT metric, grain, window_start, combo, key_a, key_b, denominator, required, reason,
               resolvable_effect, gap_count
        FROM (
          SELECT metric, grain, window_start, combo, key_a, key_b, denominator, required, reason,
                 resolvable_effect,
                 count() OVER (PARTITION BY metric, grain, window_start) AS gap_count,
                 row_number() OVER (
                   PARTITION BY metric, grain, window_start
                   ORDER BY denominator DESC, combo, key_a, key_b
                 ) AS detail_rank
          FROM coverage_ledger
          WHERE run_id = {id:String}
        )
        WHERE detail_rank <= 20
        ORDER BY metric, grain, window_start, denominator DESC
        """,
        parameters={"id": run_id},
    ).result_rows
    coverage_by_key: dict[str, list] = {}
    for row in cov_sample:
        key = f"{row[0]}|{row[1]}|{_iso(row[2])}"
        coverage_by_key.setdefault(key, []).append(
            {
                "combo": row[3],
                "key_a": row[4] or "",
                "key_b": row[5] or "",
                "denominator": int(row[6] or 0),
                "required": int(row[7] or 0),
                "reason": row[8] or "",
                "resolvable_effect": _num(row[9], -1),
            }
        )

    coverage_gaps = [g for gaps in coverage_by_key.values() for g in gaps][:100]

    cases = []
    for row in case_rows:
        cid = row[0]
        try:
            segment_json = json.loads(row[15]) if row[15] else {}
        except (TypeError, ValueError):
            segment_json = {}
        try:
            conf_payload = json.loads(row[17]) if row[17] else {}
        except (TypeError, ValueError):
            conf_payload = {}
        components = []
        for comp in conf_payload.get("components") or []:
            components.append(
                {
                    "name": comp.get("name", ""),
                    "score": _num(comp.get("score")),
                    "weight": _num(comp.get("weight")),
                    "scored": comp.get("state", "scored") != "unknown",
                    "detail": comp.get("detail", ""),
                }
            )
        try:
            gates = json.loads(row[18]) if row[18] else {}
        except (TypeError, ValueError):
            gates = {}
        try:
            impact = json.loads(row[19]) if row[19] else {"units": 0, "unit": "", "revenue": None, "direct": False, "basis": []}
        except (TypeError, ValueError):
            impact = {"units": 0, "unit": "", "revenue": None, "direct": False, "basis": []}

        rejected = row[24] or []
        if not isinstance(rejected, list):
            rejected = list(rejected) if rejected else []

        steps_flat = steps_by.get(cid, [])
        grain = row[4] or "1h"
        window_start_iso = _iso(row[5])
        cov_key = f"{row[3]}|{grain}|{window_start_iso}"
        cases.append(
            {
                "case_id": cid,
                "run_id": row[1],
                "detected_at": _iso(row[2]),
                "metric": row[3],
                "grain": grain,
                "window_start": window_start_iso,
                "window_end": _iso(row[6]),
                "direction": row[7],
                "observed": _num(row[8]),
                "expected": _num(row[9]),
                "relative_effect": _num(row[10]),
                "p_value": _num(row[11]),
                "dispersion": _num(row[12]),
                "verdict_kind": row[13],
                "segment": row[14] or "",
                "segment_json": segment_json,
                "confidence": _num(row[16]),
                "confidence_json": components,
                "publishable": bool(conf_payload.get("publishable")),
                "confidence_caveat": conf_payload.get("caveat", ""),
                "gates_json": gates,
                "impact_json": impact,
                "narrative": row[20] or "",
                "narrative_source": row[21] or "template",
                "unsupported": [str(x) for x in rejected],
                "narrative_verified": bool(row[23]),
                "fingerprint": row[25] or "",
                "trace_id": row[26] or "",
                "recurrence_of": row[27] or "",
                "detector": row[28] or "temporal",
                "mode": row[29] or "explain_away",
                "candidates": cands.get(cid, []),
                "coverage_total": count_by_key.get(cov_key, 0),
                "coverage": coverage_by_key.get(cov_key, [])[:20],
                "cells_tested": int(row[30] or 0),
                "llm_model": row[22] or "",
                "trace": _build_tree(steps_flat),
                "steps_flat": steps_flat,
            }
        )

    case_metrics = {c["metric"] for c in cases}
    metric_order = list(dict.fromkeys([*CHART_METRICS, *CASE_SERIES_EXTRAS, *sorted(case_metrics)]))
    series = [_series_for(client, m, window_start, window_end) for m in metric_order]
    series = [s for s in series if s["points"]]

    span_count = sum(len(c["steps_flat"]) for c in cases)

    fixture = {
        "meta": {
            "id": "jul05-ctr-android14-travel",
            "label": "Ad Events · Jul 5–6",
            "honesty": "recorded_replay",
            "source": {
                "run_id": run_id,
                "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "clickhouse_database": os.environ.get("CLICKHOUSE_DATABASE", "default"),
            },
            "playback": {
                "booth_duration_ms_at_1x": 100_000,
                "investigation_fraction": 0.20,
            },
        },
        "timeline": {
            "start": _iso(window_start),
            "end": _iso(window_end),
        },
        "run": run,
        "series": series,
        "coverage": {"total_gaps": coverage_total, "gaps": coverage_gaps},
        "spans": span_count,
        "cases": cases,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(fixture, separators=(",", ":"), ensure_ascii=True))
    print(f"Wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KiB)")
    print(f"  {len(cases)} cases, {span_count} steps, {coverage_total} coverage gaps")
    print(f"  timeline {fixture['timeline']['start']} → {fixture['timeline']['end']}")


def main() -> None:
    _load_env()
    run_id = sys.argv[1] if len(sys.argv) > 1 else "a2e16a400eb3427e8a34bb44719821f3"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "web" / "fixtures" / "timemachine" / "jul05.json"
    export(run_id, out)


if __name__ == "__main__":
    main()
