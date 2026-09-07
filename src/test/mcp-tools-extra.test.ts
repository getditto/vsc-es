import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Phase-2 (extension-only) tool handler tests: system metrics hub sharing,
 * database metrics, subscription/observer CRUD, explain/profile, debug
 * socket, and the headless connect/disconnect automation seam.
 */

const { makeContext, seedConfig } = await import('./fixtures/mcp-fakes.js');
const { SystemMetricsHub } = await import('../ditto/SystemMetricsHub.js');

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '../mcp/define-tool.js';

const { queryTools } = await import('../mcp/tools-query.js');
const { metricsTools } = await import('../mcp/tools-metrics.js');
const { subscriptionTools } = await import('../mcp/tools-subscriptions.js');
const { observerTools } = await import('../mcp/tools-observers.js');
const { connectionTools } = await import('../mcp/tools-connections.js');
const { debugSocketTools } = await import('../mcp/tools-debug-socket.js');

function find(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find(t => t.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
}

function obj(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  const raw = JSON.parse(first.text) as unknown;
  assert.ok(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `expected object payload: ${first.text.slice(0, 200)}`);
  return raw as Record<string, unknown>;
}

function errText(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  return first.text;
}

// ─── system metrics (hub-backed) ─────────────────────────────

const COUNTER_ROW = {
  key: 'ditto.store.changes', labels: {}, level: 'info', unit: '', description: 'rows changed',
  current: 5, updates: 5, delta: 5,
};
const HISTO_ROW = {
  key: 'ditto.query.latency_ms', labels: {}, level: 'info', unit: 'ms', description: 'query latency',
  count: 2, sum: 30, abs_max: 20, dcount: 2, dsum: 30, dabs_max: 20,
};

test('get_system_metrics accumulates deltas across calls into since-connect totals', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => Promise.resolve(q === 'SELECT * FROM system:metrics'
        ? { rows: [COUNTER_ROW, HISTO_ROW], mutatedDocumentIds: [], commitId: null }
        : { rows: [], mutatedDocumentIds: [], commitId: null }),
    },
  });
  const tool = find(metricsTools, 'get_system_metrics');
  const first = obj(await tool.handler(bundle.ctx, {}));
  const firstSnap = (first.status as Record<string, unknown>).snapshot as { samples: Record<string, unknown>[] };
  const counter = firstSnap.samples.find(s => s.key === 'ditto.store.changes');
  assert.ok(counter);
  assert.equal(counter.sinceConnect, 5);
  assert.equal(counter.periodDelta, 5);

  const second = obj(await tool.handler(bundle.ctx, {}));
  const secondSnap = (second.status as Record<string, unknown>).snapshot as { samples: Record<string, unknown>[]; sinceMs: number };
  const counter2 = secondSnap.samples.find(s => s.key === 'ditto.store.changes');
  assert.equal(counter2?.sinceConnect, 10, 'second read folds its delta into the same accumulator');
  const histo2 = secondSnap.samples.find(s => s.key === 'ditto.query.latency_ms');
  assert.equal(histo2?.sinceConnect, 4);
  assert.equal(histo2?.sumSinceConnect, 60);
});

test('get_system_metrics surfaces the exporterDisabled placeholder with guidance', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => Promise.resolve(q === 'SELECT * FROM system:metrics'
        ? { rows: [{ status: 'disabled', description: 'not installed' }], mutatedDocumentIds: [], commitId: null }
        : { rows: [], mutatedDocumentIds: [], commitId: null }),
    },
  });
  const payload = obj(await find(metricsTools, 'get_system_metrics').handler(bundle.ctx, {}));
  assert.equal((payload.status as Record<string, unknown>).kind, 'exporterDisabled');
  assert.match(String(payload.guidance), /startup-gated/);
});

