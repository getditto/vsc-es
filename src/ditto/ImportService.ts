// src/ditto/ImportService.ts
//
// Port of the SwiftUI ImportService — validates a JSON document array,
// then bulk-inserts via DQL `INSERT INTO <coll> DOCUMENTS
// (deserialize_json(:docK))` with a batch size of 50. On a batch
// failure, falls back to single-doc inserts so the caller learns
// exactly which rows failed (matches the SwiftUI fallback path).
//
// This module deliberately knows nothing about VS Code, the panel, or
// the file system. It takes a query executor + parsed/buffered JSON and
// returns a result; the panel handles file I/O, progress UI, and
// logging. Keeping it pure lets us unit-test the query-builder + batch
// + fallback logic without an SDK or a webview.

import { quoteIdentifier } from './dql-identifier.js';

export type InsertType = 'regular' | 'initial';

export interface ImportProgress {
  /** Documents processed so far (1-based; equals total at completion). */
  current: number;
  /** Total documents in the file. */
  total: number;
  /** _id of the row currently being processed, when surfacable. Undefined
   *  on batch-completion ticks since the batch ran as one unit. */
  currentDocumentId?: string;
}

export interface ImportResult {
  successCount: number;
  failureCount: number;
  /** One human-readable string per failed row. Matches the SwiftUI
   *  surface — caller writes the first into the panel's error pane. */
  errors: string[];
  /** True when the run stopped early because the active database
   *  switched (see ImportOptions.checkActive). Documents already
   *  inserted stay inserted — ON ID CONFLICT DO UPDATE makes a re-run
   *  idempotent. */
  cancelled?: boolean;
}

/** Query executor signature. We accept this as a function rather than
 *  pulling DittoManager so the test suite can pass a fake — same trick
 *  the InspectorController + ImportSubscriptionsPanel use elsewhere. */
export type ExecuteRaw = (query: string, args?: Record<string, unknown>) => Promise<unknown>;

export const DEFAULT_BATCH_SIZE = 50;

export class ImportValidationError extends Error {
  constructor(message: string, readonly kind: 'invalidJson' | 'missingId' | 'invalidCollectionName' | 'encoding') {
    super(message);
    this.name = 'ImportValidationError';
  }
}

/**
 * Parse + validate raw file bytes/text. Returns the array of document
 * objects ready for insert. Throws {@link ImportValidationError} on
 * any structural problem.
 *
 *   - Top-level must be a JSON array
 *   - Each element must be a plain object
 *   - Each element must have an `_id` (string OR any non-undefined value;
 *     SwiftUI checks for non-nil, we mirror that)
 */
export function validateJsonDocuments(raw: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ImportValidationError(
      `File must contain an array of JSON objects (parse error: ${err instanceof Error ? err.message : String(err)})`,
      'invalidJson',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ImportValidationError('File must contain an array of JSON objects', 'invalidJson');
  }
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ImportValidationError(
        `Document at index ${i} is not a JSON object`,
        'invalidJson',
      );
    }
    const obj = item as Record<string, unknown>;
    if (obj._id === undefined || obj._id === null) {
      throw new ImportValidationError(
        `Document at index ${i} is missing required '_id' field`,
        'missingId',
      );
    }
    out.push(obj);
  }
  return out;
}

/** Build the batch INSERT query with N `(deserialize_json(:docK))`
 *  placeholders. Caller is responsible for ensuring `collection` is
 *  validated; the function does NOT re-validate to keep it cheap when
 *  called once per batch. */
export function buildBatchInsertQuery(
  collection: string,
  batchSize: number,
  insertType: InsertType,
): string {
  const placeholders = Array.from({ length: batchSize }, (_, i) => `(deserialize_json(:doc${i}))`).join(', ');
  const target = quoteIdentifier(collection, 'collection');
  if (insertType === 'initial') {
    return `INSERT INTO ${target}\nINITIAL DOCUMENTS ${placeholders}`;
  }
  return `INSERT INTO ${target}\nDOCUMENTS ${placeholders}\nON ID CONFLICT DO UPDATE`;
}

export function buildSingleInsertQuery(collection: string, insertType: InsertType): string {
  const target = quoteIdentifier(collection, 'collection');
  if (insertType === 'initial') {
    return `INSERT INTO ${target}\nINITIAL DOCUMENTS (deserialize_json(:jsonDoc))`;
  }
  return `INSERT INTO ${target}\nDOCUMENTS (deserialize_json(:jsonDoc))\nON ID CONFLICT DO UPDATE`;
}

/** Stringify each document for a batch and pack as `{doc0: ..., doc1: ...}`.
 *  Throws ImportValidationError if any document can't be re-serialised
 *  (extremely unlikely after validateJsonDocuments succeeds, but cycles
 *  or NaN/Infinity in a hand-edited test file would trip it). */
export function buildBatchArguments(batch: readonly Record<string, unknown>[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < batch.length; i += 1) {
    try {
      args[`doc${i}`] = JSON.stringify(batch[i]);
    } catch (err) {
      throw new ImportValidationError(
        `Failed to encode document at index ${i} as JSON: ${err instanceof Error ? err.message : String(err)}`,
        'encoding',
      );
    }
  }
  return args;
}

