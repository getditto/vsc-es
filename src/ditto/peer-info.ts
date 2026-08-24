import type {
  ConnectionInfo,
  ConnectionType,
  PeerInfo,
  PeerListSnapshot,
  PeerOS,
  SyncSessionStatus,
  LocalPeerInfo,
} from '../models/DittoConfig.js';

// ─── Sync status row (parsed from __sync_status DQL emissions) ──

export interface SyncStatusRow {
  _id: string;
  is_ditto_server: boolean;
  /** May be undefined when the SDK row arrived without a recognized status —
   *  the merge layer treats presence-graph peers as 'Connected' in that case. */
  sync_session_status?: SyncSessionStatus | undefined;
  synced_up_to_local_commit_id?: number | undefined;
  last_update_received_time?: number | undefined;
}

const SYNC_SESSION_STATUSES: readonly SyncSessionStatus[] = [
  'Connected',
  'Connecting',
  'Disconnected',
];

function coerceSessionStatus(raw: unknown): SyncSessionStatus | undefined {
  if (typeof raw === 'string') {
    if ((SYNC_SESSION_STATUSES as readonly string[]).includes(raw)) {
      return raw as SyncSessionStatus;
    }
    // The SDK reports a stopped/dropped session as "Not Connected" (with a
    // space) — semantically the same as Disconnected for our purposes. Map
    // it so pass-2 cloud-peer filtering catches stopped Cloud Servers.
    if (raw === 'Not Connected') { return 'Disconnected'; }
  }
  return undefined;
}

/**
 * Coerce a numeric field that may arrive as `number` or `bigint` (the Ditto
 * Node SDK returns large integers from DQL as bigint). A strict
 * `typeof === 'number'` would silently drop them — that's why our peer cards
 * had no commitId or last-update timestamps before this fix.
 */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) { return v; }
  if (typeof v === 'bigint') { return Number(v); }
  return undefined;
}

export function parseSyncStatusRow(raw: unknown): SyncStatusRow | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const r = raw as Record<string, unknown>;
  if (typeof r._id !== 'string') { return null; }
  const docs = (r.documents && typeof r.documents === 'object') ? r.documents as Record<string, unknown> : {};
  return {
    _id: r._id,
    is_ditto_server: r.is_ditto_server === true,
    // Coerced to a known status or undefined; the merge layer decides the
    // fallback (presence-graph peers default to 'Connected').
    sync_session_status: coerceSessionStatus(docs.sync_session_status),
    synced_up_to_local_commit_id: asNumber(docs.synced_up_to_local_commit_id),
    last_update_received_time: asNumber(docs.last_update_received_time),
  };
}

// ─── Presence graph adapter ──────────────────────────────────────

interface PresencePeerLike {
  peerKey: string;
  deviceName: string;
  os?: PeerOS;
  dittoSdkVersion?: string;
  connections: Array<{ id: string; connectionType: ConnectionType; peer1: string; peer2: string }>;
  peerMetadata: Record<string, unknown>;
  identityServiceMetadata: Record<string, unknown>;
  isConnectedToDittoServer: boolean;
}

interface PresenceGraphLike {
  localPeer: PresencePeerLike;
  remotePeers: PresencePeerLike[];
}

/**
 * Filter a peer's connections to only those where the local peer is a direct
 * endpoint, then deduplicate by connectionType (the SDK returns A→B and B→A
 * as separate Connection objects with the same type but different IDs).
 *
 * Mirrors `extractPeerEnrichment` in the SwiftUI Edge Studio
 * (SystemRepository.swift lines 147-177): keep first-seen per type.
 */
function filterAndDedupeConnections(
  raw: PresencePeerLike['connections'],
  localKey: string,
): ConnectionInfo[] {
  const direct = raw.filter(c => c.peer1 === localKey || c.peer2 === localKey);
  const seenTypes = new Set<string>();
  const result: ConnectionInfo[] = [];
  for (const c of direct) {
    if (seenTypes.has(c.connectionType)) { continue; }
    seenTypes.add(c.connectionType);
    result.push({
      id: c.id,
      connectionType: c.connectionType,
      peer1: c.peer1,
      peer2: c.peer2,
    });
  }
  return result;
}

