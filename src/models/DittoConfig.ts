import { detectPlatform, transportSupportFor } from '../util/platform.js';

type AuthMode = 'server' | 'smallPeersOnly';

/**
 * Log level values accepted by the Ditto SDK's `Logger.minimumLogLevel`.
 * Distinct from the host-side `LogLevel` in `src/logging/types.ts`
 * (`'warn'`/`'trace'` instead of `'warning'`/`'verbose'`); convert at boundaries.
 */
export type SdkLogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';

export type CollectionSyncScope =
  | 'AllPeers'
  | 'BigPeerOnly'
  | 'SmallPeersOnly'
  | 'LocalPeerOnly';

export interface CollectionSyncScopeEntry {
  collection: string;
  scope: CollectionSyncScope;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SystemSetting =
  | { parameter: string; type: 'boolean'; value: boolean }
  | { parameter: string; type: 'integer'; value: number }
  | { parameter: string; type: 'string'; value: string }
  | { parameter: string; type: 'json'; value: JsonValue };

export interface SystemSettingOption {
  parameter: string;
  type: SystemSetting['type'];
  value: SystemSetting['value'];
}

/** Container for connection settings that are intentionally hidden from the
 *  default registration flow. Keep this extensible as more advanced SDK
 *  configuration is exposed by the editor. */
interface AdvancedConfig {
  collectionSyncScopes?: CollectionSyncScopeEntry[];
  systemSettings?: SystemSetting[];
  /**
   * Run the embedded MCP server (loopback HTTP; see docs/MCP_SERVER.md)
   * while THIS connection is active. Default false: the server lets any
   * local process drive the database (reads AND writes), so it must be an
   * explicit per-database opt-in. Not an SDK setting — evaluated by the
   * McpServerController on lifecycle changes, no reconnect needed.
   */
  mcpServerEnabled?: boolean;
}

export interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: AuthMode;
  authUrl: string;
  /**
   * Legacy: Ditto Portal historically exposed an explicit Websocket URL,
   * which we collected here. The Portal no longer provides it and the SDK
   * derives sync endpoints from `authUrl`, so this field is unused for new
   * connections. Kept optional so previously-stored configs read back
   * cleanly without migration.
   */
  websocketUrl?: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: SdkLogLevel;
  isStrictModeEnabled: boolean;
  /** Optional for backward compatibility with configs saved before DA-198. */
  advancedConfig?: AdvancedConfig;
  /**
   * Per-DB transport prefs. Optional so previously-stored configs read
   * back transparently with `?? defaults` at the call site. Defaults are
   * computed from the current platform's `transportSupportFor()` matrix in
   * {@link newConfig}.
   */
  isLanEnabled?: boolean;
  isBluetoothLeEnabled?: boolean;
  isAwdlEnabled?: boolean;
}

export interface SecretSet {
  token: string;
  secretKey?: string;
  httpApiKey?: string;
}

export function newConfig(): StoredDittoConfig {
  // Compute platform-safe transport defaults so a freshly-registered
  // connection never silently turns on a transport the OS can't run
  // (e.g. AWDL on Linux). For Linux we get LAN-only; Windows adds BLE;
  // macOS adds AWDL.
  const support = transportSupportFor(detectPlatform());
  return {
    id: '',
    name: '',
    databaseId: '',
    mode: 'server',
    authUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false,
    advancedConfig: { collectionSyncScopes: [], systemSettings: [] },
    isLanEnabled: true,
    isBluetoothLeEnabled: support.bluetoothLE,
    isAwdlEnabled: support.awdl,
  };
}

export interface StoredSubscription {
  id: string;
  name: string;
  query: string;
}

// ─── v2 typed presence model ─────────────────────────────────

export type PeerOS = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';

/** Transport reported by the Ditto presence graph. Multicast edges are
 * learned from the mesh even though the Node SDK cannot configure them. */
export type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth' | 'Multicast';

export type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected';

