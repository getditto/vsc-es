import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ObserverEditorPanel } from '../panels/ObserverEditorPanel.js';
import type { ObserverStore } from '../storage/ObserverStore.js';
import type { StoredObserver } from '../models/StoredObserver.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * ObserverEditorPanel behaviour, driven through the vscode stub's fake
 * webview panels: the singleton reveal/replace rules, the init payload, the
 * save-validation gates, and the save → store → close flow. The store and
 * inspector are faked at their public surfaces; ObserverPanel.refreshIfOpen
 * is a no-op here because no observer panel is open in this process.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[]; shownInfos: string[] };
  commands: { executed: { command: string; args: unknown[] }[] };
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
const EXISTING: StoredObserver = { id: 'obs-1', name: 'watches', query: 'SELECT * FROM things' };

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
    globalState: {
      keys: () => [...store.keys()],
      get: <T>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

interface StoreFake {
  saved: { databaseId: string; observer: StoredObserver }[];
  failWith?: Error;
}

function fakeStore(over: Partial<StoreFake> = {}): { store: ObserverStore; fake: StoreFake } {
  const fake: StoreFake = { saved: [], ...over };
  const store = {
    save: async (databaseId: string, observer: StoredObserver) => {
      if (fake.failWith) { throw fake.failWith; }
      fake.saved.push({ databaseId, observer });
    },
  } as unknown as ObserverStore;
  return { store, fake };
}

function fakeInspector(): { inspector: InspectorController; features: unknown[] } {
  const features: unknown[] = [];
  const inspector = {
    setActiveFeature: (f: unknown) => { features.push(f); },
  } as unknown as InspectorController;
  return { inspector, features };
}

function showPanel(opts: {
  existing?: StoredObserver;
  databaseId?: string;
  store?: StoreFake;
} = {}): {
  panel: FakePanel;
  store: StoreFake;
  inspector: ReturnType<typeof fakeInspector>;
  log: ReturnType<typeof recordingLogger>;
} {
  const { store, fake } = fakeStore(opts.store);
  const inspector = fakeInspector();
  const log = recordingLogger();
  ObserverEditorPanel.show(
    fakeContext(), store, opts.databaseId ?? DB_ID, inspector.inspector, log.logger, opts.existing,
  );
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  return { panel, store: fake, inspector, log };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The constructor pushes sub.init on a 50ms timer — wait for it. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(m => (m as { type: string }).type === 'sub.init'));
}

function postedOfType<T>(panel: FakePanel, type: string): T[] {
  return panel.webview.posted.filter(m => (m as { type: string }).type === type) as T[];
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { ObserverEditorPanel.dispose(); stub.__resetStub(); });

// ─── Construction / init ───────────────────────────────────────

test('a new observer initialises with empty name and query', async () => {
  const { panel } = showPanel();
  assert.equal(panel.title, 'New Observer');
  await settled(panel);

  const inits = postedOfType<{ id?: string; name: string; query: string }>(panel, 'sub.init');
  assert.equal(inits.length, 1);
  assert.equal(inits[0]?.id, undefined, 'no id until the save mints one');
  assert.equal(inits[0]?.name, '');
  assert.equal(inits[0]?.query, '');
});

test('an existing observer initialises with its id, name, and query', async () => {
  const { panel } = showPanel({ existing: EXISTING });
  assert.equal(panel.title, 'Edit Observer — watches');
  await settled(panel);

  const inits = postedOfType<{ id?: string; name: string; query: string }>(panel, 'sub.init');
  assert.equal(inits.length, 1);
  assert.equal(inits[0]?.id, 'obs-1');
  assert.equal(inits[0]?.name, 'watches');
  assert.equal(inits[0]?.query, 'SELECT * FROM things');
});

test('showing again for the same database reveals and re-initialises instead of duplicating', async () => {
  const { panel } = showPanel();
  await settled(panel);

  ObserverEditorPanel.show(
    fakeContext(), fakeStore().store, DB_ID, fakeInspector().inspector, recordingLogger().logger,
    EXISTING,
  );

  assert.equal(stub.createdWebviewPanels.length, 1, 'still one panel');
  assert.equal(panel.revealCount, 1);
  await waitFor(() => postedOfType(panel, 'sub.init').length === 2);
  const inits = postedOfType<{ id?: string }>(panel, 'sub.init');
  assert.equal(inits[1]?.id, 'obs-1', 'the reveal re-inits with the observer being edited');
});

