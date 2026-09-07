import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tool-handler unit tests: every parity tool exercised against the fake
 * service graph (no HTTP). Transport behaviour lives in mcp-server.test.ts.
 *
 * The HTTP-mode path of execute_dql is scripted through the module-register
 * hook below (same pattern as QueryEditorPanel.behavior.test.ts): the tool
 * module's `../ditto/HttpQueryService.js` import is rewritten to the
 * fixture so no TLS stack is needed.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/HttpQueryService.js')
        && context.parentURL?.endsWith('/src/mcp/tools-query.ts')) {
      return {
        url: new URL('./fixtures/fake-http-query-service.ts', import.meta.url).href,
        shortCircuit: true,
        format: 'module',
      };
    }
    return nextResolve(specifier, context);
  },
});

const fakeHttp = await import('./fixtures/fake-http-query-service.js');
const { makeContext, seedConfig, seedSecrets } = await import('./fixtures/mcp-fakes.js');
const { validateJsonDocuments } = await import('../ditto/ImportService.js');
const { allTools } = await import('../mcp/registry.js');

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '../mcp/define-tool.js';

// Dynamic imports AFTER registerHooks so the rewrite applies.
const { connectionTools } = await import('../mcp/tools-connections.js');
const { queryTools } = await import('../mcp/tools-query.js');
const { collectionTools } = await import('../mcp/tools-collections.js');
const { syncTools } = await import('../mcp/tools-sync.js');
const { metricsTools } = await import('../mcp/tools-metrics.js');
const { logTools } = await import('../mcp/tools-logs.js');

function find(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find(t => t.name === name);
  assert.ok(tool, `tool ${name} must exist`);
  return tool;
}

/** Canonical manifest lock — update deliberately when tools ship. */
const EXPECTED_TOOL_NAMES = [
  // SwiftUI parity
  'execute_dql',
  'insert_documents_from_file',
  'list_databases',
  'get_active_database',
  'list_collections',
  'list_indexes',
  'create_index',
  'drop_index',
  'get_query_metrics',
  'get_sync_status',
  'set_sync',
  'configure_transport',
  'get_peers',
  'get_app_logs',
  'get_ditto_logs',
  // extension-only
  'get_system_metrics',
  'get_database_metrics',
  'list_subscriptions',
  'add_subscription',
  'remove_subscription',
  'list_observers',
  'add_observer',
  'remove_observer',
  'explain_query',
  'profile_query',
  'debug_socket_query',
  'connect_database',
  'disconnect_database',
  // extension-only, phase 3
  'watch_query',
  'fetch_attachment',
  'query_log_analyzer',
];

test('manifest: the registry exposes every tool exactly once', () => {
  // Data-level manifest check (no HTTP) — mirrors the SwiftUI suite's
  // MCPToolHandlersTests. 28 = 15 SwiftUI-parity tools + extension-only.
  const defs = allTools();
  const names = defs.map(d => d.name).sort();
  assert.deepEqual(names, EXPECTED_TOOL_NAMES.slice().sort());
  assert.equal(new Set(names).size, names.length, 'duplicate tool names would shadow each other');
  for (const def of defs) {
    assert.ok(def.description.length > 10, `${def.name} needs a real description`);
    assert.ok(def.schema && typeof def.schema === 'object', `${def.name} needs a zod input schema`);
    // Descriptions must not promise what we don't ship.
    assert.ok(!def.description.includes('openapi'), `${def.name} stray description`);
  }
});

function obj(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.ok(first && first.type === 'text', 'tool result should be text');
  const raw = JSON.parse(first.text) as unknown;
  assert.ok(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `expected object payload: ${first.text.slice(0, 200)}`);
  return raw as Record<string, unknown>;
}

