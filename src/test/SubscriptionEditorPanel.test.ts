import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { SubscriptionEditorPanel } from '../panels/SubscriptionEditorPanel.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { StoredSubscription } from '../models/DittoConfig.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * SubscriptionEditorPanel behaviour, driven through the vscode stub's fake
 * webview panels: init for new vs existing subscriptions, save validation,
 * persistence, live registration with the manager, cancel, and error
 * surfacing through webviewMessageHandler.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[]; shownWarnings: string[]; shownInfos: string[] };
  __resetStub(): void;
};

interface FakePanel {
  title: string;
  disposed: boolean;
  revealCount: number;
  webview: { posted: unknown[]; html: string };
  dispose(): void;
  fireMessage(msg: unknown): void;
  fireViewState(active: boolean): void;
}

const DB_ID = 'db-under-test';
const EXISTING: StoredSubscription = { id: 'sub-1', name: 'cars', query: 'SELECT * FROM cars' };

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const self = {
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, errors };
}

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('/ext'),
    globalStorageUri: vscode.Uri.file('/global'),
    subscriptions: [],
    globalState: {
      keys: () => [...store.keys()],
      get: <T>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

interface SubStoreFake {
  saved: { databaseId: string; sub: StoredSubscription }[];
  failWith?: Error | undefined;
}

function fakeSubs(over: Partial<SubStoreFake> = {}): { subs: SubscriptionStore; fake: SubStoreFake } {
  const fake: SubStoreFake = { saved: [], ...over };
  const subs = {
    save: (databaseId: string, sub: StoredSubscription) => {
      if (fake.failWith) { return Promise.reject(fake.failWith); }
      fake.saved.push({ databaseId, sub });
      return Promise.resolve();
    },
  } as unknown as SubscriptionStore;
  return { subs, fake };
}

interface ManagerFake {
  activeConfigId: string | null;
  cancelled: string[];
  registered: { id: string; query: string }[];
}

function fakeManager(over: Partial<ManagerFake> = {}): { manager: DittoManager; fake: ManagerFake } {
  const fake: ManagerFake = { activeConfigId: DB_ID, cancelled: [], registered: [], ...over };
  const manager = {
    getActiveConfigId: () => fake.activeConfigId,
    cancelSubscription: (id: string) => { fake.cancelled.push(id); },
    registerSubscription: (id: string, query: string) => { fake.registered.push({ id, query }); },
  } as unknown as DittoManager;
  return { manager, fake };
}

function fakeInspector(): { inspector: InspectorController; features: unknown[] } {
  const features: unknown[] = [];
  const inspector = {
    setActiveFeature: (f: unknown) => { features.push(f); },
  } as unknown as InspectorController;
  return { inspector, features };
}

function showEditor(opts: {
  existing?: StoredSubscription;
  subs?: SubStoreFake;
  manager?: Partial<ManagerFake>;
} = {}): {
  panel: FakePanel;
  subs: SubStoreFake;
  manager: ManagerFake;
  inspector: ReturnType<typeof fakeInspector>;
  log: ReturnType<typeof recordingLogger>;
} {
  const s = fakeSubs(opts.subs);
  const m = fakeManager(opts.manager);
  const inspector = fakeInspector();
  const log = recordingLogger();
  SubscriptionEditorPanel.show(fakeContext(), s.subs, m.manager, DB_ID, inspector.inspector, log.logger, opts.existing);
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  return { panel, subs: s.fake, manager: m.fake, inspector, log };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The constructor pushes sub.init on a 50ms timer. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(m => (m as { type: string }).type === 'sub.init'));
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { SubscriptionEditorPanel.dispose(); stub.__resetStub(); });

// ─── Init ──────────────────────────────────────────────────────

test('a new subscription inits with empty fields and the New Subscription title', async () => {
  const { panel } = showEditor();
  assert.equal(panel.title, 'New Subscription');
  await settled(panel);
  const inits = panel.webview.posted.filter(m => (m as { type: string }).type === 'sub.init') as {
    id?: string; name: string; query: string;
  }[];
  assert.equal(inits.length, 1);
  assert.equal(inits[0]!.id, undefined, 'no id yet — the host assigns one on save');
  assert.equal(inits[0]!.name, '');
  assert.equal(inits[0]!.query, '');
});

test('an existing subscription inits with its id, name, and query', async () => {
  const { panel } = showEditor({ existing: EXISTING });
  assert.equal(panel.title, 'Edit Subscription — cars');
  await settled(panel);
  const inits = panel.webview.posted.filter(m => (m as { type: string }).type === 'sub.init') as {
    id?: string; name: string; query: string;
  }[];
  assert.deepEqual(inits[0], { type: 'sub.init', id: 'sub-1', name: 'cars', query: 'SELECT * FROM cars' });
});

test('focusing the panel activates the Inspector for subscriptions', async () => {
  const { panel, inspector } = showEditor();
  panel.fireViewState(true);
  assert.deepEqual(inspector.features, [{ kind: 'subscriptions', databaseId: DB_ID }]);
});

test('show() again for the same database reveals and re-inits the existing panel', async () => {
  const first = showEditor({ existing: EXISTING });
  await settled(first.panel);

  const other: StoredSubscription = { id: 'sub-2', name: 'trucks', query: 'SELECT * FROM trucks' };
  const s = fakeSubs();
  const m = fakeManager();
  SubscriptionEditorPanel.show(fakeContext(), s.subs, m.manager, DB_ID, fakeInspector().inspector, recordingLogger().logger, other);

  assert.equal(stub.createdWebviewPanels.length, 1, 'no second panel for the same database');
  assert.equal(first.panel.revealCount, 1);
  const inits = first.panel.webview.posted.filter(msg => (msg as { type: string }).type === 'sub.init') as {
    id?: string; name: string;
  }[];
  assert.equal(inits[inits.length - 1]!.id, 'sub-2', 're-inited with the newly-requested subscription');
});

