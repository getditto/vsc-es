import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DatabaseEditorPanel } from '../panels/DatabaseEditorPanel.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { SecretStore } from '../storage/SecretStore.js';
import { withConnectionPersistenceLock } from '../storage/connection-persistence-lock.js';
import {
  newConfig,
  type StoredDittoConfig,
  type SystemSettingOption,
} from '../models/DittoConfig.js';
import type { SecretSet } from '../models/DittoConfig.js';
import type { Logger, LogLevel } from '../logging/types.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { EditorOut } from '../ipc/messages.js';

/**
 * Behavioural tests for the database editor panel: init payloads, malformed
 * and hostile webview messages, per-field validation, the save pipeline
 * (normalize → atomic persist → toast → close), and its failure paths.
 *
 * Construction mirrors panel-lifecycle-contract.test.ts: the panel is always
 * built through the static `DatabaseEditorPanel.show(context, configs,
 * secrets, logger, manager, existing?)` and found via the stub's
 * `createdWebviewPanels`.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[]; shownWarnings: string[]; shownInfos: string[] };
  __resetStub(): void;
};

interface FakePanel {
  disposed: boolean;
  revealCount: number;
  title: string;
  webview: {
    posted: Array<{ type: string } & Record<string, unknown>>;
    postMessage(msg: unknown): Promise<boolean>;
  };
  dispose(): void;
  fireMessage(msg: unknown): void;
}

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

/** In-memory SecretStorageLike with failure/latency injection. */
class FakeSecretStorage {
  readonly map = new Map<string, string>();
  failGet: Error | undefined;
  /** When set, every get() awaits this promise first (simulates a slow keychain). */
  getDelay: Promise<void> | undefined;
  async get(key: string): Promise<string | undefined> {
    if (this.getDelay) { await this.getDelay; }
    if (this.failGet) { throw this.failGet; }
    return this.map.get(key);
  }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

interface RecordedLog { message: string; ctx?: Record<string, unknown> | undefined }

function recordingLogger() {
  const warnings: RecordedLog[] = [];
  const errors: RecordedLog[] = [];
  const logger = {
    error: (message: string, ctx?: Record<string, unknown>) => { errors.push({ message, ctx }); },
    warn: (message: string, ctx?: Record<string, unknown>) => { warnings.push({ message, ctx }); },
    info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => logger,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return { logger, warnings, errors };
}

function fakeManager() {
  const lifecycleListeners = new Set<() => void>();
  const state = {
    activeId: null as string | null,
    systemSettingOptions: [] as SystemSettingOption[],
    systemSettingsError: undefined as Error | undefined,
  };
  const manager = {
    getActiveConfigId: () => state.activeId,
    getSystemSettingOptions: async (_configId: string): Promise<SystemSettingOption[]> => {
      if (state.systemSettingsError) { throw state.systemSettingsError; }
      return state.systemSettingOptions;
    },
    onLifecycleStateChange: (l: () => void) => {
      lifecycleListeners.add(l);
      return { dispose: () => { lifecycleListeners.delete(l); } };
    },
  };
  return {
    manager: manager as unknown as DittoManager,
    state,
    fireLifecycle: () => { for (const l of [...lifecycleListeners]) { l(); } },
  };
}

function makeWorld() {
  const configs = new ConfigStore(new FakeMemento());
  const storage = new FakeSecretStorage();
  const secrets = new SecretStore(storage);
  const { logger, warnings, errors } = recordingLogger();
  const { manager, state, fireLifecycle } = fakeManager();
  return { configs, storage, secrets, logger, warnings, errors, manager, state, fireLifecycle };
}

type World = ReturnType<typeof makeWorld>;

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: {
      keys: () => [...store.keys()],
      get: <T,>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function showEditor(world: World, existing?: StoredDittoConfig): FakePanel {
  DatabaseEditorPanel.show(fakeContext(), world.configs, world.secrets, world.logger, world.manager, existing);
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'show() created no webview panel');
  return panel;
}

function teardown(): void {
  for (const p of stub.createdWebviewPanels) { try { p.dispose(); } catch { /* best effort */ } }
  stub.__resetStub();
}

/** The init timer is 50ms; give async init/save flows room to finish. */
const settle = (ms = 140): Promise<void> => new Promise(r => setTimeout(r, ms));

/** A config that passes every validate() check (unique databaseId per id). */
function validConfig(id: string, over: Record<string, unknown> = {}): StoredDittoConfig {
  return {
    ...newConfig(),
    id,
    name: 'Test DB',
    databaseId: `db-${id}`,
    mode: 'server',
    authUrl: 'auth.example.ditto.live',
    httpApiUrl: 'api.example.ditto.live',
    ...over,
  };
}

function postedOfType<T extends EditorOut>(panel: FakePanel, type: T['type']): T[] {
  return panel.webview.posted.filter(m => m.type === type) as unknown as T[];
}

/** Seed an existing connection (config + token) and open its editor. */
async function showExistingEditor(
  world: World,
  config: StoredDittoConfig,
  secrets: SecretSet = { token: 'tok' },
): Promise<FakePanel> {
  await world.configs.save(config);
  await world.secrets.write(config.id, secrets);
  const panel = showEditor(world, config);
  await settle();
  return panel;
}

/** Fire a valid save for the open editor; `over`/`secretOver` break one thing at a time. */
function fireSave(
  panel: FakePanel,
  id: string,
  over: Record<string, unknown> = {},
  secretOver: Record<string, unknown> = {},
  encryptionKey?: unknown,
): void {
  panel.fireMessage({
    type: 'editor.save',
    config: validConfig(id, over),
    secrets: { token: 'tok', ...secretOver },
    encryptionKey,
  });
}

function validationErrors(panel: FakePanel): Array<{ message: string; field: string | undefined }> {
  return postedOfType<EditorOut & { type: 'editor.validationError' }>(panel, 'editor.validationError')
    .map(e => ({ message: e.message, field: e.field }));
}

test('registering an encrypted database stores a key that survives edits and stays off the webview', async () => {
  teardown();
  const world = makeWorld();
  const create = showEditor(world);
  await settle();
  const init = postedOfType<EditorOut & { type: 'editor.init' }>(create, 'editor.init')[0]!;
  assert.equal(init.isNewConnection, true);

  fireSave(create, init.config.id, { encryptLocalStore: true });
  await settle();
  const saved = world.configs.get(init.config.id);
  assert.ok(saved);
  assert.equal(saved.encryptLocalStore, true);
  assert.equal('encryptionKey' in saved, false);
  const key = world.storage.map.get(`ditto.${saved.id}.encryptionKey`);
  assert.ok(key);
  assert.equal(Buffer.from(key, 'base64').length, 32);

  const edit = showEditor(world, saved);
  await settle();
  const editInit = postedOfType<EditorOut & { type: 'editor.init' }>(edit, 'editor.init')[0]!;
  assert.equal(editInit.isNewConnection, false);
  assert.equal(editInit.config.encryptLocalStore, true);
  assert.equal('encryptionKey' in editInit.secrets, false);
  assert.equal('encryptionKey' in editInit, false);

  fireSave(edit, saved.id, { encryptLocalStore: true }, {}, randomBytes(32).toString('base64'));
  await settle();
  assert.match(validationErrors(edit)[0]!.message, /only be supplied when registering/);
  assert.equal((await world.secrets.read(saved.id)).encryptionKey, key);

  fireSave(edit, saved.id, { encryptLocalStore: false });
  await settle();
  assert.match(validationErrors(edit)[1]!.message, /only be set when registering/);
  assert.equal(edit.disposed, false);

  fireSave(edit, saved.id, { name: 'Renamed encrypted DB' }, { token: 'updated-token' });
  await settle();
  assert.equal(world.configs.get(saved.id)?.name, 'Renamed encrypted DB');
  assert.equal(world.configs.get(saved.id)?.encryptLocalStore, true);
  const updated = await world.secrets.read(saved.id);
  assert.equal(updated.encryptionKey, key);
  assert.equal(updated.token, 'updated-token');
});

test('registration validates a supplied encryption key and persists it only in Secret Storage', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();
  const { config: { id } } = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0]!;
  const key = randomBytes(32).toString('base64');

  fireSave(panel, id, {}, {}, key);
  await settle();
  assert.match(validationErrors(panel)[0]!.message, /with encryption enabled/);

  fireSave(panel, id, { encryptLocalStore: true }, {}, 42);
  await settle();
  assert.match(validationErrors(panel)[1]!.message, /must be Base64 text/);

  const malformed = key.replace(/=$/, '?');
  fireSave(panel, id, { encryptLocalStore: true }, {}, malformed);
  await settle();
  assert.deepEqual(validationErrors(panel)[2], {
    message: 'Enter a Base64-encoded key that decodes to exactly 32 bytes.',
    field: 'encryptionKey',
  });
  assert.equal(world.configs.get(id), undefined);
  assert.equal(world.storage.map.size, 0);
  assert.equal(panel.disposed, false);

  fireSave(panel, id, { encryptLocalStore: true }, {}, ` ${key.slice(0, -1)} `);
  await settle();
  const saved = world.configs.get(id);
  assert.equal(saved?.encryptLocalStore, true);
  assert.equal((await world.secrets.read(id)).encryptionKey, key);
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.ok(!JSON.stringify(panel.webview.posted).includes(key));
  assert.ok(!JSON.stringify([world.warnings, world.errors]).includes(key));
  assert.equal(panel.disposed, true);
});

