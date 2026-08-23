import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Lifecycle contract every webview panel must satisfy.
 *
 * Fifteen of the sixteen panels had no coverage at all, and panels are where
 * this extension's bugs have actually been: undisposed subscriptions, tracker
 * slots outliving their panel, a static `current` left pointing at a disposed
 * panel. Those are structural failures with the same shape in every panel, so
 * one contract applied to all of them buys far more than fifteen bespoke suites
 * — and it automatically covers the sixteenth panel someone adds next.
 *
 * This is deliberately NOT a behaviour test. Dependencies are permissive stubs,
 * so nothing here asserts what a panel *does* with a message. It asserts that
 * constructing one and tearing it down leaves nothing behind. Per-panel
 * behaviour lives in its own file.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[]; shownWarnings: string[]; shownInfos: string[] };
  __resetStub(): void;
};

interface FakePanel {
  disposed: boolean;
  revealCount: number;
  options: { retainContextWhenHidden?: boolean; localResourceRoots?: unknown[] };
  viewType: string;
  webview: {
    html: string;
    posted: unknown[];
    _messageListeners: unknown[];
    cspSource: string;
  };
  _disposeListeners: unknown[];
  _viewStateListeners: unknown[];
  dispose(): void;
  fireMessage(msg: unknown): void;
  fireViewState(active: boolean): void;
}

/**
 * A stand-in for any dependency.
 *
 * Panels take between three and eight collaborators of unrelated shapes.
 * Writing bespoke fakes for each of the thirteen would be more test code than
 * the panels contain, so this answers any property access with something
 * plausible: a callable that returns another stub, an empty iteration, and a
 * string coercion so a stub can stand in for an id in a template literal.
 *
 * It is only sound because this file asserts structure, never behaviour. Any
 * test that cares what a panel does with its dependencies must build a real
 * fake instead.
 */
function anyStub(): never {
  const target = function stubbed(): void { /* callable */ } as unknown as object;
  return new Proxy(target, {
    get(_t, prop) {
      // Not a thenable: `await stub.read()` must resolve to the stub, not hang.
      if (prop === 'then') { return undefined; }
      if (prop === 'length') { return 0; }
      // Iterating a stub yields nothing rather than throwing.
      if (prop === Symbol.iterator) { return Array.prototype[Symbol.iterator]; }
      // Coercions, so a stub can be used as an id or in a template literal.
      if (prop === Symbol.toPrimitive) { return () => 'stub'; }
      if (prop === 'toString' || prop === 'valueOf') { return () => 'stub'; }
      if (prop === 'toJSON') { return () => 'stub'; }
      // Disposables are handed back and disposed by panels constantly.
      if (prop === 'dispose') { return () => { /* no-op */ }; }
      return anyStub();
    },
    apply() { return anyStub(); },
    construct() { return anyStub(); },
    has() { return true; },
  }) as never;
}

/** A context with the real shape panels need for Uri.joinPath and globalState. */
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

interface PanelUnderTest {
  name: string;
  /** Create one. Returns nothing useful — the panel is found via the stub. */
  show(): void;
  /** The panel's own static teardown, if it exposes one. */
  disposeAll?: () => void;
}

/** A stub, except where a real primitive is required. `path.join` and
 *  `Map` keys reject a Proxy, and an id that stringifies to "stub" makes a
 *  failure message useless, so ids and names are spelled out. */
const DB_ID = 'db-under-test';
const DB_NAME = 'DB Under Test';

/**
 * Argument lists, spelled out per panel rather than derived from `show.length`.
 *
 * Deriving them looked tidier but fed a Proxy everywhere, and the panels that
 * build a filesystem path or a Map key from a databaseId crashed on it. An
 * explicit list also means adding a panel here is a deliberate act, and the
 * next person can see exactly which collaborators are faked.
 */
