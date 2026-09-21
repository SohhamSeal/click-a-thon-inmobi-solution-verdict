# Onset timing & Investigation visual grammar

**Date:** 2026-09-22  
**Status:** Locked (v3 mockups)  
**Scope:** Case drawer Timing strip + Investigation stage colour layering; onset computation; no Trace/Evidence/Narrative redesign.

## Problem

Cases share one investigation window, so the drawer feels like “everything happened at day start.” Operators need **when the accused segment sustained a historical break** (onset), separately from **when the parent series was most anomalous** (peak) and **when investigation steps ran** (`case_steps.offset_ms`).

## Three clocks (invariant)

| Clock | Meaning | Source |
|---|---|---|
| **Onset** | First sustained historical deviation of the **accused segment** | Deterministic rule below |
| **Peak** | Parent (`__all__`) anomaly observation | Existing `findParentAnomaly` / graph markers — unchanged |
| **Investigation timing** | Engine step waterfall | `case_steps.offset_ms` — unchanged |

Do not use peak as onset. Do not use sibling-norm / structural expected as onset (out of scope; historical only).

## Onset algorithm

**Grain:** case `grain` (jul05 = `1h`).  
**Persistence `K`:** `2` consecutive hours at 1h grain (single-hour outs are noise at this cadence; longer runs rarely appear on band-outs for this corpus).

For each hour `t` in `[window_start, window_end)`:

1. Read accused-segment counters at `t`.
2. History = same weekday-hour over prior `baseline_weeks` (default 4).
3. Drop one extreme week with the **window-level** mask (same idea as Live parent series `droppedWeek`).
4. Expected: rates = volume-weighted pool; counts = trimmed mean of kept weeks.
5. Band: MAD × 1.4826 among kept week values; pad = `2σ` (else 3% of `|expected|`) → `lo` / `hi`.
6. Hour is **flagged** only in the **case direction**: rise → `obs > hi`; fall → `obs < lo`. Opposite-band exits do not count.

**Onset** = start timestamp of the earliest run of length ≥ `K` flagged hours.

**Statuses (always computed for audit):**

| Status | Meaning |
|---|---|
| `determined` | Sustained run longer than `K` |
| `weak` | Sustained run of exactly `K` |
| `undetermined` | No sustained run, insufficient history, or empty series |

Payload is deterministic and auditable (per-hour observed/expected/lo/hi/flagged).

## UI promotion (no confidence gate)

Always compute under the hood. **Promote** a timestamp in the main Timing strip only when:

- `verdict_kind === 'localized'`, and
- onset status is `determined` or `weak`

| Condition | Display |
|---|---|
| Localized + determined | `Onset ≈ HH:MM` (UTC implied by console convention) |
| Localized + weak | `Onset ≈ HH:MM · weak` |
| Localized + undetermined | `Onset not established` + detail `No sustained segment deviation found` |
| Unlocalized (any onset status) | Same as undetermined in the strip (do not surface weak historical hours as incident onset) |

Optional Peak on the same strip when a parent observation exists:  
`Onset ≈ 01:00 · Peak 02:00`

Longer structural/window explanations stay in Investigation / Evidence — not in the Timing strip.

## Timing strip placement

In CasePanel header, under Effect / Impact / Confidence pills, above Investigation tabs. Same Verdict tokens; not a new design system.

“Not established” is a **first-class analytical outcome** (full phrase), not `—`, `n/a`, red error chrome, or a hidden strip.

## Investigation spine (unchanged structure)

`Detect → Investigate → Localize → Verify → Verdict` with Investigate fan (Temporal / Structural / Statistical correction / other detector families).

**Invariants:**

- Five stage blocks stay **responsive** — grid distributes across drawer width (existing `inv-rail`); no fixed widths.
- Fan reflects **real** revealed steps / Time Machine simTime (existing `deriveInvestigation`).
- Trace / Evidence / Narrative tabs unchanged; Investigation remains the high-level map.
- Pending → Active → Complete/Empty driven by existing revealed-step logic.

### State vs selection (visual layering)

| Concern | Colour |
|---|---|
| Outcome / stage state | Semantic: green complete+ok, **amber empty**, muted pending |
| Selection / focus | **Indigo ring** (`--accbd`) |

**Must not override each other.** Selected empty (e.g. Unlocalized Verdict) = amber fill + indigo focus ring, still `⚠ VERDICT — UNLOCALIZED`.

Copy locked for unlocalized path:

- LOCALIZE empty → `Could not isolate`
- VERIFY complete when no components scored → `No score available` (already derived; do not imply “confidence 0 = weak accusation”)
- VERDICT empty → `UNLOCALIZED`

## Data wiring

- **Live:** compute onset from ClickHouse `rollup_*` segment series (same baseline geometry as Live parent series).
- **Time Machine:** store onset audit + status on the fixture case (or recompute from embedded series if present); playback must not require inventing timestamps.
- Graph Peak marker behaviour unchanged.

## Non-goals

- Sibling-norm / structural onset
- Confidence threshold as visibility gate
- Change-point ML models
- Multi-window case lists (option 1)
- New UI kits / token systems

## Acceptance

1. CTR Android 14 × travel (localized): onset ≈ 01:00; peak may show 02:00; confidence 0.30 still shows onset.
2. Galaxy A54 impressions (unlocalized): strip says not established even if audit has a weak historical run.
3. Selected Unlocalized Verdict stays amber with indigo ring.
4. Time Machine stage colours still follow simTime reveal.
5. Trace / Evidence / Narrative unchanged.