test('editing a legacy database cannot enable encryption or supply a key', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('legacy'));
  fireSave(panel, 'legacy', { encryptLocalStore: true });
  await settle();
  assert.match(validationErrors(panel)[0]!.message, /only be set when registering/);

  fireSave(panel, 'legacy', {}, { encryptionKey: 'unexpected-field' });
  await settle();
  assert.match(validationErrors(panel)[1]!.message, /malformed/);
  assert.equal(world.configs.get('legacy')?.encryptLocalStore, undefined);
  assert.equal((await world.secrets.read('legacy')).encryptionKey, undefined);
});

// ─── show() gating ─────────────────────────────────────────────

test('DatabaseEditorPanel: show while connection persistence is busy shows a notice and creates no panel', async () => {
  teardown();
  let release!: () => void;
  const held = withConnectionPersistenceLock(() => new Promise<void>(r => { release = r; }));
  // The lock body runs after awaiting the previous tail — yield a macrotask so
  // `release` is assigned before the test (or a failed assertion) can call it.
  await new Promise(r => setTimeout(r, 0));
  try {
    const world = makeWorld();

    DatabaseEditorPanel.show(fakeContext(), world.configs, world.secrets, world.logger, world.manager);

    assert.equal(stub.createdWebviewPanels.length, 0, 'no panel while the store lock is held');
    assert.ok(
      stub.window.shownInfos.some(m => m.includes('being updated')),
      `expected a busy notice; saw ${JSON.stringify(stub.window.shownInfos)}`,
    );
  } finally {
    release();
    await held;
  }
  teardown();
});