test('get_system_metrics requires a connection and shares one accumulator with panels', async () => {
  const off = makeContext();
  const res = await find(metricsTools, 'get_system_metrics').handler(off.ctx, {});
  assert.equal(res.isError, true);

  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => Promise.resolve(q === 'SELECT * FROM system:metrics'
        ? { rows: [COUNTER_ROW], mutatedDocumentIds: [], commitId: null }
        : { rows: [], mutatedDocumentIds: [], commitId: null }),
    },
  });
  // A "panel" consumer arrives first (paused so no timer spins in the test host).
  const handle = bundle.systemMetricsHub.acquire('cfg-1', () => { /* status sink */ });
  handle.pause();
  const payload = obj(await find(metricsTools, 'get_system_metrics').handler(bundle.ctx, {}));
  const snapService = bundle.systemMetricsHub.serviceFor('cfg-1');
  assert.ok(snapService);
  const snap = (payload.status as Record<string, unknown>).snapshot as { samples: unknown[] };
  assert.equal(snap.samples.length, 1);
  bundle.systemMetricsHub.disposeFor('cfg-1');
  assert.equal(bundle.systemMetricsHub.size, 0);
});

test('SystemMetricsHub: pause/resume drives the timer; entries survive consumer churn', () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const hub = new SystemMetricsHub(bundle.manager, bundle.logger);
  const a = hub.acquire('cfg-1', () => {});
  assert.equal(a.service.isPolling, true, 'first unpaused consumer ticks');
  a.pause();
  assert.equal(a.service.isPolling, false, 'all consumers paused → timer stops');
  const same = hub.acquireForToolCalls('cfg-1');
  assert.equal(same, a.service, 'tool path reads the SAME accumulator the panel uses');
  a.resume();
  assert.equal(a.service.isPolling, true);
  a.dispose();
  assert.equal(hub.size, 1, 'entry persists (totals survive panel churn) until disposeFor');
  hub.disposeFor('cfg-1');
  assert.equal(hub.size, 0);
});

// ─── database metrics ────────────────────────────────────────

test('get_database_metrics buckets the working directory and sums collection CBOR', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dbmetrics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'dittoData', 'cfg-1');
  fs.mkdirSync(path.join(dataDir, 'ditto_store'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'ditto_logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ditto_store', 'db.sqlite'), Buffer.alloc(100));
  fs.writeFileSync(path.join(dataDir, 'ditto_store', 'db.sqlite-wal'), Buffer.alloc(40));
  fs.writeFileSync(path.join(dataDir, 'ditto_logs', 'ditto.log'), Buffer.alloc(10));

  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => {
        if (q === 'SELECT * FROM system:collections') {
          return Promise.resolve({ rows: [{ name: 'tasks' }], mutatedDocumentIds: [], commitId: null });
        }
        if (q === 'SELECT * FROM `tasks`') {
          return Promise.resolve({ rows: [{ _id: '1' }, { _id: '2' }], mutatedDocumentIds: [], commitId: null });
        }
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
    },
  });
  bundle.ctx.globalStorageFsPath = root;

  const payload = obj(await find(metricsTools, 'get_database_metrics').handler(bundle.ctx, {}));
  assert.equal(payload.storeBytes, 100);
  assert.equal(payload.walShmBytes, 40);
  assert.equal(payload.logsBytes, 10);
  const breakdown = payload.collectionBreakdown as Record<string, unknown>[];
  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0]?.name, 'tasks');
  assert.equal(breakdown[0]?.documentCount, 2);
});

test('get_database_metrics requires a connection', async () => {
  const bundle = makeContext();
  const res = await find(metricsTools, 'get_database_metrics').handler(bundle.ctx, {});
  assert.equal(res.isError, true);
});

// ─── subscriptions ───────────────────────────────────────────

