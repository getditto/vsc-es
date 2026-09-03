import type { QueryAdvice, QueryIndexSuggestion } from '../ipc/messages.js';

/**
 * SDK 5.1 `ADVISE <SELECT …>` result handling for the Query Editor.
 *
 * Row shape (proved live in `src/test/advise-live.test.ts` and matching the
 * SDK's dtest fixtures at `crates/dittoffi/tests/dql/sp-indexing/advise.dtest`):
 * one row whose `advice` object is
 *
 * ```jsonc
 * {
 *   "statement": "SELECT * FROM atest WHERE e=1\n",
 *   "suggestedIndexes": [
 *     { "collection": "atest",
 *       "reason": "equality predicates on `e`",
 *       "statement": "CREATE INDEX IF NOT EXISTS adv_atest_e ON default:`atest` (`e` ASC)" }
 *   ]
 * }
 * ```
 *
 * When there's nothing to advise on, `suggestedIndexes` is absent and a
 * free-text `outcome` (e.g. "no keys to advise on") explains why.
 *
 * The extractor is deliberately forgiving: forward-compatible emitters may
 * add fields or split advice across several rows, so we scan every row and
 * merge, and drop suggestions missing the fields the UI needs.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSuggestion(raw: unknown): QueryIndexSuggestion | null {
  if (!isObject(raw)) { return null; }
  const collection = raw.collection;
  const reason = raw.reason;
  const statement = raw.statement;
  // All three are required: the UI renders reason + statement and the
  // confirmation modal names the collection. A partial suggestion is noise.
  if (typeof collection !== 'string' || typeof statement !== 'string' || statement === '') {
    return null;
  }
  return {
    collection,
    reason: typeof reason === 'string' ? reason : '',
    statement,
  };
}

/** Extract the query advice from an ADVISE result set, or null when no row
 *  carries an advice object (non-ADVISE queries; forward-incompatible rows). */
export function extractQueryAdvice(rows: Record<string, unknown>[]): QueryAdvice | null {
  let statement: string | undefined;
  let outcome: string | undefined;
  const suggestions: QueryIndexSuggestion[] = [];
  let found = false;
  for (const row of rows) {
    const advice = row.advice;
    if (!isObject(advice)) { continue; }
    found = true;
    if (typeof advice.statement === 'string') { statement ??= advice.statement; }
    if (typeof advice.outcome === 'string') { outcome ??= advice.outcome; }
    if (Array.isArray(advice.suggestedIndexes)) {
      for (const raw of advice.suggestedIndexes) {
        const parsed = parseSuggestion(raw);
        if (parsed) { suggestions.push(parsed); }
      }
    }
  }
  if (!found) { return null; }
  return {
    statement: statement ?? '',
    ...(outcome !== undefined ? { outcome } : {}),
    suggestions,
  };
}
