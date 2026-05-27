import type { QueryProfile } from './QueryProfile.js';

/** Returns true iff `query`'s first non-whitespace word is `SELECT`.
 *  Used to gate the PROFILE prefix — Ditto's PROFILE keyword only
 *  supports SELECT (INSERT/UPDATE/DELETE/EVICT would syntax-error).
 *  Case-insensitive. Rejects `SELECTOR` / `SELECTED` by requiring a
 *  whitespace boundary after the keyword. */
export function isSelectStatement(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) { return false; }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT')) { return false; }
  if (upper.length === 'SELECT'.length) { return true; }
  const next = upper.charAt('SELECT'.length);
  return /\s/.test(next);
}

/** Returns true iff the user has already typed `PROFILE` at the start
 *  of their statement. Prevents double-prepending — `PROFILE PROFILE
 *  SELECT …` would be a syntax error. */
export function alreadyHasProfilePrefix(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) { return false; }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('PROFILE')) { return false; }
  if (upper.length === 'PROFILE'.length) { return true; }
  const next = upper.charAt('PROFILE'.length);
  return /\s/.test(next);
}

/** Profile envelope key Ditto emits as the trailing item. Exported
 *  so the host's "did we get a profile back?" check uses the same
 *  literal as the parser. */
export const PROFILE_ENVELOPE_KEY = '~request_profile';

/** Stub — the full parser lands in Task 4. */
export function parseProfileItem(_item: Record<string, unknown>): QueryProfile | null {
  return null;
}