test('subscriptions: list defaults to active; add registers live only for the active db; remove cancels live', async () => {
  const bundle = makeContext({
    configs: [seedConfig(), seedConfig({ id: 'cfg-2', name: 'Other DB', databaseId: 'db-2' })],
    activeId: 'cfg-1',
  });

  const added = obj(await find(subscriptionTools, 'add_subscription').handler(bundle.ctx, {
    name: 'Pending tasks', query: 'SELECT * FROM tasks WHERE done = false',
  }));
  const subId = (added.subscription as Record<string, unknown>).id as string;
  assert.ok(subId);
  assert.deepEqual(bundle.manager.state.registeredSubscriptions.map(s => s.query), ['SELECT * FROM tasks WHERE done = false'],
    'active target registers live');

  // Stage one on the inactive other connection via explicit name.
  const addedOther = obj(await find(subscriptionTools, 'add_subscription').handler(bundle.ctx, {
    name: 'All orders', query: 'SELECT * FROM orders', database: 'Other DB',
  }));
  assert.equal(addedOther.registered, false);
  assert.equal(bundle.manager.state.registeredSubscriptions.length, 1, 'inactive target persists only');

  let listed = obj(await find(subscriptionTools, 'list_subscriptions').handler(bundle.ctx, {}));
  assert.equal((listed.subscriptions as unknown[]).length, 1);
  assert.equal(listed.activeHere, true);
  listed = obj(await find(subscriptionTools, 'list_subscriptions').handler(bundle.ctx, { database: 'cfg-2' }));
  assert.equal((listed.subscriptions as unknown[]).length, 1);
  assert.equal(listed.activeHere, false);

  const removed = obj(await find(subscriptionTools, 'remove_subscription').handler(bundle.ctx, { id: subId }));
  assert.equal(removed.removed, true);
  assert.deepEqual(bundle.manager.state.cancelledSubscriptions, [subId]);
});

test('add_subscription rejects non-SELECT and unknown connection names', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const bad = await find(subscriptionTools, 'add_subscription').handler(bundle.ctx, { name: 'x', query: 'UPDATE tasks SET a = 1' });
  assert.equal(bad.isError, true);
  assert.match(errText(bad), /SELECT/);
  const unknown = await find(subscriptionTools, 'add_subscription').handler(bundle.ctx, { name: 'x', query: 'SELECT 1', database: 'nope' });
  assert.equal(unknown.isError, true);
  assert.match(errText(unknown), /Unknown connection/);
});

test('remove_subscription: unknown id is an isError, offline default target errors when idle', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const missing = await find(subscriptionTools, 'remove_subscription').handler(bundle.ctx, { id: 'nope' });
  assert.equal(missing.isError, true);
  const idle = makeContext();
  const needsDefault = await find(subscriptionTools, 'list_subscriptions').handler(idle.ctx, {});
  assert.equal(needsDefault.isError, true);
  assert.match(errText(needsDefault), /No active connection/);
});

// ─── observers ───────────────────────────────────────────────

test('observers: CRUD persists definitions without starting live observation', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const added = obj(await find(observerTools, 'add_observer').handler(bundle.ctx, {
    name: 'Watch tasks', query: 'SELECT * FROM tasks',
  }));
  const obsId = (added.observer as Record<string, unknown>).id as string;
  assert.match(String(added.message), /watch_query/);

  const listed = obj(await find(observerTools, 'list_observers').handler(bundle.ctx, {}));
  assert.equal((listed.observers as unknown[]).length, 1);

  const nonSelect = await find(observerTools, 'add_observer').handler(bundle.ctx, { name: 'bad', query: 'DELETE FROM tasks' });
  assert.equal(nonSelect.isError, true);

  const removed = obj(await find(observerTools, 'remove_observer').handler(bundle.ctx, { id: obsId }));
  assert.equal(removed.removed, true);
  assert.equal(bundle.observerStore.list('cfg-1').length, 0);
});

// ─── explain / profile ───────────────────────────────────────

test('explain_query returns the plan row without executing the statement', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => Promise.resolve(q.startsWith('EXPLAIN ')
        ? { rows: [{ plan: { operator: 'TableScan' } }], mutatedDocumentIds: [], commitId: null }
        : { rows: [], mutatedDocumentIds: [], commitId: null }),
    },
  });
  const payload = obj(await find(queryTools, 'explain_query').handler(bundle.ctx, { query: 'SELECT * FROM tasks' }));
  assert.deepEqual(payload.plan, { plan: { operator: 'TableScan' } }, 'plan is the raw first EXPLAIN row');
  assert.deepEqual(bundle.manager.state.executeCalls.map(c => c.query), ['EXPLAIN SELECT * FROM tasks']);
});

