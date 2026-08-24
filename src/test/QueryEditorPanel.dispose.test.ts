import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QueryEditorPanel } from '../panels/QueryEditorPanel.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { Logger, LogLevel } from '../logging/types.js';

// The stub's recorders are module-global, like the real editor's panel
// registry. `__resetStub` is only on the stub, not on the vscode typings.
const stub = vscode as unknown as {
  createdWebviewPanels: { disposed: boolean; dispose(): void }[];
  __resetStub(): void;
};

/** In-memory Memento so the real OpenPanelsTracker can be used rather than
 *  faked — the thing under test is how the panel and the tracker interact,
 *  and a faked tracker would only assert that the panel called the method we
 *  told it to call. */
function memento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T) =>
      (store.has(key) ? store.get(key) : defaultValue) as T,
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  };
}

const noopLogger = (): Logger => {
  const self: Logger = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return self;
};

/** Minimal collaborators — the panel only reaches for these on user actions,
 *  which this test does not drive. Construction and dispose is the subject. */
function deps(tracker: OpenPanelsTracker) {
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const logger = noopLogger();
  return [
    context,
    { getCurrentLifecycleState: () => ({ kind: 'idle' }) } as never, // manager
    { get: () => undefined } as never,                               // configs
    { read: async () => ({}) } as never,                             // secrets
    'db-A',
    tracker,
    { setActiveFeature: () => {}, setLastResultMetadata: () => {}, setSelectedRowJson: () => {} } as never,
    { list: () => [] } as never,                                     // history
    { list: () => [] } as never,                                     // favorites
    { forDatabase: () => [] } as never,                              // metrics
    logger,
  ];
}

function show(tracker: OpenPanelsTracker): QueryEditorPanel {
  const panel = QueryEditorPanel.show(...(deps(tracker) as unknown as Parameters<typeof QueryEditorPanel.show>));
  assert.ok(panel, 'this test never approaches MAX_OPEN_QUERY_TABS');
  return panel;
}

test('QueryEditorPanel: a user-closed tab releases its tracker slot', async () => {
  stub.__resetStub();
  const tracker = new OpenPanelsTracker(memento());
  show(tracker);
  assert.equal(tracker.get('db-A').query.length, 1, 'registered on construction');

  // The X button: VS Code disposes the panel and the handler runs from
  // onDidDispose. Nothing set preserveTabs, so the slot must go — otherwise
  // reconnect restores a tab the user deliberately closed.
  stub.createdWebviewPanels[0]!.dispose();
  await Promise.resolve();

  assert.equal(tracker.get('db-A').query.length, 0, 'slot released');
});

test('QueryEditorPanel: an orchestrated teardown keeps the slot for restore', async () => {
  stub.__resetStub();
  const tracker = new OpenPanelsTracker(memento());
  show(tracker);
  show(tracker);
  assert.equal(tracker.get('db-A').query.length, 2);

  // What the DB-switch orchestrator does. The pre-switch modal promises the
  // user these will reopen, so disposing must not delete the entries
  // restorePanels is about to read.
  QueryEditorPanel.dispose({ preserveTabs: true });
  await Promise.resolve();

  assert.equal(tracker.get('db-A').query.length, 2, 'slots preserved for restore');
  assert.ok(stub.createdWebviewPanels.every(p => p.disposed), 'panels still closed');
});

test('QueryEditorPanel: a plain teardown releases only its own slot', async () => {
  stub.__resetStub();
  const tracker = new OpenPanelsTracker(memento());

  // Preserve one tab's slot, the way a DB switch does…
  show(tracker);
  QueryEditorPanel.dispose({ preserveTabs: true });
  await Promise.resolve();
  assert.equal(tracker.get('db-A').query.length, 1, 'preserved for restore');

  // …then open a new tab and close it plainly. The flag must not latch: the
  // new panel releases its own slot, and the preserved one is untouched
  // because no live panel owns it any more.
  show(tracker);
  assert.equal(tracker.get('db-A').query.length, 2, 'the new tab took its own slot');
  QueryEditorPanel.dispose();
  await Promise.resolve();
  assert.equal(tracker.get('db-A').query.length, 1, 'only the new tab was released');

  // The preserved slot is not a leak: connect clears the slate before
  // replaying it, so it cannot accumulate across reconnects.
  await tracker.clearQueryTabs('db-A');
  assert.equal(tracker.get('db-A').query.length, 0);
});

test('QueryEditorPanel: dispose is idempotent and unsubscribes the webview', async () => {
  stub.__resetStub();
  const tracker = new OpenPanelsTracker(memento());
  show(tracker);
  const panel = stub.createdWebviewPanels[0] as unknown as {
    dispose(): void;
    webview: { _messageListeners: unknown[] };
  };

  panel.dispose();
  await Promise.resolve();
  assert.equal(panel.webview._messageListeners.length, 0, 'message listener removed');

  // A second dispose (e.g. the static teardown racing the user's X) must not
  // throw or double-release.
  panel.dispose();
  QueryEditorPanel.dispose();
  await Promise.resolve();
  assert.equal(tracker.get('db-A').query.length, 0);
});
