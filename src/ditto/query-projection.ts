import type { QueryProfile } from './QueryProfile.js';
import { parseProfileItem } from './QueryProfileParser.js';

/**
 * Hard cap on rows projected from a single query result and shipped to a
 * webview. A bare `SELECT *` against a large synced collection would otherwise
 * materialize the entire result set in the extension host and structured-clone
 * it into the webview — a one-click OOM of the shared extension-host process.
 * 10k rows is far beyond what the paged result table (≤1000/page) can usefully
 * show; the caller flags truncation so the UI can say so.
 */
export const MAX_QUERY_ROWS = 10_000;

/** The slice of the SDK's QueryResultItem this module needs. Narrowed so the
 *  projection can be tested without an SDK instance — the cap and the
 *  dematerialize discipline are the parts worth covering, and neither needs a
 *  real store. */
export interface ProjectableItem {
  readonly value: unknown;
  dematerialize(): void;
}

export interface ProjectionResult {
  rows: Record<string, unknown>[];
  /** The trailing `~request_profile` envelope, when the statement produced
   *  one and it parsed. */
  profile: QueryProfile | undefined;
  /** Rows the query produced, excluding a consumed profile envelope. Equals
   *  `rows.length` unless the cap kicked in. */
  totalRowCount: number;
  /** True when `totalRowCount > rows.length`. */
  truncated: boolean;
}

/**
 * Project a result set into plain rows, bounded by `maxRows`.
 *
 * Every item is dematerialized as it is passed, read or not, so none of them
 * pin native memory for the life of the result — the same discipline the
 * observer paths follow. Reading `.value` re-materializes on demand, so a
 * dematerialized item is still usable; dematerializing is a memory decision,
 * not a consume.
 */
export function projectQueryRows(
  items: readonly ProjectableItem[],
  opts: { expectsEnvelope: boolean; maxRows?: number },
): ProjectionResult {
  const maxRows = opts.maxRows ?? MAX_QUERY_ROWS;
  let count = items.length;
  let profile: QueryProfile | undefined;

  // Pop the trailing `~request_profile` item before projecting the user's
  // rows, so the result table never shows the profile envelope as a row.
  if (opts.expectsEnvelope && count > 0) {
    const last = items[count - 1];
    try {
      const parsed = parseProfileItem(last.value as Record<string, unknown>);
      if (parsed) {
        profile = parsed;
        count -= 1;
      }
    } finally {
      try { last.dematerialize(); } catch { /* ignore */ }
    }
  }

  const projected = Math.min(count, maxRows);
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const item = items[i];
    try {
      if (i < projected) { rows.push(item.value as Record<string, unknown>); }
    } finally {
      try { item.dematerialize(); } catch { /* ignore */ }
    }
  }

  return { rows, profile, totalRowCount: count, truncated: count > projected };
}
