export type QueryInspectorTab = 'history' | 'favorites' | 'json' | 'metrics' | 'help';

export type QueryResultMetadata = {
  /** The user's query string, as run (without EXPLAIN prefix). */
  dql?: string;
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
};

export type InspectorContent =
  | { kind: 'none' }
  | { kind: 'subscriptions'; databaseId: string }
  | { kind: 'peers'; databaseId: string }
  | {
      kind: 'query';
      databaseId: string;
      tab: QueryInspectorTab;
      lastResultMetadata?: QueryResultMetadata;
      selectedRowJson?: string;
    };

export interface DetectedAttachment {
  /** Path from the doc root, e.g. "avatar" or "photos[0]" */
  path: string;
  /** Raw token-like object as-found (passed back to the SDK on fetch). */
  token: { _meta: { id: string; length: number; contentType?: string; filename?: string; [k: string]: unknown } };
  metadata: { id: string; length: number; contentType?: string; filename?: string };
}

/** Walks an arbitrary parsed JSON object/array and returns any `_meta`-shaped attachment tokens. */
export function detectAttachments(value: unknown, path = ''): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];
  walk(value, path, out);
  return out;
}

function walk(v: unknown, path: string, out: DetectedAttachment[]): void {
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (obj._meta && typeof obj._meta === 'object' && (obj._meta as any).id) {
      const m = obj._meta as any;
      out.push({
        path,
        token: obj as DetectedAttachment['token'],
        metadata: { id: m.id, length: m.length, contentType: m.contentType, filename: m.filename },
      });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((el, i) => walk(el, `${path}[${i}]`, out));
    } else {
      for (const [k, val] of Object.entries(obj)) {
        walk(val, path ? `${path}.${k}` : k, out);
      }
    }
  }
}