function arr(result: CallToolResult): Record<string, unknown>[] {
  const first = result.content[0];
  assert.ok(first && first.type === 'text', 'tool result should be text');
  const raw = JSON.parse(first.text) as unknown;
  assert.ok(Array.isArray(raw), `expected array payload: ${first.text.slice(0, 200)}`);
  return raw as Record<string, unknown>[];
}

function head(a: Record<string, unknown>[]): Record<string, unknown> {
  const first = a[0];
  assert.ok(first, 'expected a non-empty payload array');
  return first;
}

function errText(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  return first.text;
}

// ─── connections ─────────────────────────────────────────────

test('list_databases returns registered connections without credentials', async () => {
  const bundle = makeContext({ configs: [seedConfig(), seedConfig({ id: 'cfg-2', name: 'Prod', databaseId: 'db-999' })] });
  bundle.manager.state.statuses = { 'cfg-1': 'active', 'cfg-2': 'idle' };
  await seedSecrets(bundle, 'cfg-1', { token: 'tok-super-secret-value-123', httpApiKey: 'http-key-456' });

  const result = await find(connectionTools, 'list_databases').handler(bundle.ctx, {});
  const rows = arr(result);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(head(rows)).sort(), ['databaseId', 'id', 'mode', 'name', 'status']);
  assert.equal(head(rows).status, 'active');
  assert.ok(!errText(result).includes('tok-super-secret-value-123'), 'token must never appear in MCP output');
  assert.ok(!errText(result).includes('http-key-456'), 'httpApiKey must never appear in MCP output');
});

test('get_active_database errors when nothing is connected', async () => {
  const bundle = makeContext();
  const result = await find(connectionTools, 'get_active_database').handler(bundle.ctx, {});
  assert.equal(result.isError, true);
  assert.match(errText(result), /No active database/);
});

test('get_active_database reports config + live state, redacting secrets', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  await seedSecrets(bundle, 'cfg-1', { token: 'tok-live-secret-999', httpApiKey: 'live-http-key' });
  bundle.manager.state.snapshot = {
    local: null,
    remote: [
      { id: 'p1', isDittoServer: false, deviceName: 'Phone', connections: [], syncSessionStatus: 'Connected' },
      { id: 'cloud', isDittoServer: true, deviceName: 'Ditto Cloud', connections: [], syncSessionStatus: 'Connected' },
    ],
  };

  const result = await find(connectionTools, 'get_active_database').handler(bundle.ctx, {});
  assert.equal(result.isError ?? false, false);
  const payload = obj(result);
  assert.equal(payload.name, 'Dev DB');
  assert.equal(payload.httpApiConfigured, true);
  assert.equal(payload.sync, 'active');
  assert.equal(payload.lifecycle, 'active');
  assert.equal(payload.connectedPeers, 1);
  assert.equal(payload.cloudSyncConnected, true);
  assert.ok(!errText(result).includes('tok-live-secret-999'));
  assert.ok(!errText(result).includes('live-http-key'));
});

// ─── execute_dql ─────────────────────────────────────────────

test('execute_dql (local) returns rows for reads', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => Promise.resolve({
        rows: q.startsWith('SELECT * FROM tasks')
          ? [{ _id: '1', title: 'one' }, { _id: '2', title: 'two' }]
          : [],
        mutatedDocumentIds: [],
        commitId: null,
      }),
    },
  });
  const result = await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'SELECT * FROM tasks', transport: 'local' });
  assert.equal(result.isError ?? false, false);
  const payload = obj(result);
  assert.equal((payload.rows as unknown[]).length, 2);
  assert.equal(payload.rowCount, 2);
});

test('execute_dql (local) surfaces mutation metadata', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: () => Promise.resolve({ rows: [], mutatedDocumentIds: ['doc-1', 'doc-2'], commitId: '42' }),
    },
  });
  const payload = obj(await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: "INSERT INTO tasks DOCUMENTS ({'_id':'doc-1'})", transport: 'local' }));
  assert.deepEqual(payload.mutatedDocumentIds, ['doc-1', 'doc-2']);
  assert.equal(payload.commitId, '42');
});