test('explain_query surfaces an empty plan as an error', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: { execute: () => Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null }) },
  });
  const res = await find(queryTools, 'explain_query').handler(bundle.ctx, { query: 'SELECT * FROM tasks' });
  assert.equal(res.isError, true);
  assert.match(errText(res), /no plan/i);
});

test('profile_query runs the PROFILE pipeline and returns the tree + rows', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      runQuery: (q, _opts) => Promise.resolve({
        rows: [{ _id: '1' }],
        durationMs: 33,
        metadata: {
          dql: q, durationMs: 33, resultCount: 1, explain: '', timestamp: 1,
          profile: { totalMs: 32, operators: [] },
        },
      }),
    },
  });
  const payload = obj(await find(queryTools, 'profile_query').handler(bundle.ctx, { query: 'SELECT * FROM tasks' }));
  assert.equal(payload.durationMs, 33);
  assert.deepEqual(payload.profile, { totalMs: 32, operators: [] });

  const nonSelect = await find(queryTools, 'profile_query').handler(bundle.ctx, { query: 'INSERT INTO tasks DOCUMENTS {}' });
  assert.equal(nonSelect.isError, true);
  assert.match(errText(nonSelect), /SELECT/);
});

// ─── debug socket ────────────────────────────────────────────

test('debug_socket_query round-trips against an in-process fake app socket', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dbg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = path.join(dir, 'app.sock');
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const stmt = chunk.toString().trim();
      if (stmt.startsWith('FAIL')) { socket.write('ERROR: synthetic failure\n'); return; }
      socket.write(JSON.stringify([{ echo: stmt }]) + '\n');
    });
  });
  await new Promise<void>(r => server.listen(sockPath, r));
  t.after(() => server.close());

  const bundle = makeContext(); // NOTE: deliberately NO active connection
  const payload = obj(await find(debugSocketTools, 'debug_socket_query').handler(bundle.ctx, {
    socket_path: sockPath, statement: 'SELECT * FROM tasks',
  }));
  assert.deepEqual(payload.rows, [{ echo: 'SELECT * FROM tasks' }]);
  assert.equal(payload.rowCount, 1);

  const failure = await find(debugSocketTools, 'debug_socket_query').handler(bundle.ctx, {
    socket_path: sockPath, statement: 'FAIL PLEASE',
  });
  assert.equal(failure.isError, true);
  assert.match(errText(failure), /synthetic failure/);

  const badPath = await find(debugSocketTools, 'debug_socket_query').handler(bundle.ctx, {
    socket_path: path.join(dir, 'missing.sock'), statement: 'SELECT 1',
  });
  assert.equal(badPath.isError, true);
});

// ─── connect / disconnect automation ─────────────────────────

test('connect_database drives the automation seam and reports connect-failed as isError', async () => {
  const bundle = makeContext();
  bundle.automationScript.connectImpl = (id) => Promise.resolve({ kind: 'connected', configId: id, name: 'Dev DB' });
  const okRes = obj(await find(connectionTools, 'connect_database').handler(bundle.ctx, { id_or_name: 'cfg-1' }));
  assert.equal(okRes.connected, true);
  assert.deepEqual(bundle.automationScript.connectCalls, ['cfg-1']);

  bundle.automationScript.connectImpl = () => Promise.resolve({ kind: 'connect-failed', message: 'Connect to "X" failed: locked. Rolled back to "A".' });
  const fail = await find(connectionTools, 'connect_database').handler(bundle.ctx, { id_or_name: 'cfg-2' });
  assert.equal(fail.isError, true);
  assert.match(errText(fail), /Rolled back/);
});

test('disconnect_database reports whether anything was connected', async () => {
  const bundle = makeContext();
  bundle.automationScript.disconnectImpl = () => Promise.resolve(true);
  const payload = obj(await find(connectionTools, 'disconnect_database').handler(bundle.ctx, {}));
  assert.equal(payload.wasConnected, true);
  assert.equal(bundle.automationScript.disconnectCalls, 1);

  bundle.automationScript.disconnectImpl = () => Promise.resolve(false);
  const again = obj(await find(connectionTools, 'disconnect_database').handler(bundle.ctx, {}));
  assert.equal(again.wasConnected, false);
});
