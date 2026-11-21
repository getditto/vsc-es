import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WelcomePanel } from '../panels/WelcomePanel.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { StoredDittoConfig } from '../models/DittoConfig.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * WelcomePanel behaviour through the vscode stub's fake webview panels: the
 * singleton reveal, the init payload, the two command fan-outs, and the
 * auto-close on the 0 → ≥1 config transition. The ConfigStore is faked at
 * its public surface with a controllable change emitter.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  commands: { executed: { command: string; args: unknown[] }[] };
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

interface ConfigFake {
  configs: StoredDittoConfig[];
  changeListeners: (() => void)[];
  disposedSubs: number;
}

function fakeConfigStore(initial: number): { store: ConfigStore; fake: ConfigFake } {
  const fake: ConfigFake = {
    configs: Array.from({ length: initial }, (_, i) => ({ id: `db-${i}` }) as StoredDittoConfig),
    changeListeners: [],
    disposedSubs: 0,
  };
  const store = {
    list: () => fake.configs,
    onDidChange: (listener: () => void) => {
      fake.changeListeners.push(listener);
      return { dispose: () => {
        fake.disposedSubs += 1;
        fake.changeListeners = fake.changeListeners.filter(l => l !== listener);
      } };
    },
  } as unknown as ConfigStore;
  return { store, fake };
}

/** Add a config and notify listeners, the way a successful Register does. */
function addConfig(fake: ConfigFake): void {
  fake.configs.push({ id: `db-${fake.configs.length}` } as StoredDittoConfig);
  for (const l of [...fake.changeListeners]) { l(); }
}

function recordingLogger(): { logger: Logger; infos: string[] } {
  const infos: string[] = [];
  const self = {
    info: (m: string, _c?: LogContext) => { infos.push(m); },
    warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, infos };
}

function fakeContext(version = '9.9.9-test'): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('/ext'),
    // The panel reads the installed version off the manifest, exactly as
    // the real ExtensionContext exposes it.
    extension: { packageJSON: { version } },
  } as unknown as vscode.ExtensionContext;
}

function showPanel(configCount = 0): {
  panel: FakePanel;
  configs: ConfigFake;
  log: ReturnType<typeof recordingLogger>;
} {
  const { store, fake } = fakeConfigStore(configCount);
  const log = recordingLogger();
  WelcomePanel.show(fakeContext(), store, log.logger);
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  return { panel, configs: fake, log };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The constructor defers welcome.init by one tick — wait for it. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(m => (m as { type: string }).type === 'welcome.init'));
}

function inits(panel: FakePanel): { hasExistingDatabases: boolean; version: string }[] {
  return panel.webview.posted
    .filter(m => (m as { type: string }).type === 'welcome.init')
    .map(m => ({
      hasExistingDatabases: (m as { hasExistingDatabases: boolean }).hasExistingDatabases,
      version: (m as { version: string }).version,
    }));
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { WelcomePanel.dispose(); stub.__resetStub(); });

// ─── Construction / init ───────────────────────────────────────

test('opening with no databases posts hasExistingDatabases false', async () => {
  const { panel } = showPanel(0);
  assert.equal(panel.title, 'Welcome to Ditto');
  await settled(panel);

  assert.deepEqual(inits(panel), [{ hasExistingDatabases: false, version: '9.9.9-test' }]);
});

test('opening with databases configured posts hasExistingDatabases true', async () => {
  const { panel } = showPanel(2);
  await settled(panel);

  assert.deepEqual(inits(panel), [{ hasExistingDatabases: true, version: '9.9.9-test' }]);
});

test('the init payload carries the installed extension version', async () => {
  const { panel } = showPanel();
  await settled(panel);

  const [init] = inits(panel);
  assert.ok(init, 'the init payload was posted');
  assert.equal(init.version, '9.9.9-test', 'the footer version comes from the manifest');
});

