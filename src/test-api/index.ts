import * as vscode from 'vscode';
import type { StoredDittoConfig, SecretSet } from '../models/DittoConfig.js';
import { newConfig } from '../models/DittoConfig.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';

/**
 * Bounded test surface for the extension. Exposed from `activate()` only
 * when `process.env.DITTO_CI_MODE === '1'`. Never available to end users.
 */
export interface TestApi {
  registerFromEnv(): Promise<string>;
  connect(configId: string): Promise<void>;
  disconnect(): Promise<void>;
  waitForPeerOrSyncStatus(timeoutMs: number): Promise<void>;
}

const REQUIRED_ENV_KEYS = [
  'DITTO_CI_DATABASE_ID',
  'DITTO_CI_DEVELOPMENT_TOKEN',
  'DITTO_CI_URL',
  'DITTO_CI_WEBSOCKET_URL',
] as const;

type EnvShape = Partial<Record<string, string | undefined>>;

export function buildConfigFromEnv(env: EnvShape): {
  config: StoredDittoConfig;
  secrets: SecretSet;
} {
  for (const key of REQUIRED_ENV_KEYS) {
    if (!env[key] || env[key]!.trim() === '') {
      throw new Error(`Missing required env var ${key}`);
    }
  }
  const id = `ci-${Date.now()}`;
  const cfg: StoredDittoConfig = {
    ...newConfig(),
    id,
    name: env.DITTO_CI_SITE_NAME ?? id,
    databaseId: env.DITTO_CI_DATABASE_ID!,
    authUrl: env.DITTO_CI_URL!,
    websocketUrl: env.DITTO_CI_WEBSOCKET_URL!,
    mode: 'server',
  };
  return { config: cfg, secrets: { token: env.DITTO_CI_DEVELOPMENT_TOKEN! } };
}

export function makeTestApi(deps: {
  configStore: ConfigStore;
  secretStore: SecretStore;
  manager: DittoManager;
  env?: EnvShape;
}): TestApi {
  const env = deps.env ?? (process.env as EnvShape);
  return {
    async registerFromEnv() {
      const { config, secrets } = buildConfigFromEnv(env);
      await deps.configStore.save(config);
      await deps.secretStore.write(config.id, secrets);
      return config.id;
    },
    async connect(configId) {
      const cfg = deps.configStore.get(configId);
      if (!cfg) { throw new Error(`No config with id ${configId}`); }
      const secrets = await deps.secretStore.read(configId);
      await deps.manager.connect(cfg, secrets);
    },
    async disconnect() {
      await deps.manager.disconnect();
    },
    async waitForPeerOrSyncStatus(timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        let presenceSub: vscode.Disposable | undefined;
        let syncSub: vscode.Disposable | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          presenceSub?.dispose();
          syncSub?.dispose();
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`No presence or sync-status event within ${timeoutMs}ms`));
        }, timeoutMs);
        const settle = () => { cleanup(); resolve(); };
        presenceSub = deps.manager.onPresence(settle);
        syncSub = deps.manager.onSyncChange(settle);
      });
    },
  };
}
