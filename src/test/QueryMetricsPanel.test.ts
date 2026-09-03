import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QueryMetricsPanel } from '../panels/QueryMetricsPanel.js';
import { QueryMetricsStore } from '../storage/QueryMetricsStore.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { Logger, LogContext } from '../logging/types.js';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';

/**
 * QueryMetricsPanel behaviour through the vscode stub's fake webview panels:
 * the singleton-per-DB rules, the live onChange re-push (scoped to the
 * panel's DB), the modal-guarded clear, and Inspector routing. The
 * QueryMetricsStore is real — it is plain in-memory and the panel's
 * interaction with it (filter on databaseId) is exactly what's under test.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { warningResponse: unknown; shownWarnings: string[] };
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

const DB_ID = 'db-under-test';

function recordingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const self = {
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    error: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, warns };
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

function fakeInspector(): { inspector: InspectorController; features: unknown[] } {
  const features: unknown[] = [];
  const inspector = {
    setActiveFeature: (f: unknown) => { features.push(f); },
  } as unknown as InspectorController;
  return { inspector, features };
}

function metric(over: Partial<QueryResultMetadata> = {}): QueryResultMetadata {
  return { dql: 'SELECT * FROM t', durationMs: 5, timestamp: 1, ...over };
}

function showPanel(opts: {
  databaseId?: string;
  metrics?: QueryMetricsStore;
  configName?: string | undefined;
} = {}): {
  panel: FakePanel;
  metrics: QueryMetricsStore;
  inspector: ReturnType<typeof fakeInspector>;
  log: ReturnType<typeof recordingLogger>;
} {
  const metrics = opts.metrics ?? new QueryMetricsStore();
  const inspector = fakeInspector();
  const log = recordingLogger();
  const configs = {
    get: () => (opts.configName === undefined ? { name: 'DB Under Test' } : { name: opts.configName }),
  } as unknown as ConfigStore;
  QueryMetricsPanel.show(
    fakeContext(), configs, metrics, opts.databaseId ?? DB_ID, inspector.inspector, log.logger,
  );
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.ok(panel, 'panel created');
  return { panel, metrics, inspector, log };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The constructor defers the first push by one tick — wait for it. */
async function settled(panel: FakePanel): Promise<void> {
  await waitFor(() => panel.webview.posted.some(m => (m as { type: string }).type === 'metrics.state'));
}

function states(panel: FakePanel): { records: { dql?: string }[] }[] {
  return panel.webview.posted
    .filter(m => (m as { type: string }).type === 'metrics.state')
    .map(m => m as { records: { dql?: string }[] });
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { QueryMetricsPanel.dispose(); stub.__resetStub(); });

// ─── Construction / singleton ──────────────────────────────────

test('showing pushes the store contents for this DB, titled with the config name', async () => {
  const metrics = new QueryMetricsStore();
  metrics.capture(DB_ID, metric({ dql: 'SELECT * FROM a' }));
  metrics.capture('db-other', metric({ dql: 'SELECT * FROM other' }));

  const { panel } = showPanel({ metrics });
  assert.equal(panel.title, 'Query Metrics — DB Under Test');
  await settled(panel);

  const s = states(panel);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0]?.records.map(r => r.dql), ['SELECT * FROM a'], 'only this DB is listed');
});

test('a missing config titles the panel Unknown', async () => {
  const configs = { get: () => undefined } as unknown as ConfigStore;
  QueryMetricsPanel.show(
    fakeContext(), configs, new QueryMetricsStore(), DB_ID, fakeInspector().inspector,
    recordingLogger().logger,
  );
  const panel = stub.createdWebviewPanels[stub.createdWebviewPanels.length - 1];
  assert.equal(panel?.title, 'Query Metrics — Unknown');
});

test('the panel carries the Ditto icon in both themes', async () => {
  const { panel } = showPanel();
  const iconPath = panel.iconPath as { light?: { path?: string }; dark?: { path?: string } };
  assert.match(iconPath.light?.path ?? '', /ditto-icon-light\.svg$/);
  assert.match(iconPath.dark?.path ?? '', /ditto-icon-dark\.svg$/);
});