test('DatabaseEditorPanel: showing again reveals the open panel and re-initializes with the new connection', async () => {
  teardown();
  const world = makeWorld();
  await world.configs.save(validConfig('a'));
  await world.configs.save(validConfig('b', { name: 'Second', databaseId: 'db-b' }));
  await world.secrets.write('a', { token: 'tok-a' });
  await world.secrets.write('b', { token: 'tok-b' });

  const panel = showEditor(world, validConfig('a'));
  await settle();
  DatabaseEditorPanel.show(fakeContext(), world.configs, world.secrets, world.logger, world.manager, validConfig('b', { name: 'Second', databaseId: 'db-b' }));
  await settle();

  assert.equal(stub.createdWebviewPanels.length, 1, 'second show must not build a new webview');
  assert.equal(panel.revealCount, 1, 'existing panel was revealed');
  const inits = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init');
  assert.equal(inits.length, 2, 'init ran once per show');
  assert.equal(inits[1]?.config.id, 'b', 're-init carried the newly-edited connection');
  assert.equal(inits[1]?.secrets.token, 'tok-b');
  teardown();
});

test('DatabaseEditorPanel: a failed re-init is logged, not swallowed', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  const realGet = world.configs.get.bind(world.configs);
  world.configs.get = () => { throw new Error('store exploded'); };
  try {
    DatabaseEditorPanel.show(fakeContext(), world.configs, world.secrets, world.logger, world.manager, validConfig('a'));
    await settle();
  } finally {
    world.configs.get = realGet;
  }

  assert.equal(panel.revealCount, 1);
  assert.ok(
    world.warnings.some(w => w.message === 'Database editor re-init failed' && String(w.ctx?.err).includes('store exploded')),
    `expected a re-init warning; saw ${JSON.stringify(world.warnings)}`,
  );
  teardown();
});

// ─── init payloads ─────────────────────────────────────────────

test('DatabaseEditorPanel: new registration posts editor.init with a generated id, empty token, isActiveConnection false', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  assert.equal(panel.title, 'Register Database');
  await settle();

  const inits = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init');
  assert.equal(inits.length, 1);
  const init = inits[0]!;
  assert.match(init.config.id, /^[0-9a-f]{32}$/, 'randomId(16) mints 32 hex chars');
  assert.equal(init.secrets.token, '');
  assert.equal(init.isActiveConnection, false);
  assert.deepEqual(postedOfType(panel, 'editor.systemSettingsLoaded'), [], 'no settings load for a new connection');
  teardown();
});

