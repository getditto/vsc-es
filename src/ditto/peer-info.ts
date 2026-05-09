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
  sync_session_status?: SyncSessionStatus;
  synced_up_to_local_commit_id?: number;
  last_update_received_time?: number;
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
  const r = raw as Record<string, any>;
  if (typeof r._id !== 'string') { return null; }
  const docs = (r.documents && typeof r.documents === 'object') ? r.documents as Record<string, any> : {};
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
  // aren't in the presence graph. Stricter than SwiftUI's "skip if Disconnected"
  // — we only render cloud peers whose status is explicitly Connected or
  // Connecting. Anything else (Disconnected, or undefined because the SDK
  // returned "Not Connected" / a value we couldn't parse) means the cloud
  // session isn't active and the card should disappear. This is what makes
  // the cloud row vanish when the user toggles sync off.
  for (const [peerId, syncRow] of syncStatusByPeerKey) {
    if (!syncRow.is_ditto_server) { continue; }
    if (byId.has(peerId)) { continue; }
    const status = syncRow.sync_session_status;
    if (status !== 'Connected' && status !== 'Connecting') { continue; }
    byId.set(peerId, toCloudPeerInfo(syncRow));
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

  return { local, remote: ordered };
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