function toPeerInfo(
  peer: PresencePeerLike,
  syncRow: SyncStatusRow | undefined,
  localKey: string,
): PeerInfo {
  // Match SwiftUI: default to `false` when no sync row matches.
  // Do NOT fall back to `peer.isConnectedToDittoServer` — that field means
  // "this peer connects to a Ditto Server", not "this peer IS the server".
  // In a cloud-attached mesh, every peer has it set to true, which would
  // wrongly paint every card with the cloud gradient.
  const isDittoServer = syncRow?.is_ditto_server ?? false;
  const peerMetadata = Object.keys(peer.peerMetadata).length > 0 ? peer.peerMetadata : undefined;
  const identityMetadata = Object.keys(peer.identityServiceMetadata).length > 0
    ? peer.identityServiceMetadata
    : undefined;
  return {
    id: peer.peerKey,
    isDittoServer,
    deviceName: peer.deviceName,
    os: peer.os,
    dittoSdkVersion: peer.dittoSdkVersion,
    peerMetadata,
    identityMetadata,
    connections: filterAndDedupeConnections(peer.connections, localKey),
    // Presence-graph peers are presumed Connected until sync_status says
    // otherwise — matches SwiftUI's pass-1 behavior of synthesizing
    // 'Connected' when sync metrics haven't arrived yet.
    syncSessionStatus: syncRow?.sync_session_status ?? 'Connected',
    syncedUpToLocalCommitId: syncRow?.synced_up_to_local_commit_id,
    lastUpdateReceivedTime: syncRow?.last_update_received_time,
  };
}

/**
 * Build a synthetic peer for the Ditto Cloud Server. Cloud peers don't appear
 * in the presence graph — they live only in `__sync_status`. SwiftUI does this
 * in a "second pass" over sync metrics; we mirror that.
 */
function toCloudPeerInfo(syncRow: SyncStatusRow): PeerInfo {
  return {
    id: syncRow._id,
    isDittoServer: true,
    deviceName: 'Ditto Cloud Server',
    os: undefined,
    dittoSdkVersion: undefined,
    peerMetadata: undefined,
    identityMetadata: undefined,
    // No graph-level connections; the cloud relationship is implicit.
    // dominantConnectionType() routes purely on isDittoServer.
    connections: [],
    syncSessionStatus: syncRow.sync_session_status ?? 'Connected',
    syncedUpToLocalCommitId: syncRow.synced_up_to_local_commit_id,
    lastUpdateReceivedTime: syncRow.last_update_received_time,
  };
}