export interface ConnectionInfo {
  id: string;
  connectionType: ConnectionType;
  peer1: string;
  peer2: string;
}

export interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOS | undefined;
  dittoSdkVersion?: string | undefined;
  peerMetadata?: Record<string, unknown> | undefined;
  identityMetadata?: Record<string, unknown> | undefined;
  /** Presence-graph field renamed from `isConnectedToDittoCloud` in SDK 5.0 —
   *  "this peer has a cloud link", NOT "this peer is the Big Peer" (that is
   *  `isDittoServer`). Feeds the detail card's Cloud link row. */
  isConnectedToDittoServer?: boolean | undefined;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number | undefined;
  lastUpdateReceivedTime?: number | undefined;
}

export interface LocalPeerInfo {
  /** Stable peer-key for this device — `presenceGraph.localPeer.peerKey`.
   *  Needed so the network-graph webview can use it as the BFS root
   *  and recognise edges that involve "this device" without having
   *  to derive the key from a connection's peer1/peer2 (which fails
   *  when the device isn't currently connected to anyone). */
  peerKey: string;
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
  /** Presence-graph enrichment stamped by DittoManager.firePresence once a
   *  real presence graph has arrived (os / cloud link / metadata key
   *  counts) so the local peer's detail card reports the same facts as a
   *  remote peer's. Metadata ships as COUNTS, not bodies: the detail card
   *  only ever renders "N keys", and the raw values cross the napi boundary
   *  unvalidated (a BigInt would detonate the panel's JSON fingerprint). */
  os?: PeerOS | undefined;
  isConnectedToDittoServer?: boolean | undefined;
  peerMetadataKeyCount?: number | undefined;
  identityMetadataKeyCount?: number | undefined;
}

/**
 * One remote peer as reported by the SDK presence graph. Unlike the
 * merged `PeerInfo` rows, these are available for MULTI-HOP peers too —
 * the presence graph reports the same shape for every peer it knows.
 * That is exactly what the Presence Graph's detail card needs: a focus
 * orbit is the *focused* peer's neighbourhood, so most of it is usually
 * not directly connected to this device.
 */
interface RawPresenceGraphPeer {
  peerKey: string;
  deviceName: string;
  os?: PeerOS | undefined;
  dittoSdkVersion?: string | undefined;
  /** See `PeerInfo.isConnectedToDittoServer`. */
  isConnectedToDittoServer: boolean;
  /** `undefined` while the SDK has not determined compatibility. */
  isCompatible?: boolean | undefined;
  /** Top-level key counts, computed host-side. The detail card only ever
   *  shows "N keys", so the (unvalidated, up to 4 KB each) metadata bodies
   *  for multi-hop peers stay off the wire entirely. */
  peerMetadataKeyCount: number;
  identityMetadataKeyCount: number;
}

/**
 * Compact representation of the raw SDK presence graph — peers + the
 * full set of edges between them, no per-local filtering. Used ONLY
 * by the Presence Graph webview when the user has "Direct Connected
 * only" turned off; the regular Peers List ignores this and reads
 * `remote` as before. We send it inline on `peer.state` rather than
 * via a separate IPC so the graph re-renders in lockstep with the
 * peer cards on every presence event.
 */
interface RawPresenceGraph {
  remotePeers: RawPresenceGraphPeer[];
  /** Undirected edges as the SDK reports them. Includes peer↔peer
   *  edges that don't involve local. Caller is responsible for the
   *  same (pair-sorted + type) dedupe the listing card does. */
  connections: { peer1: string; peer2: string; connectionType: ConnectionType }[];
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  /** Direct-only peer list with per-peer connections filtered to
   *  edges that involve local. Drives the Peers List tab. */
  remote: PeerInfo[];
  /** Optional full presence graph (no direct-only filter, all edges).
   *  Populated when the manager has a real presence snapshot; absent
   *  for the synthetic "no active session" payload. */
  presenceGraph?: RawPresenceGraph | undefined;
}
