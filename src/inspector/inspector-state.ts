import type { QueryProfile } from '../ditto/QueryProfile.js';

export type QueryInspectorTab = 'history' | 'favorites' | 'json' | 'metrics' | 'help';

export type QueryResultMetadata = {
  /** The user's query string, as run (without EXPLAIN prefix). */
  dql?: string;
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
  /** Where the query ran. `'local'` → active SDK store; `'http'` → REST
   *  API via /api/v5/store/execute. Surfaced on the Metrics tab so a
   *  20 ms vs 200 ms difference reads as "different transport" rather
   *  than "the same query somehow got slower". */
  location?: 'local' | 'http';
  /** Parsed execution-plan profile, captured when the local SDK path
   *  prefixed the query with `PROFILE`. Undefined for HTTP runs,
   *  non-SELECT statements, queries the user already prefixed with
   *  PROFILE, and any case where Ditto didn't emit a parseable
   *  envelope (forward-compatible degrade). */
  profile?: QueryProfile;
};

export type InspectorContent =
  | { kind: 'none' }
  | { kind: 'subscriptions'; databaseId: string }
  | { kind: 'peers'; databaseId: string }
  | { kind: 'metrics'; databaseId: string }
  | { kind: 'databaseMetrics'; databaseId: string }
  | {
      kind: 'query';
      databaseId: string;
      tab: QueryInspectorTab;
      lastResultMetadata?: QueryResultMetadata;
      selectedRowJson?: string;
    };

/** SDK attachment token as found in document fields. The Node SDK
 *  emits `{ id, len, metadata }` directly — earlier versions of this
 *  module looked for a `_meta` wrapper, which was speculation that
 *  never matched real data and silently broke fetch.
 *  See node_modules/@dittolive/ditto/types/ditto.d.ts → fetchAttachment
 *  for the canonical shape. */
export interface AttachmentTokenShape {
  id: string;
  len: number;
  metadata: Record<string, string>;
}

export interface DetectedAttachment {
  /** Path from the doc root, e.g. "avatar" or "photos[0]" */
  path: string;
  /** Raw token object as-found, passed straight back to the SDK on
   *  fetch (the SDK accepts the same shape it emitted). */
  token: AttachmentTokenShape;
  /** Normalised view: `id`, `length`, `contentType`, `filename`. The
   *  metadata keys vary across writers — SwiftUI uses `mimeType`/
   *  `name`, the SDK docs use `contentType`/`filename`. We accept all
   *  variants here so the viewer doesn't show "?" for valid tokens. */
  metadata: { id: string; length: number; contentType?: string; filename?: string };
}

/** True when an object looks like an attachment token from any known
 *  writer. The discriminator is the `{id: string, len: number,
 *  metadata: object}` triple — string `id` and numeric `len` are both
 *  required to avoid false-positives on plain documents that happen to
 *  have an `id` field. */
function isAttachmentToken(obj: Record<string, unknown>): obj is AttachmentTokenShape & Record<string, unknown> {
  if (typeof obj.id !== 'string') { return false; }
  if (typeof obj.len !== 'number' && typeof obj.len !== 'bigint') { return false; }
  if (!obj.metadata || typeof obj.metadata !== 'object' || Array.isArray(obj.metadata)) { return false; }
  return true;
}

/** Pull the contentType from an attachment's metadata bag, accepting
 *  any of the keys real-world writers have used. */
export function attachmentContentType(meta: Record<string, unknown>): string | undefined {
  const m = meta as Record<string, string | undefined>;
  return m.mimeType ?? m.contentType ?? m.mime_type ?? m.type;
}

/** Pull the filename from an attachment's metadata bag, accepting any
 *  of the keys real-world writers have used. */
export function attachmentFilename(meta: Record<string, unknown>): string | undefined {
  const m = meta as Record<string, string | undefined>;
  return m.name ?? m.filename ?? m.fileName ?? m.file_name;
}

/** Walks an arbitrary parsed JSON object/array and returns any
 *  attachment-token-shaped objects. Recurses through nested objects
 *  and arrays so attachments stored under sub-paths still surface. */
export function detectAttachments(value: unknown, path = ''): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];
  walk(value, path, out);
  return out;
}

function walk(v: unknown, path: string, out: DetectedAttachment[]): void {
  if (!v || typeof v !== 'object') { return; }
  if (Array.isArray(v)) {
    v.forEach((el, i) => walk(el, `${path}[${i}]`, out));
    return;
  }
  const obj = v as Record<string, unknown>;
  if (isAttachmentToken(obj)) {
    const meta = obj.metadata;
    out.push({
      path,
      token: { id: obj.id, len: Number(obj.len), metadata: meta as Record<string, string> },
      metadata: {
        id: obj.id,
        length: Number(obj.len),
        contentType: attachmentContentType(meta),
        filename: attachmentFilename(meta),
      },
    });
    return;
  }
  for (const [k, val] of Object.entries(obj)) {
    walk(val, path ? `${path}.${k}` : k, out);
  }
}
