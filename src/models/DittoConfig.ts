export type AuthMode = 'server' | 'smallPeersOnly';
export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';

export interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: AuthMode;
  authUrl: string;
  websocketUrl: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: LogLevel;
  isStrictModeEnabled: boolean;
}

export interface SecretSet {
  token: string;
  secretKey?: string;
  httpApiKey?: string;
}

export function newConfig(): StoredDittoConfig {
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
    isStrictModeEnabled: false
  };
}

export interface StoredSubscription {
  id: string;
  name: string;
  query: string;
}

export interface PeerSnapshot {
  local: LocalPeer | null;
  remote: RemotePeer[];
}

export interface LocalPeer {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

export interface RemotePeer {
  id: string;
  deviceName?: string;
  sdkVersion?: string;
  os?: 'iOS' | 'android' | 'macOS' | 'linux' | 'windows' | 'unknown';
  connections: Array<{
    type: 'webSocket' | 'lan' | 'bluetooth' | 'p2pWiFi' | 'unknown';
    address?: string;
  }>;
  lastUpdate: number;
}

// ─── v2 typed presence model ─────────────────────────────────
// SDK 5.0 presence graph types — matches `Peer` and `Connection`
// from @dittolive/ditto/types/ditto.d.ts. The legacy `LocalPeer` /
// `RemotePeer` / `PeerSnapshot` above are scheduled for removal in
// the v2 cutover (see plan task 4).

export type PeerOSv2 = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';

export type ConnectionTypeV2 = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';

export type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected' | 'Unknown';

export interface ConnectionInfo {
  id: string;
  connectionType: ConnectionTypeV2;
  peer1: string;
  peer2: string;
}

export interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOSv2;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
}

export interface LocalPeerInfo {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}
