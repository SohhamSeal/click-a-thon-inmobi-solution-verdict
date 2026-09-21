# What the four OSS integrations actually do in the demo

The Click-a-thon OSS stack names four products: **ClickHouse**, **ClickStack**, **Langfuse**,
and **LibreChat**. This file is the honest mapping for *this* product (Verdict) and the
recorded demo (`demo.mp4`). Short answers first, then how each one is wired.

| Integration | In the demo? | What you actually use it for |
|---|---|---|
| **ClickHouse** | Yes — the whole system | Primary datastore *and* the analytical engine. Raw events, rollups, dictionaries, cases, evidence, coverage, and OpenTelemetry spans all live here. Detectors and localizers are SQL + Python over these tables, not a separate warehouse. |
| **ClickStack** | Yes — traces, not a second database | The OpenTelemetry collector writes investigation spans into ClickHouse (`default.otel_traces`). **HyperDX** (ClickStack's UI) is how a human walks that trace as a waterfall. Default: hosted HyperDX on ClickHouse Cloud. Optional: self-hosted all-in-one container. |
| **Langfuse** | **No** | Not deployed, not in `docker-compose.yml`, zero references in this repo. LLM narration is still bounded (numeric verifier + `--no-llm`), and those calls show up as ordinary OTel spans / `case_steps` rows, not as a Langfuse project. |
| **LibreChat** | Yes — as **Verdict.AI** | The chat bubble (and full window on `:3081` / `:3080`). One tool: the official **ClickHouse MCP** server, so a follow-up question runs real SQL against the same rollups the detectors read. It does not decide verdicts. |

If a slide or a rubric asks "which of the four did you use?", the accurate sentence is:
ClickHouse as the engine, ClickStack for investigation traces, LibreChat for conversational
SQL follow-up, Langfuse unused.

---

## 1. ClickHouse — warehouse and brain

### What it is in this demo

ClickHouse Cloud (`CLICKHOUSE_HOST` in `.env`). Every number the console shows was computed
against this service. The Next.js UI has no API tier: server components query ClickHouse
during render. The Python engine (`verdict`) is the other client.

### What it stores

| Kind | Tables / objects | Role in the demo |
|---|---|---|
| Facts | `ad_events` | 9M parquet rows (Jun 1 – Jul 5, plus whatever you ingest). Narrow: ids + counters, not denormalized dimension strings. |
| Dimensions | `dim_apps`, `dim_advertisers`, `dim_geo_device` + dictionaries `dict_*` | Lookups via `dictGet(...)` when building rollups. Dictionaries must be reloaded **on the cluster**, or a new day's events get the wrong region/OS. |
| Rollup lattice | `rollup_5m`, `rollup_1h`, `rollup_1d` | Incremental materialized views. Long-form 1-way and 2-way cells: `(bucket, combo, key_a, key_b, requests, fills, impressions, clicks, revenue)`. Only additive counters; rates are divided at read time. |
| Product output | `cases`, `case_candidates`, `case_steps`, `coverage_ledger`, `runs`, `feedback`, `case_recommendations` | What the console lists. Candidates include **cleared** segments and the reason. |
| Traces | `default.otel_traces` (collector-owned) | Same cluster as the ad data, so a span and the rows it was computed from are one join apart. |

### What it *computes* (not just stores)

Detection and localization are not "export to pandas and scan." Typical work:

- Prefetch the lattice for a window (`GROUPING SETS`-style combos already materialized).
- Seasonal / sibling baselines, Wilson / two-proportion tests, Benjamini–Hochberg over the
  family of cells actually tested.
- Explain-away: remove a candidate segment and ask whether the parent returns to expectation.
- Rate/mix split of an aggregate ratio into rate, mix, and interaction terms.

If ClickHouse is down, the console has nothing to show. There is no local SQLite fallback.

### What you see in the recording

The board, charts, observed vs expected, impact, coverage gaps, evidence table — all reads
from these tables after `verdict investigate` (or **Ingest data**) wrote a run.

### How to check it yourself

```sql
SELECT count() FROM ad_events;
SELECT count() FROM cases;
SELECT run_id, status, duration_ms FROM runs ORDER BY started_at DESC LIMIT 5;
```

---

## 2. ClickStack — investigation as a distributed trace

ClickStack here means two pieces that people mix up:

1. **OTLP collector** (`clickhouse/clickstack-otel-collector`) — always started with
   `./start.sh`. It receives spans from the engine and inserts them into ClickHouse.
2. **HyperDX** — the UI. Default is **hosted** `https://hyperdx.clickhouse.cloud` (needs a
   ClickHouse Cloud login). The compose service `clickstack` is the all-in-one image and is
   **not** started unless you use `--profile selfhosted`.

### What a span is

Every pipeline step opens a span with three fields: **what** ran, **why** it ran, **what
came back**. Same record is written to `case_steps`. Three consumers, one log:

- HyperDX waterfall (forensic, compare this run to other traffic)
- Console Trace tab (works even if HyperDX is unreachable)
- Any HTML / markdown evidence pack generated from `case_steps`

Example tree from a real Jul 8 fill-rate case:

```
investigate
  audit          — baseline still describe the population?
  detect         — temporal + structural cells
  correct        — Benjamini–Hochberg
  localize:fill_rate  — accuse os_version=iOS 17.5 (or refuse)
  confidence
  narrate
```

On the unseen bundle, `audit` running *before* `detect` is the whole story: segment history
was rejected, sibling localization ran instead of a stale baseline.

### Deep link from the console

Each case stores the 32-character OpenTelemetry `trace_id`. The HyperDX button builds:

`https://hyperdx.clickhouse.cloud/search?traceId=…&from=…&to=…`

`from`/`to` are required. Without them HyperDX opens Live Tail (last few minutes) and the
trace looks "lost." Padding is 30 minutes either side of `detected_at`
(`web/lib/links.ts`).

### What you see in the recording

The in-console Trace tab (tree / waterfall). The hosted HyperDX UI was **not** captured in
`demo.mp4` (SSO). The wiring is still there: `trace_id` on the case, collector writing
`otel_traces`, link in the header.

### What ClickStack is *not*

It is not a second copy of the ad events. It does not run the detectors. It does not replace
the evidence ledger. If the collector is restarting, **cases still open** because the console
reads `case_steps`, not HyperDX.

---

## 3. Langfuse — named in the OSS list, not used here

**Fact:** `grep Langfuse` over this repository is empty. No container, no keys, no traces.

### What the rubric item is for

Langfuse is LLM observability: prompts, completions, tool calls, scores, typically stored
in ClickHouse if you self-host it. The intended demo story in early planning notes was:
"open Langfuse and see the model received a JSON evidence bundle and nothing else."

### What Verdict does instead

Narration (`src/verdict/narrate.py`):

- The model is given **already computed** numbers, not raw events.
- Every figure in the draft is checked against that bundle; a hallucinated number rejects
  the draft and the template is used.
- `--no-llm` (or `LLM_ENABLED=false`) changes prose only. Cases, p-values, accused segments
  are identical.
- The `narrate` step is still an OTel span and a `case_steps` row (tokens, latency, verified
  vs rejected). That is the audit trail, without a Langfuse project.

Optional **Actions** (Cursor CLI, `./start.sh --with-ai`) are a different model path and
also not Langfuse.

If you add Langfuse later, the only honest wrap is the narration call (and maybe LibreChat
completions). Do not move detection into it.

---

## 4. LibreChat — Verdict.AI (follow-up SQL, not a second investigator)

### What it is in this demo

Container `verdict-librechat`, config `config/librechat.yaml`, Mongo `chat-db` for sessions.

Two entry points, same agent:

| Surface | URL (defaults from `./start.sh`) | In the demo |
|---|---|---|
| Bubble **Verdict.AI** | iframe on the console | Yes — follow-up question |
| Full LibreChat | http://localhost:3081 | Same backend; recording used the bubble |

### What the model is allowed to do

**One tool:** official `mcp/clickhouse` server (`verdict-clickhouse`), SSE, pinned on the
`verdict` model spec so the first message can query. It is told:

- rollups hold counters, never precomputed rates
- `combo` / `key_a` / `key_b` keying
- `cases` is output, not the only truth — check `coverage_ledger` before calling a segment
  innocent
- **show the SQL** so a human can rerun it

It cannot write verdicts, cannot change detectors, cannot ingest. A chat that answers from
memory without the tool is the failure mode this surface exists to prevent — hence MCP is
attached by default, not left for the user to tick.

### Gemini / tools (why chat ≠ narration)

Narration uses Gemini's OpenAI-compatible endpoint (one wire format with the Python client).
**Tool calls do not survive that shim:** Gemini returns `thought_signature` on function
calls; the OpenAI schema has no place for it; the next turn 400s. LibreChat therefore uses
the native **`google`** provider for the Verdict.AI spec only (`GOOGLE_KEY` = same
`LLM_API_KEY`).

### What you see in the recording

A question such as "how many rows in the cases table?" → MCP `run_select_query` → JSON /
count from ClickHouse, not a guessed number. Screenshot:
`artifacts/screenshots/05-verdict-ai-mcp.png`.

### MCP without LibreChat

`http://localhost:8101/sse` (or `8001` if you did not use `./start.sh`). Cursor:
`.cursor/mcp.json`. Same warehouse, no chat UI.

---

## How they sit together (one investigation)

```
ad_events.parquet
        │  verdict load / ingest
        ▼
   ClickHouse  ── rollup MVs, dictionaries
        │
        │  verdict investigate
        ├─► SQL tests, localization, confidence
        ├─► rows: cases, candidates, case_steps, coverage, runs
        ├─► OTLP ──► ClickStack collector ──► otel_traces ──► HyperDX
        └─► optional LLM prose (verified) ──► same case_steps span
                    │
                    └── LibreChat / MCP ──► SELECT on those same tables
                                              (follow-up only)
```

Langfuse is not in this diagram.

---

## Demo checklist (what to point at)

| Claim | Where to prove it |
|---|---|
| ClickHouse does the analysis | Trace node SQL; `rollup_1h` query; latency is ClickHouse + WAN, not a Python scan of 9M rows |
| ClickStack is real tracing | HyperDX link on a case; `SELECT count() FROM default.otel_traces`; console waterfall from `case_steps` if HyperDX is logged out |
| Langfuse | Do not claim it. Say unused; verifier + `--no-llm` is the LLM boundary |
| LibreChat is not the RCA engine | Toggle LLM off, re-run a window, same accused segment; chat only runs SELECT |

---

## Related files

| Path | Why |
|---|---|
| `docker-compose.yml` | Collector, web, verdict, MCP, LibreChat, optional `clickstack` profile |
| `config/librechat.yaml` | Verdict.AI spec, MCP pin, Google vs OpenAI-compat |
| `src/verdict/trace.py` | Span shape (what / why / result) |
| `web/lib/links.ts` | HyperDX URL + time range |
| `deploy/chat/README.md` | MCP smoke test |
| `docs/guide/06_evidence_tracing.html` | Tracing in the HTML guide |
| Parent folder `clickathon/README.md` | A **different** plugin SDK that *does* wire Langfuse. Not this demo. |