const SHOW_ARGS: Record<string, () => unknown[]> = {
  AddIndexPanel:            () => [fakeContext(), anyStub(), anyStub()],
  DatabaseMetricsPanel:     () => [fakeContext(), anyStub(), anyStub(), DB_ID, anyStub(), anyStub()],
  ImportDataPanel:          () => [fakeContext(), anyStub(), anyStub(), anyStub(), DB_ID, anyStub()],
  ImportSubscriptionsPanel: () => [fakeContext(), anyStub(), anyStub(), anyStub(), anyStub(), DB_ID, anyStub()],
  LogAnalyzerPanel:         () => [fakeContext(), DB_ID, DB_NAME, anyStub(), () => Promise.resolve([]), anyStub(), anyStub()],
  ObserverEditorPanel:      () => [fakeContext(), anyStub(), DB_ID, anyStub(), anyStub()],
  ObserverPanel:            () => [fakeContext(), anyStub(), DB_ID, { id: 'obs-1', name: 'obs', query: 'SELECT * FROM t' }, anyStub(), anyStub()],
  PatternEditorPanel:       () => [fakeContext(), anyStub(), anyStub(), anyStub()],
  PeerListingPanel:         () => [fakeContext(), anyStub(), anyStub(), DB_ID, anyStub(), anyStub(), anyStub()],
  QueryMetricsPanel:        () => [fakeContext(), anyStub(), anyStub(), DB_ID, anyStub(), anyStub()],
  SubscriptionEditorPanel:  () => [fakeContext(), anyStub(), anyStub(), DB_ID, anyStub(), anyStub()],
  WelcomePanel:             () => [fakeContext(), anyStub(), anyStub()],
  DatabaseEditorPanel:      () => [fakeContext(), anyStub(), anyStub(), anyStub(), anyStub()],
  QueryEditorPanel:         () => [fakeContext(), anyStub(), anyStub(), anyStub(), DB_ID, anyStub(), anyStub(), anyStub(), anyStub(), anyStub(), anyStub()],
};

async function panels(): Promise<PanelUnderTest[]> {
  const mods = await Promise.all([
    import('../panels/AddIndexPanel.js'),
    import('../panels/DatabaseMetricsPanel.js'),
    import('../panels/ImportDataPanel.js'),
    import('../panels/ImportSubscriptionsPanel.js'),
    import('../panels/LogAnalyzerPanel.js'),
    import('../panels/ObserverEditorPanel.js'),
    import('../panels/ObserverPanel.js'),
    import('../panels/PatternEditorPanel.js'),
    import('../panels/PeerListingPanel.js'),
    import('../panels/QueryMetricsPanel.js'),
    import('../panels/SubscriptionEditorPanel.js'),
    import('../panels/WelcomePanel.js'),
    import('../panels/DatabaseEditorPanel.js'),
    import('../panels/QueryEditorPanel.js'),
  ]);
  const out: PanelUnderTest[] = [];
  for (const mod of mods) {
    for (const [name, value] of Object.entries(mod)) {
      const cls = value as { show?: (...a: unknown[]) => unknown; dispose?: () => void; disposeAll?: () => void };
      if (typeof cls?.show !== 'function') { continue; }
      const spec = SHOW_ARGS[name];
      // A new panel must be added to SHOW_ARGS deliberately rather than
      // silently skipped, or this whole contract quietly stops covering it.
      assert.ok(spec, `${name} exports a static show() but has no entry in SHOW_ARGS`);
      out.push({
        name,
        show: () => { cls.show!(...spec()); },
        disposeAll: typeof cls.disposeAll === 'function'
          ? () => cls.disposeAll!()
          : typeof cls.dispose === 'function' ? () => cls.dispose!() : undefined,
      });
    }
  }
  return out;
}

/** Tear every panel down so one case cannot leak into the next. */
function resetAll(all: PanelUnderTest[]): void {
  for (const p of all) { try { p.disposeAll?.(); } catch { /* best effort */ } }
  for (const panel of stub.createdWebviewPanels) { try { panel.dispose(); } catch { /* ignore */ } }
  stub.__resetStub();
}

test('every panel: constructs without throwing', async () => {
  const all = await panels();
  assert.ok(all.length >= 13, `expected the full panel set, found ${all.length}`);
  for (const p of all) {
    resetAll(all);
    assert.doesNotThrow(() => p.show(), `${p.name}.show() threw`);
    assert.ok(
      stub.createdWebviewPanels.length >= 1,
      `${p.name}.show() created no webview panel`,
    );
  }
  resetAll(all);
});

test('every panel: sets webview HTML with a CSP', async () => {
  // An empty or CSP-less document means the panel renders nothing, or renders
  // with script injection unguarded.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel.webview.html.length > 0, `${p.name} left html empty`);
    assert.match(panel.webview.html, /Content-Security-Policy/i, `${p.name} has no CSP`);
    assert.match(panel.webview.html, /default-src 'none'/, `${p.name} CSP does not deny by default`);
  }
  resetAll(all);
});

test('every panel: restricts localResourceRoots', async () => {
  // Without this a webview can read anything on disk the extension can.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const opts = stub.createdWebviewPanels[0].options;
    assert.ok(
      Array.isArray(opts.localResourceRoots),
      `${p.name} did not restrict localResourceRoots`,
    );
  }
  resetAll(all);
});