test('execute_dql (local) caps rows at 10000 with a truncated marker', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: () => Promise.resolve({
        rows: Array.from({ length: 10_001 }, (_, i) => ({ _id: String(i) })),
        mutatedDocumentIds: [],
        commitId: null,
      }),
    },
  });
  const payload = obj(await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'SELECT * FROM big', transport: 'local' }));
  assert.equal(payload.rowCount, 10_000);
  assert.equal(payload.truncated, true);
  assert.equal(payload.totalRowCount, 10_001);
});

test('execute_dql requires a connection', async () => {
  const bundle = makeContext();
  const result = await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'SELECT 1', transport: 'local' });
  assert.equal(result.isError, true);
  assert.match(errText(result), /No active connection/);
});

test('execute_dql propagates store errors onto the isError channel', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: { execute: () => Promise.reject(new Error('DQL syntax error near MOON')) },
  });
  const result = await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'MOON', transport: 'local' });
  assert.equal(result.isError, true);
  assert.match(errText(result), /DQL syntax error near MOON/);
});

test('execute_dql (http) without configuration returns the structured hint payload', async () => {
  const bundle = makeContext({
    configs: [seedConfig({ httpApiUrl: '' })],
    activeId: 'cfg-1',
  });
  const payload = obj(await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'SELECT 1', transport: 'http' }));
  assert.equal(payload.error, 'http_not_configured');
  assert.match(String(payload.hint), /HTTP API/);
});

test('execute_dql (http) routes through the scripted HTTP service', async () => {
  fakeHttp.__resetFakeHttp();
  fakeHttp.__setExecuteRemoteQuery((req) => {
    assert.match(req.query, /FROM remote/);
    return Promise.resolve({ items: [{ _id: 'r1' }] });
  });
  const bundle = makeContext({ activeId: 'cfg-1' });
  await seedSecrets(bundle, 'cfg-1', { httpApiKey: 'key-abc' });
  const payload = obj(await find(queryTools, 'execute_dql').handler(bundle.ctx, { query: 'SELECT * FROM remote', transport: 'http' }));
  assert.equal(payload.mode, 'http');
  assert.equal((payload.rows as unknown[]).length, 1);
});

// ─── insert_documents_from_file ──────────────────────────────

function writeTempJson(t: test.TestContext, value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'docs.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('insert_documents_from_file imports a JSON array', async (t) => {
  const executed: string[] = [];
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => {
        executed.push(q);
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
    },
  });
  const file = writeTempJson(t, [{ _id: 'a', v: 1 }, { _id: 'b', v: 2 }]);
  const result = await find(queryTools, 'insert_documents_from_file').handler(
    bundle.ctx, { file_path: file, collection: 'tasks', mode: 'insert' },
  );
  assert.equal(result.isError ?? false, false);
  const payload = obj(result);
  assert.equal(payload.inserted, 2);
  assert.equal(payload.failed, 0);
  assert.equal(payload.collection, 'tasks');
  assert.ok(executed.some(q => q.includes('INSERT INTO `tasks`')), 'query must target the quoted collection');
});

test('insert_documents_from_file validates the payload shape first', async (t) => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const badFile = writeTempJson(t, '{"not":"an array"}');
  const result = await find(queryTools, 'insert_documents_from_file').handler(
    bundle.ctx, { file_path: badFile, collection: 'tasks', mode: 'insert' },
  );
  assert.equal(result.isError, true);
  assert.match(errText(result), /array of JSON objects/);
  // The panel and the tool share one validator.
  assert.throws(() => validateJsonDocuments('[{"no":"id"}]'), /missing required '_id'/);
});

test('insert_documents_from_file reports a missing file cleanly', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  const result = await find(queryTools, 'insert_documents_from_file').handler(
    bundle.ctx, { file_path: '/does/not/exist.json', collection: 'tasks', mode: 'insert' },
  );
  assert.equal(result.isError, true);
  assert.ok(errText(result).length > 0);
});

