import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QueryEditorPanel, MAX_OPEN_QUERY_TABS } from '../panels/QueryEditorPanel.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { Logger, LogLevel } from '../logging/types.js';

// The stub's recorders are module-global, like the real editor's panel
// registry. `__resetStub` is only on the stub, not on the vscode typings.
const stub = vscode as unknown as {
  createdWebviewPanels: { disposed: boolean; dispose(): void }[];
  window: { shownInfos: string[] };
  __resetStub(): void;
};

/** In-memory Memento so the real OpenPanelsTracker counts the live tabs —
 *  the cap must gate the tracker slots as well as the webview panels. */
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
 *  which this test does not drive. Tab creation/refusal is the subject. */
function deps(tracker: OpenPanelsTracker) {
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
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
    noopLogger(),
  ];
}

/** Drive the same static entry point production uses (dittoVsce.openQueryEditor
 *  → extension.ts → QueryEditorPanel.show). */
function show(tracker: OpenPanelsTracker): QueryEditorPanel | undefined {
  return QueryEditorPanel.show(...(deps(tracker) as unknown as Parameters<typeof QueryEditorPanel.show>));
}

function reset(): void {
  QueryEditorPanel.dispose();
  stub.__resetStub();
}

test('QueryEditorPanel: the (MAX+1)th tab is refused with no side effects', () => {
  reset();
  const tracker = new OpenPanelsTracker(memento());

  for (let i = 0; i < MAX_OPEN_QUERY_TABS; i++) {
    assert.ok(show(tracker), `tab ${i + 1} of ${MAX_OPEN_QUERY_TABS} should open`);
  }
  assert.equal(stub.createdWebviewPanels.length, MAX_OPEN_QUERY_TABS);
  assert.equal(tracker.get('db-A').query.length, MAX_OPEN_QUERY_TABS);
  assert.deepEqual(stub.window.shownInfos, [], 'no toast below the cap');

  const refused = show(tracker);
  assert.equal(refused, undefined, 'returns undefined at the cap');
  assert.equal(
    stub.createdWebviewPanels.length, MAX_OPEN_QUERY_TABS,
    'no webview panel created for the refused tab',
  );
  assert.equal(
    tracker.get('db-A').query.length, MAX_OPEN_QUERY_TABS,
    'no tracker slot taken by the refused tab',
  );
  assert.deepEqual(stub.window.shownInfos, [
    `You have ${MAX_OPEN_QUERY_TABS} query tabs open. Close one to open another.`,
  ]);

  reset();
});

test('QueryEditorPanel: a closed tab frees room under the cap', () => {
  reset();
  const tracker = new OpenPanelsTracker(memento());

  for (let i = 0; i < MAX_OPEN_QUERY_TABS; i++) { show(tracker); }

  // The X button on one tab — the cap counts live tabs only, so this must
  // free exactly one slot.
  stub.createdWebviewPanels[0]!.dispose();

  const reopened = show(tracker);
  assert.ok(reopened, 'a new tab opens once one tab closed');
  assert.equal(stub.createdWebviewPanels.length, MAX_OPEN_QUERY_TABS + 1,
    'the stub records every created panel, disposed or not — count ALL created');
  assert.deepEqual(stub.window.shownInfos, [], 'no refusal toast after freeing a slot');

  // One more is refused again — the count is back at MAX live tabs.
  assert.equal(show(tracker), undefined);
  assert.equal(stub.window.shownInfos.length, 1);

  reset();
});
