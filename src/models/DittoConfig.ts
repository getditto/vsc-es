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