test('insert_documents_from_file requires a connection', async (t) => {
  const bundle = makeContext();
  const file = writeTempJson(t, [{ _id: 'a' }]);
  const result = await find(queryTools, 'insert_documents_from_file').handler(
    bundle.ctx, { file_path: file, collection: 't', mode: 'insert' },
  );
  assert.equal(result.isError, true);
  assert.match(errText(result), /No active connection/);
});

// ─── collections & indexes ───────────────────────────────────

const COLLECTION_ROWS = [{ _id: 'c1', name: 'tasks' }, { _id: 'c2', name: 'orders' }];
const INDEX_ROWS = [
  { _id: 'tasks.idx_tasks_done', collection: 'tasks', fields: [{ key: ['done'], direction: 'ASC' }] },
  { _id: 'orders.idx_orders_total', collection: 'orders', fields: [{ key: ['total'], direction: 'DESC' }] },
];

function wiredForCollections(opts: Parameters<typeof makeContext>[0] = {}): ReturnType<typeof makeContext> {
  return makeContext({
    activeId: 'cfg-1',
    ...opts,
    manager: {
      execute: (q) => {
        if (q === 'SELECT * FROM __collections') {
          return Promise.resolve({ rows: COLLECTION_ROWS, mutatedDocumentIds: [], commitId: null });
        }
        if (q.startsWith('SELECT COUNT(*)')) {
          return Promise.resolve({ rows: [{ numDocs: 7 }], mutatedDocumentIds: [], commitId: null });
        }
        if (q === 'SELECT * FROM system:indexes' || q.startsWith('SELECT * FROM system:indexes ')) {
          return Promise.resolve({ rows: INDEX_ROWS, mutatedDocumentIds: [], commitId: null });
        }
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
      ...opts.manager,
    },
  });
}

test('list_collections returns names, live counts, and nested indexes', async () => {
  const bundle = wiredForCollections();
  const result = await find(collectionTools, 'list_collections').handler(bundle.ctx, {});
  assert.equal(result.isError ?? false, false);
  const rows = arr(result);
  assert.equal(rows.length, 2);
  // Sorted by name (repository contract).
  assert.deepEqual(rows.map(r => r.name), ['orders', 'tasks']);
  assert.equal(head(rows).documentCount, 7);
  const idx = head(head(rows).indexes as Record<string, unknown>[]);
  assert.equal(idx.fullName, 'orders.idx_orders_total');
  assert.deepEqual(idx.fields, ['total DESC']);
});

test('list_indexes flattens across collections', async () => {
  const bundle = wiredForCollections();
  const rows = arr(await find(collectionTools, 'list_indexes').handler(bundle.ctx, {}));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.name).sort(), ['idx_orders_total', 'idx_tasks_done']);
});

test('list_collections requires a connection', async () => {
  const bundle = makeContext();
  const result = await find(collectionTools, 'list_collections').handler(bundle.ctx, {});
  assert.equal(result.isError, true);
  assert.match(errText(result), /No active connection/);
});

test('list_indexes returns [] (not an error) with no connection', async () => {
  const bundle = makeContext();
  const result = await find(collectionTools, 'list_indexes').handler(bundle.ctx, {});
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(arr(result), []);
});

