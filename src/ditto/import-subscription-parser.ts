import type { StoredSubscription } from '../models/DittoConfig.js';

/**
 * Wire shape returned by `SELECT * FROM __small_peer_info` against the
 * Ditto Server's `/api/v5/store/execute` endpoint. Field names are
 * snake_case to match the JSON the server emits — we intentionally keep
 * the camelCase boundary inside {@link toImportableSubscriptions} rather
 * than spreading it across consumers.
 */
export interface SmallPeerInfo {
  _id: string;
  device_name?: string;
  ditto_sdk_language?: string;
  ditto_sdk_platform?: string;
  ditto_sdk_version?: string;
  local_subscriptions?: {
    queries?: { query: string }[];
  };
}

/** A subscription that the user can choose to import — one row in the picker. */
export interface ImportableSubscription {
  /** Stable id derived from query text so re-runs of the parser yield identical IDs. */
  id: string;
  /** Friendly device label (`device_name` if set, otherwise the peer id). */
  deviceName: string;
  /** Concise SDK descriptor like "iOS 4.7.0". */
  deviceInfo: string;
  /** Collection name extracted from the query. */
  collectionName: string;
  /** Raw DQL query string. */
  query: string;
}

/**
 * Extract the collection name from a DQL query — handles both the bare
 * `SELECT … FROM tasks` form and the explicit `SELECT … FROM COLLECTION tasks`
 * form. Returns `null` if no `FROM` clause is found, in which case the
 * subscription is unimportable (we have nothing meaningful to label it with).
 *
 * The name is returned VERBATIM, including backticks when the query quoted it
 * (``SELECT * FROM `my coll` `` → `` `my coll` ``) — callers that build
 * display strings use it as-is; callers that re-emit DQL must unquote and
 * re-quote (see QueryEditorPanel's attachment actions). A whitespace-first
 * split would cut a quoted name containing a space in half, so the name is
 * extracted in a single regex.
 *
 * Mirrors the SwiftUI implementation in
 * `SwiftUI/EdgeStudio/Models/SmallPeerInfoModels.swift` so server-side
 * subscription strings parse identically across clients.
 */
export function extractCollectionName(query: string): string | null {
  const m = /(?:^|\s)FROM\s+(?:COLLECTION\s+)?(`(?:[^`]|``)*`|\S+)/i.exec(query);
  return m ? m[1] : null;
}

/** A query targets a Ditto-internal collection (those with the `__` prefix). */
export function isSystemCollection(collectionName: string): boolean {
  return collectionName.startsWith('__');
}

/**
 * Convert a list of peer reports into a deduplicated, filtered list of
 * subscriptions the user can import. The filter rules match the SwiftUI
 * implementation:
 *
 *   1. Subscriptions that already exist locally (same `query` string) are
 *      hidden — re-importing them would just create dupes.
 *   2. System collections (`__*`) are hidden — those are SDK-internal and
 *      not meaningful to subscribe from a client.
 *   3. Within this import session, identical query strings from different
 *      peers collapse to a single row — we keep the first peer that
 *      reported the query so the row still has a sensible device label.
 *
 * `_id` of the importable row is derived from the query text via
 * ``import:${query}``. This makes the IDs stable across re-renders of the
 * picker, which lets the webview keep checkbox state across re-fetches.
 */
export function toImportableSubscriptions(
  peerInfos: readonly SmallPeerInfo[],
  existingSubscriptions: readonly StoredSubscription[],
): ImportableSubscription[] {
  const existingQueries = new Set(existingSubscriptions.map((s) => s.query));
  const seen = new Set<string>();
  const out: ImportableSubscription[] = [];

  for (const peer of peerInfos) {
    const queries = peer.local_subscriptions?.queries;
    if (!queries) { continue; }

    const deviceName = peer.device_name && peer.device_name.length > 0
      ? peer.device_name
      : peer._id;
    const platform = peer.ditto_sdk_platform ?? 'Unknown';
    const version = peer.ditto_sdk_version ?? '';
    const deviceInfo = `${platform} ${version}`.trim();

    for (const q of queries) {
      const collectionName = extractCollectionName(q.query);
      if (!collectionName) { continue; }
      if (isSystemCollection(collectionName)) { continue; }
      if (existingQueries.has(q.query)) { continue; }
      if (seen.has(q.query)) { continue; }

      seen.add(q.query);
      out.push({
        id: `import:${q.query}`,
        deviceName,
        deviceInfo,
        collectionName,
        query: q.query,
      });
    }
  }

  return out;
}