test('DatabaseEditorPanel: editing the active connection posts isActiveConnection true and loads system settings', async () => {
  teardown();
  const world = makeWorld();
  const options: SystemSettingOption[] = [{ parameter: 'MESH_KIT_AVOID', type: 'boolean', value: true }];
  world.state.activeId = 'a';
  world.state.systemSettingOptions = options;
  const panel = await showExistingEditor(world, validConfig('a'), { token: 'tok', httpApiKey: 'key' });

  assert.equal(panel.title, 'Edit Database — Test DB');
  const init = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0];
  assert.ok(init);
  assert.equal(init.config.id, 'a');
  assert.equal(init.secrets.token, 'tok');
  assert.equal(init.secrets.httpApiKey, 'key');
  assert.equal(init.isActiveConnection, true);
  const loaded = postedOfType<EditorOut & { type: 'editor.systemSettingsLoaded' }>(panel, 'editor.systemSettingsLoaded');
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0]?.options, options);
  teardown();
});

test('DatabaseEditorPanel: a system-settings load failure posts editor.systemSettingsLoadError but still initializes', async () => {
  teardown();
  const world = makeWorld();
  world.state.activeId = 'a';
  world.state.systemSettingsError = new Error('SHOW ALL failed');
  const panel = await showExistingEditor(world, validConfig('a'));

  assert.equal(postedOfType(panel, 'editor.init').length, 1, 'init still posted');
  const errs = postedOfType<EditorOut & { type: 'editor.systemSettingsLoadError' }>(panel, 'editor.systemSettingsLoadError');
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /could not be loaded/);
  assert.deepEqual(postedOfType(panel, 'editor.systemSettingsLoaded'), []);
  teardown();
});

test('DatabaseEditorPanel: editing an inactive connection posts isActiveConnection false and skips settings load', async () => {
  teardown();
  const world = makeWorld();
  world.state.activeId = 'someone-else';
  const panel = await showExistingEditor(world, validConfig('a'));

  const init = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0];
  assert.equal(init?.isActiveConnection, false);
  assert.deepEqual(postedOfType(panel, 'editor.systemSettingsLoaded'), []);
  assert.deepEqual(postedOfType(panel, 'editor.systemSettingsLoadError'), []);
  teardown();
});

test('DatabaseEditorPanel: a credential read failure posts editor.initError instead of init', async () => {
  teardown();
  const world = makeWorld();
  await world.configs.save(validConfig('a'));
  world.storage.failGet = new Error('keychain locked');
  const panel = showEditor(world, validConfig('a'));
  await settle();

  assert.deepEqual(postedOfType(panel, 'editor.init'), []);
  const errs = postedOfType<EditorOut & { type: 'editor.initError' }>(panel, 'editor.initError');
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /credentials could not be loaded/);
  teardown();
});

test('DatabaseEditorPanel: editing a connection that vanished from the store still initializes from the passed snapshot', async () => {
  teardown();
  const world = makeWorld();
  // Config deliberately NOT in the store — the `?? existing` fallback feeds init.
  await world.secrets.write('gone', { token: 'tok-gone' });
  const panel = showEditor(world, validConfig('gone'));
  await settle();

  const init = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0];
  assert.ok(init, 'init posted even though the store has no such config');
  assert.equal(init.config.id, 'gone');
  assert.equal(init.secrets.token, 'tok-gone');
  teardown();
});

test('DatabaseEditorPanel: a stale init is dropped when the editor is re-shown for another connection', async () => {
  teardown();
  const world = makeWorld();
  await world.configs.save(validConfig('a'));
  await world.configs.save(validConfig('b', { name: 'Second', databaseId: 'db-b' }));
  await world.secrets.write('a', { token: 'tok-a' });
  await world.secrets.write('b', { token: 'tok-b' });

  // Hold the first connection's credential read until the re-init has won.
  let releaseA!: () => void;
  const gateA = new Promise<void>(r => { releaseA = r; });
  let gets = 0;
  const realGet = world.storage.get.bind(world.storage);
  world.storage.get = async (key: string) => {
    gets += 1;
    if (gets === 1) { await gateA; }
    return realGet(key);
  };

  const panel = showEditor(world, validConfig('a'));
  await settle(80); // init(a) has started and is parked on the gated read
  DatabaseEditorPanel.show(fakeContext(), world.configs, world.secrets, world.logger, world.manager, validConfig('b', { name: 'Second', databaseId: 'db-b' }));
  await settle(); // init(b) wins the generation race
  releaseA();
  await settle(40);

  const inits = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init');
  assert.equal(inits.length, 1, `stale init must not post; saw ${JSON.stringify(inits.map(i => i.config.id))}`);
  assert.equal(inits[0]?.config.id, 'b');
  teardown();
});

