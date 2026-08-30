import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigFromEnv, makeTestApi } from '../test-api/index.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { SecretStore } from '../storage/SecretStore.js';

test('buildConfigFromEnv: returns config when all required env vars are set', () => {
  const env = {
    DITTO_CI_DATABASE_ID: 'db-123',
    DITTO_CI_DEVELOPMENT_TOKEN: 'tok-abc',
    DITTO_CI_URL: 'https://example.ditto.live',
    DITTO_CI_SITE_NAME: 'ci-run-1-darwin-arm64',
  };
  const { config, secrets } = buildConfigFromEnv(env);
  assert.equal(config.databaseId, 'db-123');
  assert.equal(config.authUrl, 'https://example.ditto.live');
  assert.equal(config.mode, 'server');
  assert.equal(config.name, 'ci-run-1-darwin-arm64');
  assert.equal(secrets.token, 'tok-abc');
  assert.equal(config.websocketUrl, undefined);
});

test('buildConfigFromEnv: throws with clear message when DATABASE_ID missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_URL: 'u' }),
    /DITTO_CI_DATABASE_ID/,
  );
});

test('buildConfigFromEnv: throws when DEVELOPMENT_TOKEN missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_URL: 'u' }),
    /DITTO_CI_DEVELOPMENT_TOKEN/,
  );
});

test('buildConfigFromEnv: throws when URL missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_DEVELOPMENT_TOKEN: 't' }),
    /DITTO_CI_URL/,
  );
});

test('buildConfigFromEnv: throws when DATABASE_ID is whitespace-only', () => {
  assert.throws(
    () => buildConfigFromEnv({
      DITTO_CI_DATABASE_ID: '   ',
      DITTO_CI_DEVELOPMENT_TOKEN: 't',
      DITTO_CI_URL: 'u',
    }),
    /DITTO_CI_DATABASE_ID/,
  );
});

// ─── makeTestApi ───────────────────────────────────────────────

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

class FakeSecretStorage {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

const CI_ENV = {
  DITTO_CI_DATABASE_ID: 'db-ci',
  DITTO_CI_DEVELOPMENT_TOKEN: 'tok-ci',
  DITTO_CI_URL: 'ci.example.ditto.live',
};

function fakeManager() {
  const presence = new Set<() => void>();
  const sync = new Set<() => void>();
  return {
    connectCalls: [] as Array<[unknown, unknown]>,
    disconnectCalls: 0,
    async connect(cfg: unknown, secrets: unknown) { this.connectCalls.push([cfg, secrets]); },
    async disconnect() { this.disconnectCalls += 1; },
    onPresence(l: () => void) { presence.add(l); return { dispose: () => { presence.delete(l); } }; },
    onSyncChange(l: () => void) { sync.add(l); return { dispose: () => { sync.delete(l); } }; },
    firePresence() { for (const l of [...presence]) { l(); } },
    fireSync() { for (const l of [...sync]) { l(); } },
    listenerCounts() { return { presence: presence.size, sync: sync.size }; },
  };
}

function makeWorld(env: Record<string, string | undefined> | undefined = CI_ENV) {
  const configStore = new ConfigStore(new FakeMemento());
  const secretStore = new SecretStore(new FakeSecretStorage());
  const manager = fakeManager();
  const api = makeTestApi({ configStore, secretStore, manager: manager as never, env });
  return { api, configStore, secretStore, manager };
}

test('buildConfigFromEnv: falls back to the generated id when SITE_NAME is absent', () => {
  const { config } = buildConfigFromEnv(CI_ENV);
  assert.match(config.id, /^ci-\d+$/, 'CI configs are prefixed');
  assert.equal(config.name, config.id, 'name defaults to the id');
});

test('makeTestApi.registerFromEnv persists the config and its secrets, returning the id', async () => {
  const { api, configStore, secretStore } = makeWorld();
  const id = await api.registerFromEnv();

  const stored = configStore.get(id);
  assert.ok(stored, 'config landed in the store');
  assert.equal(stored.databaseId, 'db-ci');
  assert.equal(stored.authUrl, 'ci.example.ditto.live');
  assert.equal(stored.mode, 'server');
  const secrets = await secretStore.read(id);
  assert.equal(secrets.token, 'tok-ci');
});

test('makeTestApi.registerFromEnv rejects when the environment is incomplete', async () => {
  const { api } = makeWorld({ DITTO_CI_DATABASE_ID: 'db-ci' });
  await assert.rejects(() => api.registerFromEnv(), /Missing required env var DITTO_CI_DEVELOPMENT_TOKEN/);
});

test('makeTestApi defaults to process.env when no env override is given', async () => {
  const keys = ['DITTO_CI_DATABASE_ID', 'DITTO_CI_DEVELOPMENT_TOKEN', 'DITTO_CI_URL'] as const;
  const saved = keys.map(k => [k, process.env[k]] as const);
  for (const k of keys) { delete process.env[k]; }
  try {
    const configStore = new ConfigStore(new FakeMemento());
    const secretStore = new SecretStore(new FakeSecretStorage());
    const api = makeTestApi({ configStore, secretStore, manager: fakeManager() as never });
    await assert.rejects(() => api.registerFromEnv(), /Missing required env var DITTO_CI_DATABASE_ID/);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; }
    }
  }
});

test('makeTestApi.connect hands the stored config and secrets to the manager', async () => {
  const { api, manager } = makeWorld();
  const id = await api.registerFromEnv();
  await api.connect(id);

  assert.equal(manager.connectCalls.length, 1);
  const [cfg, secrets] = manager.connectCalls[0]!;
  assert.equal((cfg as { id: string }).id, id);
  assert.equal((cfg as { databaseId: string }).databaseId, 'db-ci');
  assert.equal((secrets as { token: string }).token, 'tok-ci');
});

test('makeTestApi.connect rejects for an unknown config id', async () => {
  const { api, manager } = makeWorld();
  await assert.rejects(() => api.connect('nope'), /No config with id nope/);
  assert.equal(manager.connectCalls.length, 0, 'manager never invoked');
});

test('makeTestApi.disconnect delegates to the manager', async () => {
  const { api, manager } = makeWorld();
  await api.disconnect();
  await api.disconnect();
  assert.equal(manager.disconnectCalls, 2);
});

test('makeTestApi.waitForPeerOrSyncStatus resolves on a presence event and unsubscribes', async () => {
  const { api, manager } = makeWorld();
  const pending = api.waitForPeerOrSyncStatus(5000);
  assert.deepEqual(manager.listenerCounts(), { presence: 1, sync: 1 }, 'both channels watched');
  manager.firePresence();
  await pending;
  assert.deepEqual(manager.listenerCounts(), { presence: 0, sync: 0 }, 'both subscriptions disposed');
});

test('makeTestApi.waitForPeerOrSyncStatus resolves on a sync-status event', async () => {
  const { api, manager } = makeWorld();
  const pending = api.waitForPeerOrSyncStatus(5000);
  manager.fireSync();
  await pending;
  assert.deepEqual(manager.listenerCounts(), { presence: 0, sync: 0 });
});

test('makeTestApi.waitForPeerOrSyncStatus rejects on timeout, cleans up, and ignores late events', async () => {
  const { api, manager } = makeWorld();
  await assert.rejects(
    () => api.waitForPeerOrSyncStatus(20),
    /No presence or sync-status event within 20ms/,
  );
  assert.deepEqual(manager.listenerCounts(), { presence: 0, sync: 0 }, 'timeout disposes both subscriptions');
  // Late events must not throw or double-settle — the listeners are gone.
  manager.firePresence();
  manager.fireSync();
});
