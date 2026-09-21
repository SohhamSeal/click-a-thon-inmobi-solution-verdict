#!/usr/bin/env python3
"""Re-narrate existing cases in local ClickHouse with the LLM (or template fallback).

Preserves case_ids / steps. Writes a new ReplacingMergeTree version of each case row
with narrative fields filled, then those values can be re-exported into the TM fixture.
"""

from __future__ import annotations

import json
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
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _client():
    import clickhouse_connect

    secure = (os.environ.get("CLICKHOUSE_SECURE") or "false").lower() == "true"
    port = int(os.environ.get("CLICKHOUSE_PORT") or (8443 if secure else 8123))
    return clickhouse_connect.get_client(
        host=os.environ.get("CLICKHOUSE_HOST", "localhost"),
        port=port,
        username=os.environ.get("CLICKHOUSE_USER", "default"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", ""),
        database=os.environ.get("CLICKHOUSE_DATABASE", "verdict"),
        secure=secure,
    )


def _bundle_for_case(row: dict, candidates: list[dict]):
    from verdict.narrate import (
        COUNT,
        PERCENT,
        PLAIN,
        Claim,
        EvidenceBundle,
        EvidenceCheck,
        ExonerationEntry,
        RuledOut,
    )

    metric = row["metric"]
    segment = row["segment"] or "all traffic"
    effect = float(row["relative_effect"] or 0)
    observed = float(row["observed"] or 0)
    expected = float(row["expected"] or 0)
    conf = float(row["confidence"] or 0)
    direction = row["direction"] or "flat"
    kind = row["verdict_kind"] or "unlocalized"

    claims = [
        Claim("case.observed", "observed level", observed, PLAIN, f"Observed {observed:g} on {metric}."),
        Claim("case.expected", "expected level", expected, PLAIN, f"Expected {expected:g} on {metric}."),
        Claim(
            "case.relative_effect",
            "relative move",
            effect,
            PERCENT,
            f"{segment} moved {effect * 100:.1f}% relative to expectation.",
        ),
        Claim("case.confidence", "confidence", conf, PLAIN, f"Confidence score {conf:.2f}."),
        Claim(
            "case.candidates_considered",
            "candidates considered",
            float(len(candidates)),
            COUNT,
            f"{len(candidates)} candidates were considered.",
        ),
    ]

    cleared: list[ExonerationEntry] = []
    ruled: list[RuledOut] = []
    checks: list[EvidenceCheck] = []
    for cand in candidates:
        status = cand.get("status") or "considered"
        label = cand.get("candidate") or ""
        if status == "cleared":
            cleared.append(
                ExonerationEntry(
                    label,
                    float(cand.get("predicted") or 0),
                    float(cand.get("observed") or 0),
                    float(cand.get("residual") or 0),
                    PLAIN,
                    cand.get("reason") or "cleared",
                )
            )
        elif status in {"too_broad", "too_narrow", "partial", "wrong_direction", "immaterial"}:
            ruled.append(RuledOut(label, status, cand.get("reason") or status))
        elif status == "accused":
            for name in ("sufficiency", "minimality", "maximality", "holdout"):
                score = cand.get(name)
                if score is None:
                    continue
                checks.append(EvidenceCheck(name, "pass" if float(score) >= 0.5 else "fail", float(score), ""))

    cleared_n = float(len(cleared))
    claims.append(
        Claim(
            "case.cleared_count",
            "candidates cleared",
            cleared_n,
            COUNT,
            f"{int(cleared_n)} candidates cleared.",
        )
    )

    headline = (
        f"{metric} {direction}s {abs(effect) * 100:.1f}% on {segment} "
        f"({kind}; confidence {conf:.2f})."
    )
    labels = tuple(
        {segment, metric, kind, direction, *(c.get("candidate") or "" for c in candidates)} - {""}
    )

    return EvidenceBundle(
        metric=metric,
        window_start=str(row["window_start"]),
        window_end=str(row["window_end"]),
        grain=row["grain"] or "1h",
        detector=row.get("detector") or "temporal",
        headline=headline,
        claims=claims,
        checks=checks,
        cleared=cleared,
        ruled_out=ruled,
        coverage=[],
        labels=labels,
        mode=row.get("mode") or "explain_away",
        note="",
    )


def main() -> None:
    sys.path.insert(0, str(ROOT / "src"))
    _load_env()

    from verdict.config import load_config
    from verdict.narrate import narrate

    cfg = load_config()
    ch = _client()
    db = os.environ.get("CLICKHOUSE_DATABASE", "verdict")

    cols = [
        "case_id", "run_id", "detected_at", "metric", "grain", "window_start", "window_end",
        "direction", "observed", "expected", "relative_effect", "p_value", "dispersion",
        "verdict_kind", "segment", "segment_json", "confidence", "confidence_json",
        "gates_json", "impact_json", "narrative", "narrative_source", "narrative_model",
        "narrative_verified", "narrative_rejected", "narrative_prompt_tokens",
        "narrative_completion_tokens", "narrative_latency_ms", "fingerprint", "trace_id",
        "recurrence_of", "detector", "mode", "cells_tested",
    ]
    rows = ch.query(
        f"SELECT {', '.join(cols)} FROM {db}.cases FINAL ORDER BY confidence DESC"
    ).named_results()
    cases = list(rows)
    print(f"Re-narrating {len(cases)} cases (llm.enabled={cfg.llm.enabled})…", flush=True)

    cand_rows = ch.query(
        f"""
        SELECT case_id, candidate, depth, observed, expected, predicted, residual,
               sufficiency, minimality, maximality, holdout, status, reason
        FROM {db}.case_candidates
        """
    ).named_results()
    by_case: dict[str, list] = {}
    for r in cand_rows:
        by_case.setdefault(r["case_id"], []).append(dict(r))

    updated = 0
    for row in cases:
        row = dict(row)
        cid = row["case_id"]
        bundle = _bundle_for_case(row, by_case.get(cid, []))
        narration = narrate(bundle, cfg.llm)
        print(
            f"  {row['metric']:12} {cid[:8]} → {narration.source} "
            f"verified={narration.verified} len={len(narration.text)}",
            flush=True,
        )
        if not narration.text.strip():
            print("    skip empty", flush=True)
            continue

        # New version for ReplacingMergeTree(detected_at)
        now = datetime.now(timezone.utc)
        row["detected_at"] = now
        for key in ("window_start", "window_end"):
            v = row.get(key)
            if isinstance(v, datetime) and v.tzinfo is None:
                row[key] = v.replace(tzinfo=timezone.utc)
            elif isinstance(v, str) and v:
                text = v.strip().replace("T", " ").replace("Z", "")
                if "." in text:
                    text = text.split(".", 1)[0]
                row[key] = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=timezone.utc
                )
        row["narrative"] = narration.text
        row["narrative_source"] = narration.source
        row["narrative_model"] = narration.model or ""
        row["narrative_verified"] = 1 if narration.verified else 0
        row["narrative_rejected"] = list(narration.unsupported or [])
        row["narrative_prompt_tokens"] = int(narration.prompt_tokens or 0)
        row["narrative_completion_tokens"] = int(narration.completion_tokens or 0)
        row["narrative_latency_ms"] = int(narration.latency_ms or 0)

        values = []
        for c in cols:
            v = row.get(c)
            if c == "narrative_rejected" and not isinstance(v, list):
                v = list(v) if v else []
            values.append(v)
        ch.insert("cases", [values], column_names=cols, database=db)
        updated += 1

    ch.command(f"OPTIMIZE TABLE {db}.cases FINAL")
    print(f"Done. Updated {updated}/{len(cases)} cases.", flush=True)


if __name__ == "__main__":
    main()
