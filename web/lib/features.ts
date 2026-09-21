import 'server-only';

const ENABLED = new Set(['1', 'true', 'yes', 'on']);

/** Fail closed: absent, false, or malformed values keep model-backed functionality unavailable. */
export function recommendationsEnabled(): boolean {
  return ENABLED.has((process.env.RECOMMENDATIONS_ENABLED ?? '').trim().toLowerCase());
}

/** How many cases the console may generate advice for at once when the AI toggle is on.
 *
 *  Keep this ≤ CURSOR_MAX_CONCURRENCY on the remediation service or jobs will queue / 429.
 *  Draft→validate inside one case stays sequential; this only fans out across cases. */
export function recommendParallelism(): number {
  const raw = Number(process.env.RECOMMEND_PARALLELISM ?? 8);
  if (!Number.isFinite(raw) || raw < 1) return 8;
  return Math.min(32, Math.floor(raw));
}

/** Whether the console may run `verdict ingest` against a path typed into the browser.
 *
 *  Fails closed for a different reason than the one above: this one runs a program on a path the
 *  client chose, so the default has to be off wherever nobody has deliberately turned it on. */
export function ingestEnabled(): boolean {
  return ENABLED.has((process.env.INGEST_ENABLED ?? '').trim().toLowerCase());
}