test('a manifest without a version falls back rather than rendering undefined', async () => {
  const { store } = fakeConfigStore(0);
  WelcomePanel.show(
    { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext,
    store,
    recordingLogger().logger,
  );
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  await settled(panel);

  const [init] = inits(panel);
  assert.ok(init, 'the init payload was posted');
  assert.equal(init.version, '0.0.0');
});

test('the panel carries the Ditto icon in both themes', async () => {
  const { panel } = showPanel();
  const iconPath = panel.iconPath as { light?: { path?: string }; dark?: { path?: string } };
  assert.match(iconPath.light?.path ?? '', /ditto-icon-light\.svg$/);
  assert.match(iconPath.dark?.path ?? '', /ditto-icon-dark\.svg$/);
});

test('showing again reveals the existing panel and re-posts init', async () => {
  const { panel } = showPanel(1);
  await settled(panel);

  WelcomePanel.show(fakeContext(), fakeConfigStore(1).store, recordingLogger().logger);

  assert.equal(stub.createdWebviewPanels.length, 1, 'still one panel');
  assert.equal(panel.revealCount, 1);
  await waitFor(() => inits(panel).length === 2);
});

test('the static dispose closes a live panel', async () => {
  const { panel } = showPanel();
  await settled(panel);
  WelcomePanel.dispose();
  assert.equal(panel.disposed, true);
});

// ─── Command fan-out ───────────────────────────────────────────

test('welcome.registerDatabase fans out to the registerDatabase command', async () => {
  const { panel } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'welcome.registerDatabase' });
  await waitFor(() => stub.commands.executed.length === 1);

  assert.deepEqual(stub.commands.executed, [{ command: 'dittoVsce.registerDatabase', args: [] }]);
  assert.equal(panel.disposed, false, 'the panel stays open behind the Register editor');
});

test('welcome.getQuickstarts fans out to the getQuickstarts command', async () => {
  const { panel } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'welcome.getQuickstarts' });
  await waitFor(() => stub.commands.executed.length === 1);

  assert.deepEqual(stub.commands.executed, [{ command: 'dittoVsce.getQuickstarts', args: [] }]);
});

test('welcome.close disposes the panel', async () => {
  const { panel } = showPanel();
  await settled(panel);

  panel.fireMessage({ type: 'welcome.close' });
  await Promise.resolve();

  assert.equal(panel.disposed, true);
});

// ─── Auto-close on first database ──────────────────────────────

test('registering the first database auto-closes the panel and logs why', async () => {
  const { panel, configs, log } = showPanel(0);
  await settled(panel);

  addConfig(configs);

  assert.equal(panel.disposed, true, 'onboarding is done once a database exists');
  assert.deepEqual(log.infos, ['First database registered — closing welcome panel']);
});

test('a config change that leaves the store empty does not close the panel', async () => {
  const { panel, configs } = showPanel(0);
  await settled(panel);

  // A delete/replace event with the store still empty.
  for (const l of [...configs.changeListeners]) { l(); }
  await new Promise(r => setTimeout(r, 40));

  assert.equal(panel.disposed, false);
  assert.equal(panel.webview.posted.length >= 1, true, 'panel alive');
});

test('a later database added while databases already existed does not close the panel', async () => {
  // Opened as a reference card (databases already configured) — its job was
  // never onboarding, so adding a second database must not yank it away.
  const { panel, configs, log } = showPanel(1);
  await settled(panel);

  addConfig(configs);
  await new Promise(r => setTimeout(r, 40));

  assert.equal(panel.disposed, false);
  assert.deepEqual(log.infos, []);
});

test('closing the panel unsubscribes from the config store', async () => {
  const { panel, configs } = showPanel(0);
  await settled(panel);

  panel.dispose();
  await Promise.resolve();

  assert.equal(configs.disposedSubs, 1, 'the onDidChange subscription was disposed');
  addConfig(configs);
  assert.deepEqual(configs.changeListeners, [], 'no listener survives the panel');
});
