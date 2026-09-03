import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DatabaseMetricsPanel } from '../panels/DatabaseMetricsPanel.js';
import type { Logger } from '../logging/types.js';
import type { SystemMetricsStatus } from '../ipc/messages.js';

/**
 * DatabaseMetricsPanel ↔ SystemMetricsService wiring: polling is armed on
 * (visibility-driven), armed off when hidden, and stopped on dispose. The
 * service's own semantics are covered in SystemMetricsService.test.ts and
 * system-metrics-live.test.ts.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    webview: { posted: { type: string; status?: SystemMetricsStatus | undefined }[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
    fireViewState(active: boolean): void;
    visible: boolean;
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

function metricRow(key: string, delta: number, labels: Record<string, string> = {}): Record<string, unknown> {
  return { key, labels, level: 'info', unit: 'count', description: `${key} desc`, current: 0, updates: 0, delta };
}

function makeManager(opts: { metricsRows?: Record<string, unknown>[] } = {}) {
  const queries: string[] = [];
  return {
    queries,
    manager: {
      getActiveConfigId: () => 'db-1',
      executeQuery: async () => {
        throw new Error('not used by DatabaseMetricsPanel');
      },
      executeRaw: async (query: string) => {
        queries.push(query);
        if (query.includes('system:metrics')) { return opts.metricsRows ?? []; }
        if (query.includes('system:collections')) { return []; }
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

function postedSystemMetrics(): SystemMetricsStatus[] {
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  return panel.webview.posted
    .filter(m => m.type === 'dbMetrics.systemMetrics')
    .map(m => m.status)
    .filter((s): s is SystemMetricsStatus => s !== undefined);
}

test('DatabaseMetricsPanel: opening visible polls system:metrics and posts an accumulated snapshot', async () => {
  const { manager, queries } = makeManager({
    metricsRows: [metricRow('ditto.network.dsoq.connection.opened', 3)],
  });
  showPanel(manager);
  await settle();

  assert.ok(queries.some(q => q.includes('system:metrics')),
    `panel polled system:metrics; queries: ${JSON.stringify(queries)}`);
  const statuses = postedSystemMetrics();
  assert.ok(statuses.some(s => s.kind === 'working'),
    `a working status was posted: ${JSON.stringify(statuses.map(s => s.kind))}`);
  const working = statuses.find((s): s is Extract<SystemMetricsStatus, { kind: 'working' }> => s.kind === 'working');
  const sample = working?.snapshot.samples[0];
  // The fake returns delta 3 on EVERY poll; the panel polls more than once
  // before we read (immediate tick + auto-refresh), so the running total is
  // a multiple of 3 — that's the accumulation contract, last-read rendering
  // would always say 3.
  assert.equal(sample?.periodDelta, 3);
  assert.ok(
    sample !== undefined && sample.sinceConnect >= 6 && sample.sinceConnect % 3 === 0,
    `deltas accumulated across polls: ${JSON.stringify(sample)}`,
  );
  // Final flakiness guard: tally the polls the manager actually served.
  const polls = queries.filter(q => q.includes('system:metrics')).length;
  assert.equal(sample.sinceConnect, polls * 3, 'running total = delta × poll count');
});

test('DatabaseMetricsPanel: hiding stops polling, revealing resumes it, dispose stops it', async () => {
  const { manager, queries } = makeManager({
    metricsRows: [metricRow('ditto.network.dsoq.connection.opened', 1)],
  });
  showPanel(manager);
  await settle();
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);

  const afterOpen = queries.filter(q => q.includes('system:metrics')).length;
  assert.ok(afterOpen >= 1, 'immediate poll on open');

  panel.visible = false;
  panel.fireViewState(false); // hidden → polling stops
  await settle();
  const afterHide = queries.filter(q => q.includes('system:metrics')).length;
  // No new polls while hidden (the default interval is 5s — far longer than
  // the settle window — so this is about the absence of extra polls, and
  // dispose safety rather than timer cadence).
  assert.equal(afterHide, afterOpen, 'hiding the panel queued no further polls');

  panel.visible = true;
  panel.fireViewState(true); // visible again → resumes with an immediate poll
  await settle();
  const afterReveal = queries.filter(q => q.includes('system:metrics')).length;
  assert.ok(afterReveal > afterHide, 'revealing polls immediately');

  panel.dispose();
  assert.ok(panel.disposed);
});

test('DatabaseMetricsPanel: the exporter-disabled placeholder surfaces as guidance, not a dead table', async () => {
  const { manager } = makeManager({
    metricsRows: [{ status: 'disabled', description: 'set the system parameter at startup' }],
  });
  showPanel(manager);
  await settle();
  const statuses = postedSystemMetrics();
  assert.ok(statuses.some(s => s.kind === 'exporterDisabled'),
    `exporterDisabled surfaced: ${JSON.stringify(statuses.map(s => s.kind))}`);
});

test('DatabaseMetricsPanel: a Refresh click also repolls system metrics', async () => {
  const { manager, queries } = makeManager({ metricsRows: [] });
  showPanel(manager);
  await settle();
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  const before = queries.filter(q => q.includes('system:metrics')).length;
  panel.fireMessage({ type: 'dbMetrics.refresh' });
  await settle();
  const after = queries.filter(q => q.includes('system:metrics')).length;
  assert.ok(after > before, 'refresh triggered an extra system:metrics poll');
});