test('create_index single field + composite + already-exists + conflict', async () => {
  const bundle = wiredForCollections();
  const ddl: string[] = [];
  bundle.manager.state.execute = (q, args) => {
    if (q === 'SELECT * FROM __collections') {
      return Promise.resolve({ rows: COLLECTION_ROWS, mutatedDocumentIds: [], commitId: null });
    }
    if (q.startsWith('SELECT COUNT(*)')) {
      return Promise.resolve({ rows: [{ numDocs: 0 }], mutatedDocumentIds: [], commitId: null });
    }
    if (q.startsWith('SELECT * FROM system:indexes WHERE _id = :id')) {
      const id = String(args?.id);
      return Promise.resolve({
        rows: INDEX_ROWS.filter(r => r._id === id), mutatedDocumentIds: [], commitId: null,
      });
    }
    if (q === 'SELECT * FROM system:indexes') {
      return Promise.resolve({ rows: INDEX_ROWS, mutatedDocumentIds: [], commitId: null });
    }
    if (q.startsWith('CREATE INDEX')) { ddl.push(q); return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: '7' }); }
    return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
  };

  const created = obj(await find(collectionTools, 'create_index').handler(bundle.ctx, {
    collection: 'tasks', fields: [{ name: 'done' }, { name: 'title', direction: 'DESC' }],
  }));
  assert.equal(created.outcome, 'created');
  assert.equal(created.index, 'idx_tasks_done_title', 'response carries the generated name (automation can drop it without a list call)');
  assert.ok(ddl.some(q => q.includes('ON `tasks`') && q.includes('`done` ASC') && q.includes('`title` DESC')),
    `composite DDL order preserved: ${ddl.join(' | ')}`);

  const again = obj(await find(collectionTools, 'create_index').handler(bundle.ctx, { collection: 'tasks', field: 'done' }));
  assert.equal(again.outcome, 'already-exists');
  assert.equal(again.index, 'idx_tasks_done');

  const conflict = await find(collectionTools, 'create_index').handler(bundle.ctx, {
    collection: 'tasks', fields: [{ name: 'done', direction: 'DESC' }],
  });
  assert.equal(conflict.isError, true);
  assert.match(errText(conflict), /already exists.*different/i);
});

test('create_index with neither field nor fields is a usage error', async () => {
  const bundle = wiredForCollections();
  const result = await find(collectionTools, 'create_index').handler(bundle.ctx, { collection: 'tasks' });
  assert.equal(result.isError, true);
  assert.match(errText(result), /field/);
});

test('drop_index refuses an ambiguous bare name (SwiftUI parity)', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => {
        if (q === 'SELECT * FROM system:indexes') {
          return Promise.resolve({
            rows: [
              { _id: 'a.idx_common', collection: 'a', fields: [{ key: ['x'], direction: 'ASC' }] },
              { _id: 'b.idx_common', collection: 'b', fields: [{ key: ['x'], direction: 'ASC' }] },
            ],
            mutatedDocumentIds: [],
            commitId: null,
          });
        }
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
    },
  });
  const result = await find(collectionTools, 'drop_index').handler(bundle.ctx, { index_name: 'idx_common' });
  assert.equal(result.isError, true);
  assert.match(errText(result), /multiple collections/);
});

test('drop_index succeeds once disambiguated and rejects unknown names', async () => {
  const dropped: string[] = [];
  const bundle = makeContext({
    activeId: 'cfg-1',
    manager: {
      execute: (q) => {
        if (q === 'SELECT * FROM system:indexes') {
          return Promise.resolve({
            rows: [{ _id: 'a.idx_common', collection: 'a', fields: [{ key: ['x'], direction: 'ASC' }] }],
            mutatedDocumentIds: [],
            commitId: null,
          });
        }
        if (q.startsWith('DROP INDEX')) { dropped.push(q); return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null }); }
        if (q === 'SELECT * FROM __collections') { return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null }); }
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
    },
  });
  const okRes = await find(collectionTools, 'drop_index').handler(bundle.ctx, { index_name: 'idx_common', collection: 'a' });
  assert.equal(okRes.isError ?? false, false);
  assert.ok(dropped.some(q => q.includes('`idx_common`') && q.includes('ON `a`')));
  const missing = await find(collectionTools, 'drop_index').handler(bundle.ctx, { index_name: 'nope', collection: 'a' });
  assert.equal(missing.isError, true);
});

// ─── sync / peers / transports ───────────────────────────────

