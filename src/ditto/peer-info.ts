import type {
  ConnectionInfo,
  ConnectionTypeV2,
  PeerInfo,
  PeerListSnapshot,
  PeerOSv2,
  SyncSessionStatus,
  LocalPeerInfo,
} from '../models/DittoConfig.js';

// ─── Sync status row (parsed from __sync_status DQL emissions) ──

export interface SyncStatusRow {
  _id: string;
  is_ditto_server: boolean;
  sync_session_status: SyncSessionStatus;
  synced_up_to_local_commit_id?: number;
  last_update_received_time?: number;
}

const SYNC_SESSION_STATUSES: readonly SyncSessionStatus[] = [
  'Connected',
  'Connecting',
  'Disconnected',
  'Unknown',
];

function coerceSessionStatus(raw: unknown): SyncSessionStatus {
  if (typeof raw === 'string' && (SYNC_SESSION_STATUSES as readonly string[]).includes(raw)) {
    return raw as SyncSessionStatus;
  }
  return 'Unknown';
}

export function parseSyncStatusRow(raw: unknown): SyncStatusRow | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const r = raw as Record<string, any>;
  if (typeof r._id !== 'string') { return null; }
  const docs = (r.documents && typeof r.documents === 'object') ? r.documents as Record<string, any> : {};
  return {
    _id: r._id,
    is_ditto_server: r.is_ditto_server === true,
    sync_session_status: coerceSessionStatus(docs.sync_session_status),
    synced_up_to_local_commit_id: typeof docs.synced_up_to_local_commit_id === 'number'
      ? docs.synced_up_to_local_commit_id
      : undefined,
    last_update_received_time: typeof docs.last_update_received_time === 'number'
      ? docs.last_update_received_time
      : undefined,
  };
}

// ─── Presence graph adapter ──────────────────────────────────────

interface PresencePeerLike {
  peerKey: string;
  deviceName: string;
  os?: PeerOSv2;
  dittoSdkVersion?: string;
  connections: Array<{ id: string; connectionType: ConnectionTypeV2; peer1: string; peer2: string }>;
  peerMetadata: Record<string, unknown>;
  identityServiceMetadata: Record<string, unknown>;
  isConnectedToDittoServer: boolean;
}

interface PresenceGraphLike {
  localPeer: PresencePeerLike;
  remotePeers: PresencePeerLike[];
}

function toConnections(raw: PresencePeerLike['connections']): ConnectionInfo[] {
  return raw.map(c => ({
    id: c.id,
    connectionType: c.connectionType,
    peer1: c.peer1,
    peer2: c.peer2,
  }));
}

function toPeerInfo(peer: PresencePeerLike, syncRow: SyncStatusRow | undefined): PeerInfo {
  const isDittoServer = syncRow?.is_ditto_server ?? peer.isConnectedToDittoServer;
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
    connections: toConnections(peer.connections),
    syncSessionStatus: syncRow?.sync_session_status ?? 'Unknown',
    syncedUpToLocalCommitId: syncRow?.synced_up_to_local_commit_id,
    lastUpdateReceivedTime: syncRow?.last_update_received_time,
  };
}

export function mergePeerList(
  presence: PresenceGraphLike,
  syncStatusByPeerKey: Map<string, SyncStatusRow>,
  local: LocalPeerInfo | null,
  previousOrder: readonly string[],
): PeerListSnapshot {
  const byId = new Map<string, PeerInfo>();
  for (const peer of presence.remotePeers) {
    byId.set(peer.peerKey, toPeerInfo(peer, syncStatusByPeerKey.get(peer.peerKey)));
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

const TYPE_PRIORITY: ConnectionTypeV2[] = ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'];

export function dominantConnectionType(peer: PeerInfo): DominantType {
  if (peer.isDittoServer) { return 'cloud'; }
  for (const t of TYPE_PRIORITY) {
    if (peer.connections.some(c => c.connectionType === t)) { return t; }
  }
  return 'unknown';
}
