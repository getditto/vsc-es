import type { IndexField } from '../models/DittoCollection.js';
import { quoteIdentifier, quoteFieldPath } from './dql-identifier.js';

/**
 * Pure DQL builders and parsers for indexes.
 *
 * Ditto SDK 5.1 supports composite indexes: `CREATE INDEX … ON <collection>
 * (<field> [ASC|DESC], …)`. Field order is significant — equality-filtered
 * fields belong first, then range or sort fields — so the order the user
 * entered is preserved exactly.
 *
 * Kept free of the SDK and of `vscode` so the statement text is testable
 * without a store; `dql-live.test.ts` then proves the text actually parses.
 */

/** Thrown for an index request that cannot be expressed. */
export class InvalidIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIndexError';
  }
}

/**
 * Trim names, drop blanks, and reject an empty result.
 *
 * The editor always carries at least one row, and a user who clears it and
 * saves would otherwise produce `CREATE INDEX … ON c ()`.
 */
export function normalizeIndexFields(fields: readonly IndexField[]): IndexField[] {
  const cleaned = fields
    .map(f => ({ name: f.name.trim(), ascending: f.ascending }))
    .filter(f => f.name.length > 0);
  if (cleaned.length === 0) {
    throw new InvalidIndexError('At least one field is required to create an index.');
  }
  const seen = new Set<string>();
  for (const f of cleaned) {
    if (seen.has(f.name)) {
      // Ditto would accept it, but a repeated key adds nothing to the index
      // and makes the generated name ambiguous.
      throw new InvalidIndexError(`Field "${f.name}" is listed more than once.`);
    }
    seen.add(f.name);
  }
  return cleaned;
}

/**
 * Generate the index name: `idx_<collection>_<field>…`.
 *
 * Dots, spaces and dashes become underscores. A dot would read as the
 * `<collection>.<index>` separator the SDK uses in `system:indexes._id`, and
 * the others are simply unreadable in a generated name. The result is still
 * backtick-quoted when emitted, so this is for legibility, not safety.
 *
 * Matches the naming the SwiftUI Edge Studio app generates, so an index made
 * in one client is recognisable in the other.
 */
export function makeIndexName(collection: string, fields: readonly IndexField[]): string {
  const raw = ['idx', collection, ...fields.map(f => f.name)].join('_');
  return raw.replace(/[. -]/g, '_');
}

/** `CREATE INDEX IF NOT EXISTS` for one or more fields. */
export function buildCreateIndexQuery(
  collection: string,
  fields: readonly IndexField[],
  indexName?: string,
): string {
  const cleaned = normalizeIndexFields(fields);
  const name = indexName ?? makeIndexName(collection, cleaned);
  // The direction is always emitted, even for the ASC default: a composite
  // index's meaning depends on it, and an explicit statement is what shows up
  // in logs when someone is working out why the optimizer skipped it.
  const keys = cleaned
    .map(f => `${quoteFieldPath(f.name)} ${f.ascending ? 'ASC' : 'DESC'}`)
    .join(', ');
  return `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(name, 'index')} `
    + `ON ${quoteIdentifier(collection, 'collection')} (${keys})`;
}

/** `DROP INDEX IF EXISTS <name> ON <collection>`. */
export function buildDropIndexQuery(indexName: string, collection: string): string {
  return `DROP INDEX IF EXISTS ${quoteIdentifier(indexName, 'index')} `
    + `ON ${quoteIdentifier(collection, 'collection')}`;
}

/** Undo backtick-quoting on one stored path segment. SDK 5.1 stores raw
 *  segments; older versions wrapped them. */
function unquoteSegment(segment: string): string {
  if (segment.length >= 2 && segment.startsWith('`') && segment.endsWith('`')) {
    return segment.slice(1, -1).replace(/``/g, '`');
  }
  return segment;
}

/**
 * Read the key list out of a `system:indexes` row's `fields` value.
 *
 * Two shapes exist in the wild:
 *   - SDK 5.1: `[{ key: ['address', 'city'], direction: 'asc' }, …]`
 *   - Older:   `['fieldName', …]`
 *
 * The previous reader took `key[0]` only, so a nested path displayed as its
 * first segment (`address.city` → `address`), and discarded `direction`
 * entirely, so ASC/DESC was never shown.
 */
export function parseIndexKeys(rawFields: unknown): IndexField[] {
  if (!Array.isArray(rawFields)) { return []; }
  const out: IndexField[] = [];
  for (const entry of rawFields) {
    if (typeof entry === 'string') {
      const name = unquoteSegment(entry);
      if (name.length > 0) { out.push({ name, ascending: true }); }
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { continue; }
    const desc = entry as { key?: unknown; direction?: unknown };
    const segments = Array.isArray(desc.key)
      ? desc.key.filter((s): s is string => typeof s === 'string').map(unquoteSegment)
      : [];
    if (segments.length === 0) { continue; }
    const direction = typeof desc.direction === 'string' ? desc.direction.toLowerCase() : 'asc';
    out.push({ name: segments.join('.'), ascending: direction !== 'desc' });
  }
  return out;
}

/** True when two key lists are the same fields, in the same order, with the
 *  same directions. Order matters: a composite index is not the same index
 *  with its keys permuted. */
export function indexKeysMatch(a: readonly IndexField[], b: readonly IndexField[]): boolean {
  if (a.length !== b.length) { return false; }
  return a.every((f, i) => f.name === b[i].name && f.ascending === b[i].ascending);
}

/** `field ASC, other DESC` — for tree labels and log lines. */
export function describeIndexKeys(fields: readonly IndexField[]): string {
  return fields.map(f => `${f.name} ${f.ascending ? 'ASC' : 'DESC'}`).join(', ');
}