/**
 * Reject only names that cannot be expressed as a DQL identifier at all.
 *
 * The target is backtick-quoted by the query builders (see dql-identifier),
 * so a hyphen, a space, or a non-ASCII letter is safe and legal — Ditto
 * genuinely allows those collection names, and refusing them locked the user
 * out of importing into a collection they already have. What is left to
 * reject is the empty name and control characters, neither of which is a real
 * collection name and both of which mangle the statement.
 */
export function validateCollectionName(collection: string): void {
  try {
    quoteIdentifier(collection, 'collection');
  } catch (err) {
    throw new ImportValidationError(
      err instanceof Error ? err.message : 'Collection name is not a valid identifier.',
      'invalidCollectionName',
    );
  }
}

/** Pure chunker — copy of SwiftUI's Array.chunked(into:). Exported for
 *  the tests; consumed by importDocuments. */
export function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  if (size <= 0) { throw new RangeError('chunk size must be > 0'); }
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export interface ImportOptions {
  documents: readonly Record<string, unknown>[];
  collection: string;
  insertType: InsertType;
  execute: ExecuteRaw;
  /** Called between batches with cumulative progress. Errors thrown from
   *  the handler are swallowed — progress UI shouldn't be able to abort
   *  the import. */
  onProgress?: (p: ImportProgress) => void;
  /** Override for tests. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
  /** Defense against mid-import database switches: the switch
   *  orchestrator closes the panel but cannot cancel an in-flight
   *  import, and `execute` always resolves against the manager's
   *  CURRENT session. Pass the active-config-id reader; importDocuments
   *  snapshots it at entry and re-polls before each batch, aborting
   *  (with `cancelled: true`) the moment it changes. */
  checkActive?: () => string | null | undefined;
}

/**
 * Run the import. Validates `collection` first (throws on invalid),
 * then walks `documents` in batches; on a batch error, falls back to
 * single-doc inserts so the per-row failure list is meaningful.
 *
 * Documents are NOT re-validated here — caller is responsible for
 * having run `validateJsonDocuments` (so the same parsed array can be
 * shown in a preview before import without double-parsing).
 *
 * Returns a single ImportResult once every document has been
 * attempted, even if every one failed.
 */
export async function importDocuments(opts: ImportOptions): Promise<ImportResult> {
  validateCollectionName(opts.collection);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const total = opts.documents.length;
  let successCount = 0;
  let failureCount = 0;
  const errors: string[] = [];

  const reportProgress = (p: ImportProgress): void => {
    if (!opts.onProgress) { return; }
    try { opts.onProgress(p); } catch { /* progress sink errors don't block import */ }
  };

  // Snapshot the active-config id when a checker was provided. Polled
  // before every batch execute below.
  const activeAtStart = opts.checkActive?.();

  const batches = chunkArray(opts.documents, batchSize);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    // The DB-switch orchestrator can close the panel without cancelling
    // this in-flight import; without this check the remaining batches
    // would silently land in the NEW database.
    if (opts.checkActive && opts.checkActive() !== activeAtStart) {
      const written = successCount + failureCount > 0
        ? ` ${successCount} of ${total} documents were written before the switch.`
        : '';
      errors.push(`Import cancelled — the active database changed mid-import.${written}`);
      return { successCount, failureCount, errors, cancelled: true };
    }
    const batch = batches[batchIndex];
    const batchStartIndex = batchIndex * batchSize;
    const firstId = idOf(batch[0]);

    // Pre-batch progress tick — gives the UI a "now starting doc N" beat
    // before the (possibly slow) execute fires.
    reportProgress({
      current: batchStartIndex + 1,
      total,
      currentDocumentId: firstId,
    });

    try {
      const query = buildBatchInsertQuery(opts.collection, batch.length, opts.insertType);
      const args = buildBatchArguments(batch);
      await opts.execute(query, args);
      successCount += batch.length;
      reportProgress({ current: batchStartIndex + batch.length, total });
    } catch (batchErr) {
      // Batch failed — fall back to single inserts to identify rows.
      // Don't surface the batch error itself; the per-row errors are
      // far more actionable.
      for (let i = 0; i < batch.length; i += 1) {
        const doc = batch[i];
        const globalIndex = batchStartIndex + i;
        const docId = idOf(doc) ?? 'unknown';
        try {
          const query = buildSingleInsertQuery(opts.collection, opts.insertType);
          const args: Record<string, unknown> = { jsonDoc: JSON.stringify(doc) };
          await opts.execute(query, args);
          successCount += 1;
        } catch (rowErr) {
          failureCount += 1;
          errors.push(`Document ${docId} (index ${globalIndex}): ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`);
        }
        reportProgress({
          current: globalIndex + 1,
          total,
          currentDocumentId: docId,
        });
      }
    }
  }

  return { successCount, failureCount, errors };
}

function idOf(doc: Record<string, unknown> | undefined): string | undefined {
  if (!doc) { return undefined; }
  const id = doc._id;
  if (typeof id === 'string') { return id; }
  if (id === undefined || id === null) { return undefined; }
  // A document id can legitimately be a number or a composite object. Only
  // primitives stringify usefully; an object would surface to the user as
  // '[object Object]', so serialise it instead.
  if (typeof id === 'number' || typeof id === 'boolean' || typeof id === 'bigint') {
    return String(id);
  }
  try { return JSON.stringify(id); } catch { return undefined; }
}
