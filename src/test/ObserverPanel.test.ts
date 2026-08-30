import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ObserverPanel } from '../panels/ObserverPanel.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { StoredObserver } from '../models/StoredObserver.js';
import type { Logger, LogContext } from '../logging/types.js';
import type { ObserverEvent } from '../ditto/ObserverEventStore.js';

/**
 * ObserverPanel behaviour, driven through the vscode stub's fake webview
 * panels: activation lifecycle, the 100ms event-batch flush, error paths, and
 * disposal. The DittoManager is faked at its public surface — the real
 * manager↔SDK observer behaviour is covered in DittoManager.behavior.test.ts;
 * here the panel's own bookkeeping is the subject.
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
const OBSERVER: StoredObserver = { id: 'obs-1', name: 'watches', query: 'SELECT * FROM things' };

function recordingLogger(): { logger: Logger; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const self = {
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, errors, warns };
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

interface ManagerFake {
  activeConfigId: string | null;
  registerCalls: string[];
  cancels: number;
  /** Set by the panel on activation — tests fire observer events from it. */
  callback: ((event: {
    rows: Record<string, unknown>[];
    totalRows: number;
    insertions: number[];
    updates: number[];
    deletions: number[];
    moves: Array<{ from: number; to: number }>;
  }) => void) | null;
  /** When true, registerObserver returns null (as a session-less manager does). */
  refuseRegister: boolean;
}

function fakeManager(over: Partial<ManagerFake> = {}): { manager: DittoManager; fake: ManagerFake } {
  const fake: ManagerFake = {
    activeConfigId: DB_ID,
    registerCalls: [],
    cancels: 0,
    callback: null,
    refuseRegister: false,
    ...over,
  };
  const manager = {
    getActiveConfigId: () => fake.activeConfigId,
    registerObserver: (query: string, cb: ManagerFake['callback']) => {
      fake.registerCalls.push(query);
      if (fake.refuseRegister) { return null; }
      fake.callback = cb;
      return { cancel: () => { fake.cancels += 1; } };
    },
  } as unknown as DittoManager;
  return { manager, fake };
}

function fakeInspector(): { inspector: InspectorController; features: unknown[]; rows: (string | null)[] } {
  const features: unknown[] = [];
  const rows: (string | null)[] = [];
  const inspector = {
    setActiveFeature: (f: unknown) => { features.push(f); },
    setSelectedRowJson: (j: string | null) => { rows.push(j); },
  } as unknown as InspectorController;
  return { inspector, features, rows };
}

/** show() and return the pieces every test reaches for. */
function showPanel(
  over: Partial<ManagerFake> = {},
  observer: StoredObserver = OBSERVER,
): { panel: FakePanel; fake: ManagerFake; inspector: ReturnType<typeof fakeInspector>; log: ReturnType<typeof recordingLogger> } {
  const { manager, fake } = fakeManager(over);
  const inspector = fakeInspector();
  const log = recordingLogger();
  ObserverPanel.show(fakeContext(), manager, DB_ID, observer, inspector.inspector, log.logger);
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  return { panel, fake, inspector, log };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The constructor pushes init on a 50ms timer — wait for it. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(m => (m as { type: string }).type === 'observer.init'));
}

function postedOfType<T>(panel: FakePanel, type: string): T[] {
  return panel.webview.posted.filter(m => (m as { type: string }).type === type) as T[];
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { ObserverPanel.disposeAll(); stub.__resetStub(); });

// ─── Construction / init ───────────────────────────────────────

test('init posts the observer identity and an inactive status', async () => {
  const { panel } = showPanel();
  assert.equal(panel.title, 'Observer — watches');
  await settled(panel);

  const inits = postedOfType<{ observer: { id: string; name: string; query: string } }>(panel, 'observer.init');
  assert.equal(inits.length, 1);
  assert.deepEqual(inits[0]!.observer, { id: 'obs-1', name: 'watches', query: 'SELECT * FROM things' });

  const statuses = postedOfType<{ active: boolean }>(panel, 'observer.statusChanged');
  assert.deepEqual(statuses.map(s => s.active), [false], 'starts inactive');
});