test('DatabaseEditorPanel: disposing before the init timer fires sends nothing', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  panel.dispose();
  await settle();
  assert.deepEqual(panel.webview.posted, [], 'no init after disposal');
  teardown();
});

// ─── lifecycle + post() plumbing ───────────────────────────────

test('DatabaseEditorPanel: lifecycle changes post editor.activeConnectionChanged once initialized', async () => {
  teardown();
  const world = makeWorld();
  world.state.activeId = 'a';
  const panel = await showExistingEditor(world, validConfig('a'));

  world.fireLifecycle();
  world.state.activeId = 'other';
  world.fireLifecycle();
  await settle(20);

  const events = postedOfType<EditorOut & { type: 'editor.activeConnectionChanged' }>(panel, 'editor.activeConnectionChanged');
  assert.deepEqual(events.map(e => e.isActiveConnection), [true, false]);
  teardown();
});

test('DatabaseEditorPanel: a lifecycle change before initialization posts nothing', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  world.fireLifecycle(); // expectedConfigId not set yet
  await settle();
  assert.deepEqual(postedOfType(panel, 'editor.activeConnectionChanged'), []);
  teardown();
});

test('DatabaseEditorPanel: an undelivered post is logged', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  panel.webview.postMessage = () => Promise.resolve(false);
  await settle();
  assert.ok(
    world.warnings.some(w => w.message === 'Database editor message was not delivered' && w.ctx?.type === 'editor.init'),
    `expected a not-delivered warning; saw ${JSON.stringify(world.warnings)}`,
  );
  teardown();
});

test('DatabaseEditorPanel: a rejected post is logged', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  panel.webview.postMessage = () => Promise.reject(new Error('webview gone'));
  await settle();
  assert.ok(
    world.warnings.some(w => w.message === 'Database editor message delivery failed' && w.ctx?.type === 'editor.init'),
    `expected a delivery-failed warning; saw ${JSON.stringify(world.warnings)}`,
  );
  teardown();
});

// ─── malformed / unknown inbound messages ──────────────────────

test('DatabaseEditorPanel: malformed messages are logged and ignored', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();

  const bad = [undefined, null, 42, 'editor.save', [], {}, { type: 42 }];
  for (const msg of bad) { panel.fireMessage(msg); }
  await settle(20);

  const malformed = world.warnings.filter(w => w.message === 'Ignored malformed database editor message');
  assert.equal(malformed.length, bad.length, `one warning per malformed message; saw ${JSON.stringify(world.warnings)}`);
  assert.deepEqual(validationErrors(panel), []);
  assert.equal(panel.disposed, false, 'panel survives malformed traffic');
  teardown();
});

test('DatabaseEditorPanel: an unknown message type is logged with its type', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();

  panel.fireMessage({ type: 'editor.frobnicate' });
  await settle(20);

  assert.ok(
    world.warnings.some(w => w.message === 'Ignored unknown database editor message' && w.ctx?.type === 'editor.frobnicate'),
    `expected an unknown-type warning; saw ${JSON.stringify(world.warnings)}`,
  );
  teardown();
});

test('DatabaseEditorPanel: editor.cancel disposes the panel and clears the singleton', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();

  panel.fireMessage({ type: 'editor.cancel' });
  assert.equal(panel.disposed, true, 'cancel closes the panel');

  showEditor(world);
  assert.equal(stub.createdWebviewPanels.length, 2, 'the next show builds a fresh panel');
  teardown();
});

test('DatabaseEditorPanel: editor.save without a config or secrets object is ignored as malformed', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();

  const bad = [
    { type: 'editor.save' },
    { type: 'editor.save', config: null, secrets: {} },
    { type: 'editor.save', config: {}, secrets: null },
    { type: 'editor.save', config: 'cfg', secrets: { token: 't' } },
  ];
  for (const msg of bad) { panel.fireMessage(msg); }
  await settle(20);

  const malformed = world.warnings.filter(w => w.message === 'Ignored malformed database editor save message');
  assert.equal(malformed.length, bad.length, `one warning per malformed save; saw ${JSON.stringify(world.warnings)}`);
  assert.deepEqual(validationErrors(panel), []);
  teardown();
});