test('every panel: closing the webview removes its message listener', async () => {
  // The panel's own dispose runs from onDidDispose. A listener left attached
  // holds the panel and everything it closed over.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel.webview._messageListeners.length > 0, `${p.name} registered no handler`);

    panel.dispose(); // the user's X button
    await Promise.resolve();

    assert.equal(
      panel.webview._messageListeners.length, 0,
      `${p.name} left a message listener attached after close`,
    );
  }
  resetAll(all);
});

test('every panel: closing the webview removes its dispose and view-state listeners', async () => {
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    panel.dispose();
    await Promise.resolve();

    assert.equal(
      panel._disposeListeners.length, 0,
      `${p.name} left an onDidDispose listener attached`,
    );
    assert.equal(
      panel._viewStateListeners.length, 0,
      `${p.name} left an onDidChangeViewState listener attached`,
    );
  }
  resetAll(all);
});

test('every panel: the static teardown closes the webview', async () => {
  const all = await panels();
  for (const p of all) {
    if (!p.disposeAll) { continue; }
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.equal(panel.disposed, false);

    p.disposeAll();
    await Promise.resolve();

    assert.equal(panel.disposed, true, `${p.name}'s static dispose left the webview open`);
  }
  resetAll(all);
});

test('every panel: dispose is idempotent', async () => {
  // The static teardown and the user's X button race during a DB switch, so
  // both paths run. Neither may throw on the second pass.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.doesNotThrow(() => { panel.dispose(); panel.dispose(); }, `${p.name} double-dispose threw`);
    if (p.disposeAll) {
      assert.doesNotThrow(() => { p.disposeAll!(); p.disposeAll!(); }, `${p.name} double static dispose threw`);
    }
  }
  resetAll(all);
});

test('every panel: showing again after disposal builds a fresh panel', async () => {
  // The singleton bug: a static `current` left pointing at a disposed panel
  // makes the next show() reveal a dead webview, and the feature appears
  // broken until the window is reloaded.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const first = stub.createdWebviewPanels[0];
    first.dispose();
    await Promise.resolve();

    p.show();
    const created = stub.createdWebviewPanels;
    assert.ok(created.length >= 2, `${p.name} did not create a new panel after disposal`);
    assert.equal(created[created.length - 1].disposed, false, `${p.name} handed back a disposed panel`);
  }
  resetAll(all);
});

test('every panel: a message arriving after disposal does not throw', async () => {
  // Messages already in flight land after the panel is gone. Nothing may
  // escape into VS Code's event dispatcher.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    panel.dispose();
    await Promise.resolve();
    assert.doesNotThrow(
      () => panel.fireMessage({ type: 'definitely.not.a.real.message' }),
      `${p.name} threw on a post-disposal message`,
    );
  }
  resetAll(all);
});

test('every panel: an unknown message type is inert, not fatal', async () => {
  // The host and webview version independently across an extension update, so
  // an unrecognised type must be ignored rather than raise an error at the user.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.doesNotThrow(
      () => panel.fireMessage({ type: 'nonexistent.type.from.a.newer.webview' }),
      `${p.name} threw on an unknown message`,
    );
    await Promise.resolve();
    assert.deepEqual(
      stub.window.shownErrors, [],
      `${p.name} raised an error for an unknown message: ${JSON.stringify(stub.window.shownErrors)}`,
    );
  }
  resetAll(all);
});

test('every panel: a malformed message does not throw', async () => {
  // The webview is a separate process; a bug there must not take the host with
  // it. `webviewMessageHandler` is what makes this hold.
  const all = await panels();
  for (const p of all) {
    for (const bad of [undefined, null, {}, 'string', 42, []]) {
      resetAll(all);
      p.show();
      const panel = stub.createdWebviewPanels[0];
      assert.doesNotThrow(
        () => panel.fireMessage(bad),
        `${p.name} threw on message ${JSON.stringify(bad)}`,
      );
    }
  }
  resetAll(all);
});

test('every panel: a view-state change does not throw', async () => {
  // Panels route the Inspector on focus. Firing this on a live and a disposed
  // panel covers both the normal path and the tab-closed race.
  const all = await panels();
  for (const p of all) {
    resetAll(all);
    p.show();
    const panel = stub.createdWebviewPanels[0];
    assert.doesNotThrow(() => { panel.fireViewState(true); panel.fireViewState(false); }, `${p.name} threw on focus change`);
    panel.dispose();
    await Promise.resolve();
    assert.doesNotThrow(() => panel.fireViewState(true), `${p.name} threw on focus change after disposal`);
  }
  resetAll(all);
});