test('focusing the panel activates the Inspector for this observer', async () => {
  const { panel, inspector } = showPanel();
  panel.fireViewState(true);
  assert.deepEqual(inspector.features, [
    { kind: 'observers', databaseId: DB_ID, observerId: 'obs-1', tab: 'json' },
  ]);
});

test('show() for an already-open observer reveals and re-syncs instead of duplicating', async () => {
  const first = showPanel();
  await settled(first.panel);

  const renamed: StoredObserver = { id: 'obs-1', name: 'renamed', query: 'SELECT * FROM other' };
  const { manager } = fakeManager();
  ObserverPanel.show(fakeContext(), manager, DB_ID, renamed, fakeInspector().inspector, recordingLogger().logger);

  assert.equal(stub.createdWebviewPanels.length, 1, 'no second panel for the same observer');
  assert.equal(first.panel.revealCount, 1);
  assert.equal(first.panel.title, 'Observer — renamed');
  const inits = postedOfType<{ observer: { name: string; query: string } }>(first.panel, 'observer.init');
  assert.equal(inits[inits.length - 1]!.observer.name, 'renamed');
  assert.equal(inits[inits.length - 1]!.observer.query, 'SELECT * FROM other');
});

// ─── Activation ────────────────────────────────────────────────

test('activate registers the observer query and posts active status', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => postedOfType(panel, 'observer.statusChanged').some(s => (s as { active: boolean }).active));

  assert.deepEqual(fake.registerCalls, ['SELECT * FROM things']);
  const statuses = postedOfType<{ active: boolean }>(panel, 'observer.statusChanged');
  assert.deepEqual(statuses.map(s => s.active), [false, true]);
  assert.deepEqual(stub.window.shownWarnings, []);
});

test('activate against the wrong database warns and registers nothing', async () => {
  const { panel, fake } = showPanel({ activeConfigId: 'some-other-db' });
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => stub.window.shownWarnings.length > 0);

  assert.deepEqual(stub.window.shownWarnings, ['Connect to this database first.']);
  assert.deepEqual(fake.registerCalls, [], 'never reached the manager');
  assert.deepEqual(
    postedOfType(panel, 'observer.statusChanged').map(s => (s as { active: boolean }).active),
    [false],
    'no spurious activation',
  );
});

test('a session-less register (null handle) warns and stays inactive', async () => {
  const { panel, fake } = showPanel({ refuseRegister: true });
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => stub.window.shownWarnings.length > 0);

  assert.deepEqual(stub.window.shownWarnings, ['Could not register observer — no active session.']);
  assert.deepEqual(fake.registerCalls, ['SELECT * FROM things'], 'the register was attempted');
  const statuses = postedOfType<{ active: boolean }>(panel, 'observer.statusChanged');
  assert.deepEqual(statuses.map(s => s.active), [false, false], 'the retry status is posted as inactive');
});

test('a double-activate registers only once', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.registerCalls.length > 0);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(fake.registerCalls, ['SELECT * FROM things'], 'the second click was a no-op');
});

// ─── Event batching ────────────────────────────────────────────

test('observer events are batched into one observer.events post per flush window', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  const fire = (n: number) => fake.callback!({
    rows: [{ n }],
    totalRows: 1,
    insertions: [0],
    updates: [],
    deletions: [],
    moves: [],
  });
  fire(1); fire(2); fire(3); // inside the 100ms window

  await waitFor(() => postedOfType(panel, 'observer.events').length > 0);
  const batches = postedOfType<{ events: ObserverEvent[] }>(panel, 'observer.events');
  assert.equal(batches.length, 1, 'three firings coalesced into one post');
  assert.equal(batches[0]!.events.length, 3, 'all three events are in the batch');
  assert.deepEqual(batches[0]!.events.map(e => (e.data[0] as { n: number }).n), [1, 2, 3]);
});

