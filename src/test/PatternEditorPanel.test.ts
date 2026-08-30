import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { PatternEditorPanel } from '../panels/PatternEditorPanel.js';
import type { PatternStore } from '../logAnalyzer/PatternStore.js';
import type { KeyedRawPattern } from '../logAnalyzer/PatternEngine.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * PatternEditorPanel behaviour through the vscode stub's fake webview panels:
 * the singleton reveal, the snapshot push (initial + on store change), the
 * save/delete fan-out, and failure surfacing back to the webview as
 * `patternEditor.saveFailed` (never a thrown IPC boundary). The PatternStore
 * is faked at its public surface so failures are scriptable; its own
 * persistence logic is covered in PatternStore.test.ts.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  __resetStub(): void;
};

interface FakePanel {
  title: string;
  disposed: boolean;
  revealCount: number;
  iconPath: unknown;
  webview: { posted: unknown[]; html: string };
  dispose(): void;
  fireMessage(msg: unknown): void;
  fireViewState(active: boolean): void;
}

const PATTERN: KeyedRawPattern = {
  key: 'user.my-pattern',
  pattern: 'ERROR',
  severity: 3,
  recommendation: 'look into it',
};

const BUNDLED: KeyedRawPattern = {
  key: 'ditto.sync.failed',
  pattern: 'sync failed',
  severity: 4,
  recommendation: 'check the network',
};

interface StoreFake {
  bundled: KeyedRawPattern[];
  user: KeyedRawPattern[];
  added: KeyedRawPattern[];
  updated: { key: string; pattern: KeyedRawPattern }[];
  deleted: string[];
  failWith?: Error;
  changeListeners: (() => void)[];
  disposedSubs: number;
}

function fakeStore(over: Partial<StoreFake> = {}): { store: PatternStore; fake: StoreFake } {
  const fake: StoreFake = {
    bundled: [BUNDLED],
    user: [],
    added: [],
    updated: [],
    deleted: [],
    changeListeners: [],
    disposedSubs: 0,
    ...over,
  };
  const store = {
    listAll: () => ({ bundled: fake.bundled, user: fake.user }),
    add: async (p: KeyedRawPattern) => {
      if (fake.failWith) { throw fake.failWith; }
      fake.added.push(p);
    },
    update: async (key: string, p: KeyedRawPattern) => {
      if (fake.failWith) { throw fake.failWith; }
      fake.updated.push({ key, pattern: p });
    },
    delete: async (key: string) => {
      if (fake.failWith) { throw fake.failWith; }
      fake.deleted.push(key);
    },
    onDidChange: (listener: () => void) => {
      fake.changeListeners.push(listener);
      return { dispose: () => {
        fake.disposedSubs += 1;
        fake.changeListeners = fake.changeListeners.filter(l => l !== listener);
      } };
    },
  } as unknown as PatternStore;
  return { store, fake };
}

function recordingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const self = {
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    error: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, warns };
}

function fakeInspector(): { inspector: InspectorController; features: unknown[] } {
  const features: unknown[] = [];
  const inspector = {
    setActiveFeature: (f: unknown) => { features.push(f); },
  } as unknown as InspectorController;
  return { inspector, features };
}

function fakeContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('/ext'),
  } as unknown as vscode.ExtensionContext;
}