test('DatabaseEditorPanel: editor.save with a mismatched config id posts an identity validation error', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'intruder');
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /identity changed unexpectedly/);
  assert.equal(panel.disposed, false, 'panel stays open for correction');
  teardown();
});

test('DatabaseEditorPanel: editor.save before initialization completes is rejected as an identity change', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  // expectedConfigId is still null — the init timer has not fired.
  fireSave(panel, 'anything');
  await settle();

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /identity changed unexpectedly/);
  assert.equal(postedOfType(panel, 'editor.init').length, 1, 'init still ran afterwards');
  teardown();
});

// ─── per-field validation ──────────────────────────────────────

test('DatabaseEditorPanel: structurally malformed configs and secrets are rejected', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ name: 42 }, {}],
    [{ mode: 'mesh' }, {}],
    [{ logLevel: 'loud' }, {}],
    [{ allowUntrustedCerts: 'yes' }, {}],
    [{ websocketUrl: 7 }, {}],
    [{ isLanEnabled: 'yes' }, {}],
    [{ isStrictModeEnabled: 1 }, {}],
    [{ databaseId: { nested: true } }, {}],
    [{}, { token: 42 }],
    [{}, { token: 't', secretKey: 5 }],
    [{}, { token: 't', httpApiKey: true }],
  ];
  for (const [cfgOver, secOver] of cases) { fireSave(panel, 'a', cfgOver, secOver); }
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, cases.length, `every case rejected; saw ${JSON.stringify(errs)}`);
  for (const err of errs) {
    assert.equal(err.message, 'Connection data is malformed.');
    assert.equal(err.field, undefined, 'shape failures carry no field hint');
  }
  assert.equal(world.configs.get('a')?.name, 'Test DB', 'nothing was persisted');
  teardown();
});

test('DatabaseEditorPanel: name, databaseId, token, and server-mode URL are required', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
    [{ name: '   ' }, {}, 'Name is required.'],
    [{ databaseId: ' ' }, {}, 'Database ID is required.'],
    [{}, { token: '  ' }, 'Token is required.'],
    [{ authUrl: ' ' }, {}, 'URL is required for Server mode.'],
  ];
  for (const [cfgOver, secOver] of cases) { fireSave(panel, 'a', cfgOver, secOver); }
  await settle(20);

  const errs = validationErrors(panel);
  assert.deepEqual(errs.map(e => e.message), cases.map(c => c[2]));
  teardown();
});

test('DatabaseEditorPanel: smallPeersOnly mode allows an empty authUrl', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(
    world,
    validConfig('a', { mode: 'smallPeersOnly', authUrl: '', httpApiUrl: '' }),
  );

  fireSave(panel, 'a', { mode: 'smallPeersOnly', authUrl: '', httpApiUrl: '' });
  await settle();

  assert.deepEqual(validationErrors(panel), []);
  assert.ok(stub.window.shownInfos.some(m => m === 'Saved connection "Test DB".'));
  assert.equal(panel.disposed, true);
  teardown();
});

test('DatabaseEditorPanel: a duplicate Database ID is rejected with the conflicting connection name', async () => {
  teardown();
  const world = makeWorld();
  await world.configs.save(validConfig('b', { name: 'Other DB', databaseId: 'db-b' }));
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'a', { databaseId: '  db-b  ' });
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.equal(
    errs[0]?.message,
    'Database ID "db-b" is already used by connection "Other DB". Each connection must use a unique Database ID.',
  );
  teardown();
});

test('DatabaseEditorPanel: host validation rejects credential-smuggling and scheme-prefixed URLs', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'a', { authUrl: 'good.com@evil.com' });
  fireSave(panel, 'a', { httpApiUrl: 'https://api.example.ditto.live' });
  fireSave(panel, 'a', { httpApiUrl: 'bad host' });
  await settle(20);

  const messages = validationErrors(panel).map(e => e.message);
  assert.equal(messages.length, 3, `three URL failures; saw ${JSON.stringify(messages)}`);
  assert.match(messages[0] ?? '', /^Auth URL: URLs must not contain a username or "@"/);
  assert.match(messages[1] ?? '', /^HTTP API URL: Enter the host without a scheme/);
  assert.match(messages[2] ?? '', /^HTTP API URL: Not a valid host\[?[:port\]]*/);
  teardown();
});