test('each event carries rows, the uncapped totalRows, and diff indexes', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  // What the manager ships when the result set exceeds OBSERVER_ROW_CAP:
  // rows capped, totalRows honest — the webview's "first N of M" banner data.
  fake.callback!({
    rows: [{ _id: 'r1' }],
    totalRows: 5230,
    insertions: [4, 5],
    updates: [1],
    deletions: [2],
    moves: [{ from: 0, to: 3 }],
  });
  await waitFor(() => postedOfType(panel, 'observer.events').length > 0);

  const batch = postedOfType<{ events: ObserverEvent[] }>(panel, 'observer.events')[0]!;
  const ev = batch.events[0]!;
  assert.ok(ev.id.length === 16, 'event id is an 8-byte hex string');
  assert.ok(!Number.isNaN(Date.parse(ev.eventTimeISO)), 'event carries an ISO timestamp');
  assert.deepEqual(ev.data, [{ _id: 'r1' }]);
  assert.equal(ev.totalRows, 5230, 'the banner can say "first 1 of 5230"');
  assert.deepEqual(ev.insertions, [4, 5]);
  assert.deepEqual(ev.updates, [1]);
  assert.deepEqual(ev.deletions, [2]);
  assert.deepEqual(ev.moves, [{ from: 0, to: 3 }]);
});

test('a second burst after the flush posts a second batch', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  const fire = (n: number) => fake.callback!({
    rows: [{ n }], totalRows: 1, insertions: [], updates: [], deletions: [], moves: [],
  });
  fire(1);
  await waitFor(() => postedOfType(panel, 'observer.events').length === 1);
  fire(2);
  await waitFor(() => postedOfType(panel, 'observer.events').length === 2);

  const batches = postedOfType<{ events: ObserverEvent[] }>(panel, 'observer.events');
  assert.equal(batches[1]!.events.length, 1);
  assert.deepEqual(batches[1]!.events[0]!.data, [{ n: 2 }]);
});

// ─── Stop / dispose ────────────────────────────────────────────

test('stop cancels the SDK handle, drops pending events, and posts cleared + inactive', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  // Enqueue an event but stop before the 100ms flush.
  fake.callback!({ rows: [{ n: 1 }], totalRows: 1, insertions: [], updates: [], deletions: [], moves: [] });
  panel.fireMessage({ type: 'observer.stop' });
  await waitFor(() => postedOfType(panel, 'observer.cleared').length > 0);
  await new Promise(r => setTimeout(r, 150)); // the cancelled flush would have fired

  assert.equal(fake.cancels, 1, 'the SDK observer was cancelled');
  assert.equal(postedOfType(panel, 'observer.events').length, 0, 'the pending event was dropped, not flushed');
  const statuses = postedOfType<{ active: boolean }>(panel, 'observer.statusChanged');
  assert.deepEqual(statuses.map(s => s.active), [false, true, false]);
});

test('stop while never activated posts cleared without touching the manager', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.stop' });
  await waitFor(() => postedOfType(panel, 'observer.cleared').length > 0);
  assert.equal(fake.cancels, 0, 'nothing to cancel');
  assert.deepEqual(
    postedOfType(panel, 'observer.statusChanged').map(s => (s as { active: boolean }).active),
    [false, false],
  );
});

test('disposing an active panel cancels the observer', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  panel.dispose(); // the user's X
  assert.equal(fake.cancels, 1, 'the SDK observer was cancelled on dispose');
});

test('disposeForDatabase closes only that database\'s panels', async () => {
  const mine = showPanel();
  const otherObserver: StoredObserver = { id: 'obs-9', name: 'other', query: 'SELECT 1' };
  const { manager } = fakeManager({ activeConfigId: 'other-db' });
  ObserverPanel.show(fakeContext(), manager, 'other-db', otherObserver, fakeInspector().inspector, recordingLogger().logger);
  assert.equal(stub.createdWebviewPanels.length, 2);

  ObserverPanel.disposeForDatabase(DB_ID);
  assert.equal(mine.panel.disposed, true, 'mine closed');
  assert.equal(stub.createdWebviewPanels[1]!.disposed, false, 'the other database\'s panel survived');
});