// ─── Save: validation ──────────────────────────────────────────

test('save with a blank name or query is refused before touching the store', async () => {
  const { panel, subs, manager } = showEditor();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: '   ', query: 'SELECT * FROM cars' });
  panel.fireMessage({ type: 'sub.save', name: 'cars', query: '  ' });
  await waitFor(() => stub.window.shownErrors.length === 2);

  assert.deepEqual(stub.window.shownErrors, [
    'Name and query are required.',
    'Name and query are required.',
  ]);
  assert.deepEqual(subs.saved, [], 'nothing persisted');
  assert.deepEqual(manager.registered, [], 'nothing registered');
  assert.equal(panel.disposed, false, 'the panel stays open for another attempt');
});

// ─── Save: happy paths ─────────────────────────────────────────

test('saving a new subscription assigns an id, trims fields, and registers live', async () => {
  const { panel, subs, manager } = showEditor();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: '  cars  ', query: '  SELECT * FROM cars  ' });
  await waitFor(() => stub.window.shownInfos.length > 0);

  assert.equal(subs.saved.length, 1);
  assert.equal(subs.saved[0]!.databaseId, DB_ID);
  const saved = subs.saved[0]!.sub;
  assert.equal(saved.name, 'cars', 'name is trimmed');
  assert.equal(saved.query, 'SELECT * FROM cars', 'query is trimmed');
  assert.ok(typeof saved.id === 'string' && /^[0-9a-f]{32}$/.test(saved.id), 'a fresh 16-byte hex id was assigned');

  // The database is active: the live registration is replaced atomically.
  assert.deepEqual(manager.cancelled, [saved.id]);
  assert.deepEqual(manager.registered, [{ id: saved.id, query: 'SELECT * FROM cars' }]);

  assert.deepEqual(stub.window.shownInfos, ['Saved subscription "cars".']);
  assert.equal(panel.disposed, true, 'the editor closes after a successful save');
});

test('saving an existing subscription keeps its id and replaces the live registration', async () => {
  const { panel, subs, manager } = showEditor({ existing: EXISTING });
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', id: EXISTING.id, name: 'cars', query: 'SELECT * FROM cars WHERE make = :make' });
  await waitFor(() => stub.window.shownInfos.length > 0);

  assert.deepEqual(subs.saved.map(s => s.sub), [
    { id: 'sub-1', name: 'cars', query: 'SELECT * FROM cars WHERE make = :make' },
  ]);
  assert.deepEqual(manager.cancelled, ['sub-1']);
  assert.deepEqual(manager.registered, [{ id: 'sub-1', query: 'SELECT * FROM cars WHERE make = :make' }]);
});

test('saving while the database is not active persists without touching the SDK', async () => {
  const { panel, subs, manager } = showEditor({ manager: { activeConfigId: 'some-other-db' } });
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: 'cars', query: 'SELECT * FROM cars' });
  await waitFor(() => stub.window.shownInfos.length > 0);

  assert.equal(subs.saved.length, 1, 'still persisted');
  assert.deepEqual(manager.cancelled, [], 'no live registration to replace');
  assert.deepEqual(manager.registered, [], 'nothing registered against another session');
});

// ─── Cancel ────────────────────────────────────────────────────

test('sub.cancel closes the panel without saving', async () => {
  const { panel, subs } = showEditor();
  await settled(panel);
  panel.fireMessage({ type: 'sub.cancel' });
  assert.equal(panel.disposed, true);
  assert.deepEqual(subs.saved, []);
  assert.deepEqual(stub.window.shownInfos, []);
});

// ─── Failure surfacing ─────────────────────────────────────────

test('a failing store save surfaces through the wrapper and keeps the panel open', async () => {
  const { panel, subs, manager, log } = showEditor({ subs: { saved: [], failWith: new Error('disk is full') } });
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: 'cars', query: 'SELECT * FROM cars' });
  await waitFor(() => stub.window.shownErrors.length > 0);

  assert.deepEqual(stub.window.shownErrors, ['Save subscription failed: disk is full']);
  assert.deepEqual(subs.saved, [], 'the save never landed');
  assert.deepEqual(manager.registered, [], 'no live registration for a failed save');
  assert.deepEqual(stub.window.shownInfos, [], 'no false success toast');
  assert.equal(panel.disposed, false, 'the editor stays open so the user can retry');
  assert.ok(log.errors.some(m => m.includes('Save subscription failed')), 'the failure is logged');
});

// ─── Malformed messages ────────────────────────────────────────

test('a sub.save without its fields is a validation error, not a crash', async () => {
  // A version-skewed webview may post the message without name/query; the
  // handler destructures them undefined and the trim() call throws — which
  // must surface through the wrapper rather than escape into the dispatcher.
  const { panel, subs, log } = showEditor();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save' });
  await waitFor(() => stub.window.shownErrors.length > 0);
  assert.ok(
    stub.window.shownErrors[0]!.startsWith('Save subscription failed:'),
    `wrapped: ${stub.window.shownErrors[0]}`,
  );
  assert.deepEqual(subs.saved, []);
  assert.ok(log.errors.length > 0);
});

test('unknown message types are ignored without an error dialog', async () => {
  const { panel } = showEditor();
  await settled(panel);
  panel.fireMessage({ type: 'sub.someFutureVerb', id: 'x' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(stub.window.shownErrors, []);
  assert.equal(panel.disposed, false);
});