test('DatabaseEditorPanel: accepts and persists the Portal https auth URL', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'a', { authUrl: 'https://6b1b5999.cloud.dittolive.app' });
  await settle(20);

  assert.deepEqual(validationErrors(panel), []);
  assert.equal(world.configs.get('a')?.authUrl, 'https://6b1b5999.cloud.dittolive.app');
  assert.equal(panel.disposed, true);
  teardown();
});

test('DatabaseEditorPanel: advanced configuration must be an object when present', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  for (const advancedConfig of [[], 42, null]) {
    fireSave(panel, 'a', { advancedConfig });
  }
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, 3);
  for (const err of errs) {
    assert.equal(err.message, 'Advanced configuration is invalid.');
    assert.equal(err.field, 'advancedConfig', 'the webview scrolls to the advanced section');
  }
  teardown();
});

test('DatabaseEditorPanel: invalid collection sync scopes are reported against advancedConfig', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'a', {
    advancedConfig: {
      collectionSyncScopes: [
        { collection: 'tasks', scope: 'AllPeers' },
        { collection: 'tasks', scope: 'BigPeerOnly' },
      ],
    },
  });
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.equal(errs[0]?.message, 'Collection "tasks" has more than one sync scope.');
  assert.equal(errs[0]?.field, 'advancedConfig');
  teardown();
});

test('DatabaseEditorPanel: invalid system settings are reported against advancedConfig', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  fireSave(panel, 'a', {
    advancedConfig: {
      systemSettings: [{ parameter: 'USER_COLLECTION_SYNC_SCOPES', type: 'string', value: 'x' }],
    },
  });
  await settle(20);

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.equal(errs[0]?.message, 'Parameter "USER_COLLECTION_SYNC_SCOPES" is managed by a dedicated control.');
  assert.equal(errs[0]?.field, 'advancedConfig');
  teardown();
});

// ─── save pipeline ─────────────────────────────────────────────

test('DatabaseEditorPanel: a valid save persists the normalized config and secrets, confirms, and closes', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();
  const init = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0];
  assert.ok(init);
  const id = init.config.id;

  panel.fireMessage({
    type: 'editor.save',
    config: {
      ...init.config,
      name: 'Prod',
      databaseId: 'db-prod',
      authUrl: 'auth.example.ditto.live',
      httpApiUrl: 'api.example.ditto.live',
      advancedConfig: {
        collectionSyncScopes: [{ collection: ' tasks ', scope: 'AllPeers' }],
        systemSettings: [{ parameter: ' mesh_hint ', type: 'integer', value: 3 }],
      },
    },
    secrets: { token: 'tok-123', httpApiKey: 'k' },
  });
  await settle();

  assert.deepEqual(validationErrors(panel), [], 'no validation error for a well-formed save');
  const stored = world.configs.get(id);
  assert.ok(stored, 'config persisted');
  assert.equal(stored.name, 'Prod');
  assert.deepEqual(stored.advancedConfig?.collectionSyncScopes, [{ collection: 'tasks', scope: 'AllPeers' }]);
  assert.deepEqual(stored.advancedConfig?.systemSettings, [{ parameter: 'MESH_HINT', type: 'integer', value: 3 }]);
  const storedSecrets = await world.secrets.read(id);
  assert.equal(storedSecrets.token, 'tok-123');
  assert.equal(storedSecrets.httpApiKey, 'k');
  assert.ok(stub.window.shownInfos.some(m => m === 'Saved connection "Prod".'));
  assert.equal(panel.disposed, true, 'successful save closes the editor');
  teardown();
});

test('DatabaseEditorPanel: changing startup settings on the active connection warns that a reconnect is required', async () => {
  teardown();
  const world = makeWorld();
  const stored = validConfig('a', {
    advancedConfig: { systemSettings: [{ parameter: 'MESH_HINT', type: 'integer', value: 1 }] },
  });
  world.state.activeId = 'a';
  const panel = await showExistingEditor(world, stored);

  // The user cleared the startup settings — the stored set no longer matches.
  fireSave(panel, 'a', { advancedConfig: { systemSettings: [] } });
  await settle();

  assert.deepEqual(validationErrors(panel), []);
  assert.ok(
    stub.window.shownWarnings.some(m => m === 'Startup settings saved. Disconnect and reconnect "Test DB" to apply them.'),
    `expected a reconnect warning; saw ${JSON.stringify(stub.window.shownWarnings)}`,
  );
  assert.deepEqual(stub.window.shownInfos.filter(m => m.startsWith('Saved connection')), []);
  assert.equal(panel.disposed, true);
  assert.deepEqual(world.configs.get('a')?.advancedConfig?.systemSettings, []);
  teardown();
});