test('disposeOne closes a single observer\'s panel', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.callback !== null);

  ObserverPanel.disposeOne(DB_ID, 'obs-1');
  assert.equal(panel.disposed, true);
  assert.equal(fake.cancels, 1);

  // A second call is a no-op (the panel is out of the registry).
  ObserverPanel.disposeOne(DB_ID, 'obs-1');
});

// ─── Inspector / misc message routing ──────────────────────────

test('observer.rowSelected forwards the row JSON to the Inspector', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.rowSelected', rowJson: '{"_id":"a"}' });
  assert.deepEqual(inspector.rows, ['{"_id":"a"}']);
});

test('observer.eventSelected is acknowledged without Inspector side effects', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.eventSelected', eventId: 'abc' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(inspector.rows, [], 'selection stays in the webview');
  assert.deepEqual(stub.window.shownErrors, []);
});

// ─── Update while open ─────────────────────────────────────────

test('refreshIfOpen re-inits an idle panel without registering anything', async () => {
  const { panel, fake } = showPanel();
  await settled(panel);
  const updated: StoredObserver = { id: 'obs-1', name: 'now-better', query: 'SELECT * FROM new' };

  ObserverPanel.refreshIfOpen(DB_ID, updated);
  assert.equal(panel.title, 'Observer — now-better');
  const inits = postedOfType<{ observer: { query: string } }>(panel, 'observer.init');
  assert.equal(inits[inits.length - 1]!.observer.query, 'SELECT * FROM new');
  assert.deepEqual(fake.registerCalls, [], 'an idle observer stays idle');

  ObserverPanel.refreshIfOpen('some-other-db', updated); // no panel — no-op
});

test('refreshIfOpen restarts an ACTIVE observer against the new query', async () => {
  // Saving over an active observer must cancel the old query's handle and
  // register the new one, or the panel keeps streaming the old result set
  // under the new name.
  const { panel, fake } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => fake.registerCalls.length === 1);

  const updated: StoredObserver = { id: 'obs-1', name: 'watches', query: 'SELECT * FROM rewritten' };
  ObserverPanel.refreshIfOpen(DB_ID, updated);

  await waitFor(() => fake.registerCalls.length === 2);
  assert.equal(fake.cancels, 1, 'the old handle was cancelled');
  assert.deepEqual(fake.registerCalls, ['SELECT * FROM things', 'SELECT * FROM rewritten']);
  const statuses = postedOfType<{ active: boolean }>(panel, 'observer.statusChanged');
  // pushInit runs first (re-posts the still-active state), then stop →
  // re-activate: the panel never reports active against the OLD query after
  // the refresh.
  assert.deepEqual(statuses.map(s => s.active), [false, true, true, false, true]);
});

// ─── Error surfacing ───────────────────────────────────────────

test('a throwing activation is surfaced through the wrapper, not swallowed', async () => {
  const { manager } = fakeManager();
  (manager as unknown as { registerObserver: () => never }).registerObserver = () => {
    throw new Error('kaboom from the manager');
  };
  const log = recordingLogger();
  ObserverPanel.show(fakeContext(), manager, DB_ID, OBSERVER, fakeInspector().inspector, log.logger);
  const panel = stub.createdWebviewPanels[0]!;
  await settled(panel);

  panel.fireMessage({ type: 'observer.activate' });
  await waitFor(() => stub.window.shownErrors.length > 0);
  assert.deepEqual(stub.window.shownErrors, ['Observer action failed: kaboom from the manager']);
  assert.ok(log.errors.some(m => m.includes('Observer action failed')), 'logged too');
});

test('observer.rowSelected with a missing payload surfaces instead of throwing', async () => {
  // A version-skewed webview can send the message without the field; the
  // Inspector receives undefined where it expects string|null — the panel
  // forwards it as-is (inspector contract), and nothing escapes the wrapper.
  const { panel, inspector } = showPanel();
  await settled(panel);
  panel.fireMessage({ type: 'observer.rowSelected' });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(inspector.rows, [undefined]);
  assert.deepEqual(stub.window.shownErrors, []);
});