test('get_sync_status reports sync, peers, transports', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    configs: [seedConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: true })],
  });
  bundle.manager.state.snapshot = {
    local: null,
    remote: [
      { id: 'p', isDittoServer: false, deviceName: 'n', connections: [], syncSessionStatus: 'Connected' },
      { id: 'cloud', isDittoServer: true, deviceName: 'Ditto Cloud', connections: [], syncSessionStatus: 'Connected' },
    ],
  };
  const payload = obj(await find(syncTools, 'get_sync_status').handler(bundle.ctx, {}));
  assert.equal(payload.sync, 'active');
  // One convention across tools: the synthetic cloud row never counts as a peer.
  assert.equal(payload.connectedPeers, 1);
  assert.equal(payload.cloudSyncConnected, true);
  assert.deepEqual(payload.transport, { lan: true, bluetoothLE: false, awdl: true });
});

test('set_sync toggles only when state differs', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  bundle.manager.state.syncState = 'active';
  const on = await find(syncTools, 'set_sync').handler(bundle.ctx, { enabled: true });
  assert.equal(bundle.manager.state.toggleSyncCalls, 0, 'already-on must not toggle');
  assert.equal(obj(on).enabled, true);
  const off = await find(syncTools, 'set_sync').handler(bundle.ctx, { enabled: false });
  assert.equal(bundle.manager.state.toggleSyncCalls, 1);
  assert.equal(obj(off).sync, 'stopped');
});

test('configure_transport merges over the persisted prefs and persists via the manager', async () => {
  const bundle = makeContext({
    activeId: 'cfg-1',
    configs: [seedConfig({ isLanEnabled: true, isBluetoothLeEnabled: true, isAwdlEnabled: false })],
  });
  const result = await find(syncTools, 'configure_transport').handler(bundle.ctx, { awdl: true });
  assert.equal(result.isError ?? false, false);
  const applied = bundle.manager.state.appliedTransports.at(-1);
  assert.deepEqual(applied, { isLanEnabled: true, isBluetoothLeEnabled: true, isAwdlEnabled: true });
  assert.deepEqual(obj(result).transport, { lan: true, bluetoothLE: true, awdl: true });
});

test('configure_transport refuses while another apply is in flight', async () => {
  const bundle = makeContext({ activeId: 'cfg-1', manager: { applyingTransports: true } });
  const result = await find(syncTools, 'configure_transport').handler(bundle.ctx, { lan: true });
  assert.equal(result.isError, true);
  assert.match(errText(result), /already in progress/);
});

test('get_peers returns the merged snapshot without metadata bodies', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  bundle.manager.state.snapshot = {
    local: {
      peerKey: 'local-1', deviceName: 'VS Code',
      sdkLanguage: 'js', sdkPlatform: 'node', sdkVersion: '5.1.0',
    },
    remote: [{
      id: 'peer-9', isDittoServer: false, deviceName: 'Pixel 8', os: 'Android',
      dittoSdkVersion: '5.0.0', isConnectedToDittoServer: true,
      peerMetadata: { role: 'kds' }, identityMetadata: { a: '1', b: '2' },
      connections: [{ id: 'c1', connectionType: 'P2PWiFi', peer1: 'local-1', peer2: 'peer-9' }],
      syncSessionStatus: 'Connected', syncedUpToLocalCommitId: 55,
    }],
    presenceGraph: { remotePeers: [], connections: [] },
  };
  const result = await find(syncTools, 'get_peers').handler(bundle.ctx, {});
  const payload = obj(result);
  assert.equal(payload.count, 1);
  // The shared count convention: get_peers.count === connectedPeers, and a
  // synthetic cloud row must never inflate either.
  assert.equal(payload.connectedPeers, 1);
  assert.equal(payload.totalRowsIncludingCloudRow, 1);
  assert.equal(payload.cloudSyncConnected, false);
  const peer = head(payload.peers as Record<string, unknown>[]);
  assert.equal(peer.peerKey, 'peer-9');
  assert.equal(peer.peerMetadataKeyCount, 1);
  assert.equal(peer.identityMetadataKeyCount, 2);
  assert.equal(peer.syncedUpToLocalCommitId, 55);
  assert.ok(!errText(result).includes('kds'), 'peer metadata VALUES must not cross the MCP wire — counts only');
});

