import { detectPlatform, transportSupportFor } from '../util/platform.js';

export type AuthMode = 'server' | 'smallPeersOnly';

/**
 * Log level values accepted by the Ditto SDK's `Logger.minimumLogLevel`.
 * Distinct from the host-side `LogLevel` in `src/logging/types.ts`
 * (`'warn'`/`'trace'` instead of `'warning'`/`'verbose'`); convert at boundaries.
 */
export type SdkLogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';

export interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: AuthMode;
  authUrl: string;
  websocketUrl: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: SdkLogLevel;
  isStrictModeEnabled: boolean;
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
    websocketUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false,
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

export type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';

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
  os?: PeerOS;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
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
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}