function showPanel(opts: { store?: Partial<StoreFake> } = {}): {
  panel: FakePanel;
  store: StoreFake;
  inspector: ReturnType<typeof fakeInspector>;
  log: ReturnType<typeof recordingLogger>;
} {
  const { store, fake } = fakeStore(opts.store);
  const inspector = fakeInspector();
  const log = recordingLogger();
  PatternEditorPanel.show(fakeContext(), store, log.logger, inspector.inspector);
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

/** The constructor defers the first snapshot by one tick — wait for it. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string }).type === 'patternEditor.snapshot',
  ));
}

function postedOfType<T>(panel: FakePanel, type: string): T[] {
  return panel.webview.posted.filter(m => (m as { type: string }).type === type) as T[];
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { PatternEditorPanel.dispose(); stub.__resetStub(); });

// ─── Construction / snapshot ───────────────────────────────────

test('module loads', async () => {
  const mod = await import('../panels/PatternEditorPanel.js');
  assert.ok(mod.PatternEditorPanel);
});

test('opening posts the catalog snapshot with bundled and user patterns', async () => {
  const { panel } = showPanel({ store: { user: [PATTERN] } });
  assert.equal(panel.title, 'Log Patterns');
  await settled(panel);

  const snaps = postedOfType<{ bundled: KeyedRawPattern[]; user: KeyedRawPattern[] }>(
    panel, 'patternEditor.snapshot',
  );
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0]?.bundled, [BUNDLED]);
  assert.deepEqual(snaps[0]?.user, [PATTERN]);
});

test('the panel carries the Ditto icon in both themes', async () => {
  const { panel } = showPanel();
  const iconPath = panel.iconPath as { light?: { path?: string }; dark?: { path?: string } };
  assert.match(iconPath.light?.path ?? '', /ditto-icon-light\.svg$/);
  assert.match(iconPath.dark?.path ?? '', /ditto-icon-dark\.svg$/);
});

test('opening routes the Inspector to the patternEditor help immediately and on focus', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);

  // Set in the constructor so the help is right on first paint.
  assert.deepEqual(inspector.features, [{ kind: 'patternEditor' }]);

  panel.fireViewState(false);
  assert.equal(inspector.features.length, 1, 'inactive changes do not re-route the Inspector');
  panel.fireViewState(true);
  assert.deepEqual(inspector.features, [{ kind: 'patternEditor' }, { kind: 'patternEditor' }]);
});

test('showing again reveals the existing panel and re-asserts the Inspector feature', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);

  PatternEditorPanel.show(fakeContext(), fakeStore().store, recordingLogger().logger,
    inspector.inspector);

  assert.equal(stub.createdWebviewPanels.length, 1, 'still one panel');
  assert.equal(panel.revealCount, 1);
  assert.equal(
    inspector.features.filter(f => (f as { kind: string }).kind === 'patternEditor').length, 2,
    'the reveal re-asserts the help even if the Inspector drifted',
  );
});

test('a store change re-posts the snapshot', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  store.user = [PATTERN];
  for (const l of [...store.changeListeners]) { l(); }

  await waitFor(() => postedOfType(panel, 'patternEditor.snapshot').length === 2);
  const snaps = postedOfType<{ user: KeyedRawPattern[] }>(panel, 'patternEditor.snapshot');
  assert.deepEqual(snaps[1]?.user, [PATTERN]);
});

// ─── Save / delete fan-out ─────────────────────────────────────

test('patternEditor.save without a replaceKey adds and acknowledges', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'patternEditor.save', pattern: PATTERN });
  await waitFor(() => postedOfType(panel, 'patternEditor.saveOk').length === 1);

  assert.deepEqual(store.added, [PATTERN]);
  assert.equal(store.updated.length, 0, 'add, not update');
  assert.deepEqual(postedOfType<{ key: string }>(panel, 'patternEditor.saveOk')[0]?.key, PATTERN.key);
});

test('patternEditor.save with a replaceKey updates instead of adding', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  const renamed = { ...PATTERN, key: 'user.renamed' };
  panel.fireMessage({ type: 'patternEditor.save', pattern: renamed, replaceKey: PATTERN.key });
  await waitFor(() => postedOfType(panel, 'patternEditor.saveOk').length === 1);

  assert.deepEqual(store.updated, [{ key: PATTERN.key, pattern: renamed }]);
  assert.equal(store.added.length, 0, 'update, not add');
  assert.deepEqual(
    postedOfType<{ key: string }>(panel, 'patternEditor.saveOk')[0]?.key, 'user.renamed',
    'the ack carries the NEW key so the webview can re-select it',
  );
});

test('a failing save posts saveFailed with the store message and logs a warning', async () => {
  const { panel, log } = showPanel({
    store: { failWith: new Error('Key collides with bundled pattern: ditto.x') },
  });
  await settled(panel);

  panel.fireMessage({ type: 'patternEditor.save', pattern: PATTERN });
  await waitFor(() => postedOfType(panel, 'patternEditor.saveFailed').length === 1);

  const failed = postedOfType<{ key: string; message: string }>(panel, 'patternEditor.saveFailed');
  assert.equal(failed[0]?.key, PATTERN.key);
  assert.match(failed[0]?.message ?? '', /Key collides with bundled pattern/);
  assert.equal(postedOfType(panel, 'patternEditor.saveOk').length, 0);
  assert.deepEqual(log.warns, ['PatternEditorPanel: save failed']);
});

test('patternEditor.delete forwards to the store', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'patternEditor.delete', key: PATTERN.key });
  await waitFor(() => store.deleted.length === 1);

  assert.deepEqual(store.deleted, [PATTERN.key]);
  assert.equal(postedOfType(panel, 'patternEditor.saveFailed').length, 0);
});

test('a failing delete posts saveFailed and logs a warning', async () => {
  const { panel, log } = showPanel({
    store: { failWith: new Error('Cannot delete bundled pattern: ditto.x') },
  });
  await settled(panel);

  panel.fireMessage({ type: 'patternEditor.delete', key: 'ditto.x' });
  await waitFor(() => postedOfType(panel, 'patternEditor.saveFailed').length === 1);

  const failed = postedOfType<{ key: string; message: string }>(panel, 'patternEditor.saveFailed');
  assert.equal(failed[0]?.key, 'ditto.x');
  assert.match(failed[0]?.message ?? '', /Cannot delete bundled pattern/);
  assert.deepEqual(log.warns, ['PatternEditorPanel: delete failed']);
});

// ─── Disposal ──────────────────────────────────────────────────

test('disposing unsubscribes from the store so changes no longer reach the panel', async () => {
  const { panel, store } = showPanel();
  await settled(panel);

  PatternEditorPanel.dispose();

  assert.equal(panel.disposed, true);
  assert.equal(store.disposedSubs, 1, 'the store subscription was disposed');
  for (const l of [...store.changeListeners]) { l(); }
  await new Promise(r => setTimeout(r, 40));
  assert.equal(postedOfType(panel, 'patternEditor.snapshot').length, 1, 'no post after disposal');
});