// ─── query metrics ───────────────────────────────────────────

test('get_query_metrics lists captured records for the active connection', async () => {
  const bundle = makeContext({ activeId: 'cfg-1' });
  bundle.queryMetrics.capture('cfg-1', {
    dql: 'SELECT * FROM tasks', durationMs: 12, resultCount: 3,
    explain: '{"plan":{}}', timestamp: 1700000000000, location: 'local',
  });
  bundle.queryMetrics.capture('cfg-2', {
    dql: 'SELECT * FROM other', durationMs: 1, resultCount: 1,
    explain: '', timestamp: 1700000001000, location: 'local',
  });
  const result = await find(metricsTools, 'get_query_metrics').handler(bundle.ctx, {});
  assert.equal(result.isError ?? false, false);
  const records = obj(result).records as Record<string, unknown>[];
  assert.equal(records.length, 1, 'other connections are not in scope');
  assert.equal(head(records).dql, 'SELECT * FROM tasks');
});

test('get_query_metrics with no connection is an error', async () => {
  const bundle = makeContext();
  const result = await find(metricsTools, 'get_query_metrics').handler(bundle.ctx, {});
  assert.equal(result.isError, true);
  assert.match(errText(result), /No active connection/);
});

// ─── logs ────────────────────────────────────────────────────

const LOG_LINES = [
  '2026-09-06T10:00:00.000Z  INFO   [ext]  Ditto Edge Studio extension activated.',
  '2026-09-06T10:00:01.000Z  DEBUG  [sdk]  mDNS listener bound',
  '2026-09-06T10:00:02.000Z  WARN   [sdk]  peer clock skew detected',
  '2026-09-06T10:00:03.000Z  ERROR  [sdk]  handshake failed',
  '2026-09-06T10:00:04.000Z  INFO   [transport]  LAN transport disabled',
];

test('get_app_logs applies the substring filter and line cap', async () => {
  const bundle = makeContext({ logLines: LOG_LINES });
  const payload = obj(await find(logTools, 'get_app_logs').handler(bundle.ctx, { lines: 50, filter: 'extension' }));
  const lines = payload.lines as string[];
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /activated/);
});

test('get_ditto_logs only returns ditto-origin tags and honours the minimum level', async () => {
  const bundle = makeContext({ logLines: LOG_LINES });
  const leveled = obj(await find(logTools, 'get_ditto_logs').handler(bundle.ctx, { lines: 50, level: 'warn' }));
  const messages = ((leveled.entries ?? []) as Record<string, unknown>[]).map(e => String(e.message));
  assert.ok(messages.some(m => m.includes('clock skew')));
  assert.ok(messages.some(m => m.includes('handshake failed')));
  assert.ok(!messages.some(m => m.includes('mDNS listener')), 'info is below warn');
  assert.ok(!messages.some(m => m.includes('extension activated')), 'ext tag is not ditto-origin');
  assert.ok(!messages.some(m => m.includes('LAN transport')), 'info-level transport line is below warn');

  // No level filter → every ditto-origin line (incl. `transport`) appears.
  const unfiltered = obj(await find(logTools, 'get_ditto_logs').handler(bundle.ctx, { lines: 50 }));
  const all = ((unfiltered.entries ?? []) as Record<string, unknown>[]).map(e => String(e.message));
  assert.ok(all.some(m => m.includes('LAN transport')), 'transport tag counts as ditto-origin');
  assert.ok(all.some(m => m.includes('mDNS listener')));
  assert.ok(!all.some(m => m.includes('extension activated')));
});