export function mergePeerList(
  presence: PresenceGraphLike,
  syncStatusByPeerKey: Map<string, SyncStatusRow>,
  local: LocalPeerInfo | null,
  previousOrder: readonly string[],
  /** When false, suppress all cloud peers regardless of what
   *  `system:data_sync_info` reports — the SDK is slow to reflect
   *  `sync.stop()` in that collection, and the user expects the cloud
   *  card to disappear the moment they hit Stop Sync. */
  syncActive: boolean = true,
): PeerListSnapshot {
  // SwiftUI parity: presenceGraph.remotePeers includes multihop peers (X→Y→Z).
  // Only keep peers where the local device is an endpoint of at least one
  // connection. See SystemRepository.swift:231-235.
  const localKey = presence.localPeer.peerKey;
  const directRemotePeers = presence.remotePeers.filter(peer =>
    peer.connections.some(c => c.peer1 === localKey || c.peer2 === localKey)
  );

  const byId = new Map<string, PeerInfo>();
  // Pass 1: presence-graph peers, enriched with sync-status metrics by id.
  for (const peer of directRemotePeers) {
    byId.set(peer.peerKey, toPeerInfo(peer, syncStatusByPeerKey.get(peer.peerKey), localKey));
  }

  // Pass 2: surface Ditto Cloud Server peers from system:data_sync_info that
  // aren't in the presence graph. Two filters before adding the row:
  //   1. Local sync must be active. The SDK doesn't promptly update
  //      sync_session_status to "Not Connected" when the user stops sync,
  //      so we override based on the manager's syncState authoritatively.
  //   2. The row's status must be explicitly Connected or Connecting.
  //      Anything else (Disconnected, undefined, future SDK strings) means
  //      the cloud session isn't running and the card shouldn't render.
  if (syncActive) {
    for (const [peerId, syncRow] of syncStatusByPeerKey) {
      if (!syncRow.is_ditto_server) { continue; }
      if (byId.has(peerId)) { continue; }
      const status = syncRow.sync_session_status;
      if (status !== 'Connected' && status !== 'Connecting') { continue; }
      byId.set(peerId, toCloudPeerInfo(syncRow));
    }
  }

  // Order preservation:
  // 1. previous peers still present, in original order.
  // 2. new peers (not in previousOrder) appended.
  const ordered: PeerInfo[] = [];
  for (const id of previousOrder) {
    const info = byId.get(id);
    if (info) {
      ordered.push(info);
      byId.delete(id);
    }
  }
  for (const info of byId.values()) {
    ordered.push(info);
  }

  // Build the unfiltered presence-graph view alongside the
  // direct-only `ordered` list. The Presence Graph webview reads
  // this when the user has "Direct Connected only" turned off so
  // multi-hop peers (X→Y→Z where Z isn't a direct neighbour of
  // local) surface visually. Edges are pair-sorted + type-deduped
  // because the SDK emits A→B and B→A as separate Connection
  // objects with the same type.
  const presenceGraph = buildPresenceGraphView(presence);

  return { local, remote: ordered, presenceGraph };
}

function buildPresenceGraphView(
  presence: PresenceGraphLike,
): PeerListSnapshot['presenceGraph'] {
  // Pass 1: collect deduped edges. The SDK emits A→B and B→A as
  // separate Connection objects with the same type — pair-sorted +
  // type key folds those into a single edge.
  const seen = new Set<string>();
  const connections: Array<{
    peer1: string; peer2: string;
    connectionType: ConnectionType;
  }> = [];
  const peersInAnyEdge = new Set<string>();
  for (const peer of presence.remotePeers) {
    for (const c of peer.connections) {
      if (!c.peer1 || !c.peer2) { continue; }
      const pair = [c.peer1, c.peer2].sort().join('|');
      const key = `${pair}|${c.connectionType}`;
      if (seen.has(key)) { continue; }
      seen.add(key);
      connections.push({ peer1: c.peer1, peer2: c.peer2, connectionType: c.connectionType });
      peersInAnyEdge.add(c.peer1);
      peersInAnyEdge.add(c.peer2);
    }
  }

  // Pass 2: only emit remote peers that participate in at least one
  // edge of the graph. Without this filter, the unfiltered ("Direct
  // Connected only" toggle = off) view shows orphan pills floating at
  // the outermost ring whenever the SDK has discovered a peer over
  // mDNS/BLE but hasn't (re)established a sync session — most
  // commonly observed in the window right after `sync.stop()` →
  // `sync.start()`, where transports stay alive across the toggle but
  // sync sessions don't. Filtering on "appears in at least one edge"
  // is preferred to dropping the peer if it has no `connections`
  // array entries directly, because peer X might only be reachable
  // via its appearance as peer2 in peer Y's connection list — we
  // still want to draw X when Y advertises an edge to it.
  const remotePeers = presence.remotePeers
    .filter(p => peersInAnyEdge.has(p.peerKey))
    .map(p => ({ peerKey: p.peerKey, deviceName: p.deviceName }));

  return { remotePeers, connections };
}

// ─── Connection-type priority (drives card gradient) ─────────────

export type DominantType = 'cloud' | 'WebSocket' | 'AccessPoint' | 'P2PWiFi' | 'Bluetooth' | 'unknown';

const TYPE_PRIORITY: ConnectionType[] = ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'];

export function dominantConnectionType(peer: PeerInfo): DominantType {
  if (peer.isDittoServer) { return 'cloud'; }
  for (const t of TYPE_PRIORITY) {
    if (peer.connections.some(c => c.connectionType === t)) { return t; }
  }
  return 'unknown';
}