test('DatabaseEditorPanel: a store-level save failure rolls back, posts the error, and keeps the editor open for retry', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'), { token: 'old' });

  const realSave = world.configs.save.bind(world.configs);
  let failNext = true;
  world.configs.save = async (c: StoredDittoConfig) => {
    if (failNext) { failNext = false; throw new Error('disk full'); }
    return realSave(c);
  };

  fireSave(panel, 'a', { name: 'Renamed' });
  await settle();

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.equal(errs[0]?.message, 'Connection could not be saved. Previous values were restored.');
  assert.equal(panel.disposed, false, 'failed save keeps the editor open');
  assert.equal(world.configs.get('a')?.name, 'Test DB', 'rollback restored the previous config');
  assert.equal((await world.secrets.read('a')).token, 'old', 'secrets untouched');

  // `saving` was reset — the corrected retry goes through.
  fireSave(panel, 'a', { name: 'Renamed' });
  await settle();
  assert.equal(world.configs.get('a')?.name, 'Renamed');
  assert.ok(stub.window.shownInfos.some(m => m === 'Saved connection "Renamed".'));
  assert.equal(panel.disposed, true);
  teardown();
});

test('DatabaseEditorPanel: a second save while one is in flight is dropped', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  let saves = 0;
  const realSave = world.configs.save.bind(world.configs);
  world.configs.save = async (c: StoredDittoConfig) => { saves += 1; return realSave(c); };

  let releaseRead!: () => void;
  world.storage.getDelay = new Promise<void>(r => { releaseRead = r; });

  fireSave(panel, 'a', { name: 'First' });
  fireSave(panel, 'a', { name: 'Second' });
  releaseRead();
  await settle();

  assert.equal(saves, 1, 'the in-flight save wins; the duplicate never reaches the store');
  assert.equal(world.configs.get('a')?.name, 'First');
  assert.equal(panel.disposed, true);
  teardown();
});

test('DatabaseEditorPanel: deleting the connection mid-edit fails the save with a clear message', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  await world.configs.delete('a');
  fireSave(panel, 'a', { name: 'Renamed' });
  await settle();

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /was deleted while the editor was open/);
  assert.equal(panel.disposed, false);
  teardown();
});

test('DatabaseEditorPanel: a new registration that appears elsewhere mid-edit is refused', async () => {
  teardown();
  const world = makeWorld();
  const panel = showEditor(world);
  await settle();
  const init = postedOfType<EditorOut & { type: 'editor.init' }>(panel, 'editor.init')[0];
  assert.ok(init);

  // Someone else persisted a connection under this identity while the form was open.
  await world.configs.save(validConfig(init.config.id, { name: 'Racing', databaseId: 'db-racing' }));
  panel.fireMessage({
    type: 'editor.save',
    config: { ...init.config, name: 'Mine', databaseId: 'db-mine', authUrl: 'auth.example.ditto.live', httpApiUrl: 'api.example.ditto.live' },
    secrets: { token: 'tok' },
  });
  await settle();

  const errs = validationErrors(panel);
  assert.equal(errs.length, 1);
  assert.match(errs[0]?.message ?? '', /already exists/);
  assert.equal(world.configs.get(init.config.id)?.name, 'Racing', 'the racing write was not overwritten');
  teardown();
});

test('DatabaseEditorPanel: an unexpected throw inside the handler is surfaced by the wrapper', async () => {
  teardown();
  const world = makeWorld();
  const panel = await showExistingEditor(world, validConfig('a'));

  const realList = world.configs.list.bind(world.configs);
  world.configs.list = () => { throw new Error('memento corrupted'); };
  try {
    fireSave(panel, 'a');
    await settle(20);
  } finally {
    world.configs.list = realList;
  }

  assert.ok(
    stub.window.shownErrors.some(m => m.startsWith('Database editor action failed: memento corrupted')),
    `expected an error toast from webviewMessageHandler; saw ${JSON.stringify(stub.window.shownErrors)}`,
  );
  assert.ok(world.errors.some(e => e.message === 'Database editor action failed'));
  teardown();
});