test('showing for a different database replaces the panel', async () => {
  const { panel: first } = showPanel();
  await settled(first);

  showPanel({ databaseId: 'db-other' });

  assert.equal(first.disposed, true, 'the other-DB editor is disposed');
  assert.equal(stub.createdWebviewPanels.length, 2, 'a fresh panel was built');
});

test('the static dispose closes a live panel', async () => {
  const { panel } = showPanel();
  await settled(panel);

  ObserverEditorPanel.dispose();

  assert.equal(panel.disposed, true);
});

test('focusing the panel routes the Inspector to the subscriptions help', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);

  panel.fireViewState(false);
  assert.equal(inspector.features.length, 0, 'inactive changes do not re-route the Inspector');
  panel.fireViewState(true);

  assert.deepEqual(inspector.features, [{ kind: 'subscriptions', databaseId: DB_ID }]);
});

// ─── sub.cancel ────────────────────────────────────────────────

test('sub.cancel closes the editor without saving', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'sub.cancel' });
  await Promise.resolve();

  assert.equal(panel.disposed, true);
  assert.equal(store.saved.length, 0);
});

// ─── sub.save validation ───────────────────────────────────────

test('sub.save refuses a blank name or query', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: '   ', query: 'SELECT * FROM t' });
  panel.fireMessage({ type: 'sub.save', name: 'ok', query: '  ' });
  await Promise.resolve();

  assert.equal(store.saved.length, 0, 'nothing reached the store');
  assert.deepEqual(stub.window.shownErrors, [
    'Name and query are required.',
    'Name and query are required.',
  ]);
  assert.equal(panel.disposed, false, 'the editor stays open so the user can fix the input');
});

test('sub.save refuses a non-SELECT query', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: 'n', query: 'DELETE FROM t' });
  await Promise.resolve();

  assert.equal(store.saved.length, 0);
  assert.deepEqual(stub.window.shownErrors, ['Observer queries must be SELECT statements.']);
});

test('sub.save accepts a SELECT with leading whitespace and any casing', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: 'n', query: '\n  select * from t' });
  await waitFor(() => store.saved.length === 1);

  assert.equal(store.saved[0]?.observer.query, 'select * from t');
  assert.deepEqual(stub.window.shownErrors, []);
});

// ─── sub.save success ──────────────────────────────────────────

test('saving a new observer mints an id, trims, and closes', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: '  watches  ', query: '  SELECT * FROM things  ' });
  await waitFor(() => store.saved.length === 1);

  const saved = store.saved[0];
  assert.equal(saved?.databaseId, DB_ID);
  assert.equal(saved?.observer.name, 'watches', 'name is trimmed');
  assert.equal(saved?.observer.query, 'SELECT * FROM things', 'query is trimmed');
  assert.match(saved?.observer.id ?? '', /^[0-9a-f]{32}$/, 'a 16-byte hex id was minted');

  assert.deepEqual(stub.window.shownInfos, ['Saved observer "watches".']);
  await waitFor(() => panel.disposed, 1000);
});

test('saving an existing observer keeps its id', async () => {
  const { store } = showPanel({ existing: EXISTING });
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settled(panel);

  panel.fireMessage({
    type: 'sub.save', id: 'obs-1', name: 'renamed', query: 'SELECT * FROM other',
  });
  await waitFor(() => store.saved.length === 1);

  assert.deepEqual(store.saved[0]?.observer, {
    id: 'obs-1', name: 'renamed', query: 'SELECT * FROM other',
  });
});

test('a store failure surfaces through the wrapper and keeps the editor open', async () => {
  const { panel, log } = showPanel({ store: { saved: [], failWith: new Error('disk full') } });
  await settled(panel);

  panel.fireMessage({ type: 'sub.save', name: 'n', query: 'SELECT * FROM t' });
  await waitFor(() => stub.window.shownErrors.length === 1);

  assert.deepEqual(stub.window.shownErrors, ['Save observer failed: disk full']);
  assert.deepEqual(log.errors, ['Save observer failed'], 'the failure is logged with the tag');
  assert.equal(panel.disposed, false, 'the editor survives so the user can retry');
});