test('showing again for the same DB reveals and re-pushes instead of duplicating', async () => {
  const { panel, metrics } = showPanel();
  await settled(panel);
  metrics.capture(DB_ID, metric({ dql: 'SELECT * FROM b' }));
  await waitFor(() => states(panel).length === 2);

  QueryMetricsPanel.show(
    fakeContext(), { get: () => ({ name: 'DB Under Test' }) } as unknown as ConfigStore,
    metrics, DB_ID, fakeInspector().inspector, recordingLogger().logger,
  );

  assert.equal(stub.createdWebviewPanels.length, 1, 'still one panel');
  assert.equal(panel.revealCount, 1);
  await waitFor(() => states(panel).length === 3, 1000);
  assert.deepEqual(states(panel).at(-1)?.records.map(r => r.dql), ['SELECT * FROM b']);
});

test('showing for a different DB warns, disposes, and rebuilds', async () => {
  const { panel: first } = showPanel();
  await settled(first);

  const { panel: second, log } = showPanel({ databaseId: 'db-other' });

  assert.equal(first.disposed, true);
  assert.equal(stub.createdWebviewPanels.length, 2);
  assert.equal(second.disposed, false);
  assert.equal(log.warns.length, 1);
  assert.match(log.warns[0] ?? '', /different DB/);
});

test('the static dispose closes a live panel', async () => {
  const { panel } = showPanel();
  await settled(panel);
  QueryMetricsPanel.dispose();
  assert.equal(panel.disposed, true);
});

test('focusing the panel routes the Inspector to the metrics help', async () => {
  const { panel, inspector } = showPanel();
  await settled(panel);

  panel.fireViewState(false);
  assert.equal(inspector.features.length, 0, 'inactive changes do not re-route the Inspector');
  panel.fireViewState(true);

  assert.deepEqual(inspector.features, [{ kind: 'metrics', databaseId: DB_ID }]);
});

// ─── Live updates ──────────────────────────────────────────────

test('a capture for this DB re-pushes; a capture for another DB does not', async () => {
  const { panel, metrics } = showPanel();
  await settled(panel);

  metrics.capture('db-other', metric({ dql: 'SELECT * FROM elsewhere' }));
  await new Promise(r => setTimeout(r, 40));
  assert.equal(states(panel).length, 1, 'cross-DB churn must not re-render this panel');

  metrics.capture(DB_ID, metric({ dql: 'SELECT * FROM here' }));
  await waitFor(() => states(panel).length === 2);
  assert.deepEqual(states(panel)[1]?.records.map(r => r.dql), ['SELECT * FROM here']);
});

// ─── metrics.clear ─────────────────────────────────────────────

test('metrics.clear with the modal confirmed drops the history and re-pushes', async () => {
  const metrics = new QueryMetricsStore();
  metrics.capture(DB_ID, metric());
  const { panel } = showPanel({ metrics });
  await settled(panel);

  stub.window.warningResponse = 'Clear';
  panel.fireMessage({ type: 'metrics.clear' });
  await waitFor(() => states(panel).length === 2);

  assert.deepEqual(stub.window.shownWarnings, [
    'Clear all Query Metrics for this connection? This drops every recorded EXPLAIN history record.',
  ]);
  assert.deepEqual(metrics.list(DB_ID), [], 'the store was cleared');
  assert.deepEqual(states(panel)[1]?.records, [], 'the panel re-pushed the empty state');
});

test('metrics.clear dismissed leaves the history untouched', async () => {
  const metrics = new QueryMetricsStore();
  metrics.capture(DB_ID, metric());
  const { panel } = showPanel({ metrics });
  await settled(panel);

  // No warningResponse scripted — the user dismissed the modal.
  panel.fireMessage({ type: 'metrics.clear' });
  await waitFor(() => stub.window.shownWarnings.length === 1);
  await new Promise(r => setTimeout(r, 40));

  assert.equal(metrics.list(DB_ID).length, 1, 'the store kept its records');
  assert.equal(states(panel).length, 1, 'no re-push happened');
});
