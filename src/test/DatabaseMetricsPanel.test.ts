import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DatabaseMetricsPanel } from '../panels/DatabaseMetricsPanel.js';
import type { Logger } from '../logging/types.js';

/**
 * DatabaseMetricsPanel after the System Metrics split-out: the panel is
 * storage-only — refresh drives the filesystem walk + collection scans
 * and must NOT touch the polling `system:metrics` surface (that lives in
 * SystemMetricsPanel now).
 */

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    webview: { posted: { type: string }[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
  }[];
  __resetStub(): void;
  Uri: { file(p: string): unknown };
};

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

function memento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T) =>
      (store.has(key) ? store.get(key) : defaultValue) as T,
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  };
}

function makeManager() {
  const queries: string[] = [];
  return {
    queries,
    manager: {
      getActiveConfigId: () => 'db-1',
      executeRaw: async (query: string) => {
        queries.push(query);
        return [];
      },
      cborBytesForCollection: async () => ({ documentCount: 0, totalBytes: 0 }),
    },
  };
}

function showPanel(manager: unknown): void {
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalStorageUri: vscode.Uri.file('/tmp/dbmetrics-test-storage'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  DatabaseMetricsPanel.show(
    context,
    { get: () => ({ name: 'DB Under Test' }) } as never,
    manager as never,
    'db-1',
    { setActiveFeature: () => {} } as never,
    noopLogger(),
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

test.beforeEach(() => { stub.__resetStub(); DatabaseMetricsPanel.dispose(); });
test.afterEach(() => { DatabaseMetricsPanel.dispose(); stub.__resetStub(); });

test('DatabaseMetricsPanel: opening auto-refreshes and posts loading then a snapshot', async () => {
  const { manager } = makeManager();
  showPanel(manager);
  await settle();
  const posted = stub.createdWebviewPanels[0]?.webview.posted.map(m => m.type) ?? [];
  assert.ok(posted.includes('dbMetrics.loading'), `loading posted: ${JSON.stringify(posted)}`);
  assert.ok(posted.includes('dbMetrics.snapshot'), `snapshot posted: ${JSON.stringify(posted)}`);
  assert.ok(
    posted.indexOf('dbMetrics.loading') < posted.indexOf('dbMetrics.snapshot'),
    'loading precedes the snapshot',
  );
});

test('DatabaseMetricsPanel: refresh never queries system:metrics (split-out regression)', async () => {
  const { manager, queries } = makeManager();
  showPanel(manager);
  await settle();
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  panel.fireMessage({ type: 'dbMetrics.refresh' });
  await settle();
  assert.equal(
    queries.filter(q => q.includes('system:metrics')).length,
    0,
    `storage refresh must leave system:metrics alone; queries: ${JSON.stringify(queries)}`,
  );
});
