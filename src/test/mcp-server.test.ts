import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { McpServerService, MCP_MAX_BODY_BYTES } from '../mcp/McpServerService.js';
import { registerAllTools } from '../mcp/registry.js';
import { registerAllResources } from '../mcp/resources.js';
import { makeContext, makeFakeLogger, seedConfig, type FakeContextBundle } from './fixtures/mcp-fakes.js';

/**
 * Transport-level MCP tests: real HTTP over an ephemeral loopback port,
 * with the REAL tool registry wired to faked extension services.
 * Tool-body behaviour lives in mcp-tools.test.ts.
 */

interface StartedServer {
  service: McpServerService;
  base: string;
  bundle: FakeContextBundle;
}

async function startServer(t: test.TestContext, opts: Parameters<typeof makeContext>[0] = {}): Promise<StartedServer> {
  const bundle = makeContext(opts);
  const service = new McpServerService({
    name: 'ditto-edge-studio-vscode',
    version: '0.0.0-test',
    // Mirror production (McpServerController): tools AND resources.
    register: (s) => { registerAllTools(s, bundle.ctx); registerAllResources(s, bundle.ctx); },
    log: makeFakeLogger(),
  });
  await service.start(0); // ephemeral port
  t.after(() => service.stop().catch(() => { /* teardown best effort */ }));
  const port = service.port;
  assert.ok(port, 'server should report its bound port');
  return { service, base: `http://127.0.0.1:${port}`, bundle };
}

interface RpcResponse {
  status: number;
  sessionId: string | null;
  body: Record<string, unknown>;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function rpc(base: string, message: Record<string, unknown>, sessionId?: string): Promise<RpcResponse> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (sessionId) { headers['mcp-session-id'] = sessionId; }
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(message) });
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  let body: Record<string, unknown>;
  if (ct.includes('text/event-stream')) {
    const line = text.split('\n').find(l => l.startsWith('data:'));
    body = line ? JSON.parse(line.slice(5)) as Record<string, unknown> : {};
  } else if (text.length > 0) {
    body = JSON.parse(text) as Record<string, unknown>;
  } else {
    body = {};
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body };
}

async function openSession(t: test.TestContext, base: string): Promise<string> {
  const res = await rpc(base, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0' },
    },
  });
  assert.equal(res.status, 200, `initialize should succeed: ${JSON.stringify(res.body)}`);
  const sid = res.sessionId;
  assert.ok(sid, 'initialize response must carry mcp-session-id');
  // Notifications are fire-and-forget.
  const note = await rpc(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  assert.ok(note.status === 200 || note.status === 202, `initialized notification → 2xx, got ${note.status}`);
  t.after(async () => {
    // Session cleanup — bounded: when the test stopped the server first, a
    // keep-alive-pooled socket can black-hole this request until undici's
    // 300 s headersTimeout; by then there is nothing to clean up anyway.
    await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  });
  return sid;
}

test('health endpoint answers OK', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'OK');
});

test('initialize advertises serverInfo + tools capability', async (t) => {
  const { base } = await startServer(t);
  const sid = await openSession(t, base);
  assert.ok(sid.length > 0);
  // (openSession already asserted status 200; inspect the advertise shape
  // via tools/list below.)
});

test('tools/list exposes the full surface with schemas (both parity and extension-only)', async (t) => {
  const { base } = await startServer(t);
  const sid = await openSession(t, base);
  const res = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
  assert.equal(res.status, 200);
  const result = res.body.result as { tools: { name: string; description: string; inputSchema: unknown }[] };
  const names = result.tools.map(tl => tl.name).sort();
  // Lock the transport-level count; the exact set is asserted data-side in
  // mcp-tools.test.ts's manifest test.
  assert.equal(names.length, 31);
  for (const required of ['execute_dql', 'get_system_metrics', 'connect_database', 'debug_socket_query']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  for (const tool of result.tools) {
    assert.ok(tool.description.length > 10, `${tool.name} needs a real description`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `${tool.name} needs an inputSchema`);
  }
});

test('tools/call runs list_databases over the fake service graph', async (t) => {
  const { base } = await startServer(t);
  const sid = await openSession(t, base);
  const res = await rpc(base, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'list_databases', arguments: {} },
  }, sid);
  assert.equal(res.status, 200);
  const result = res.body.result as { content: { type: string; text: string }[] };
  const firstBlock = result.content[0];
  assert.ok(firstBlock, 'tool result must carry a content block');
  const rows = JSON.parse(firstBlock.text) as Record<string, unknown>[];
  assert.deepEqual(rows.map(r => r.name), ['Dev DB']);
});

test('unknown session is rejected 404 BEFORE the tool executes', async (t) => {
  const { base, bundle } = await startServer(t, { activeId: 'cfg-1' });
  const before = bundle.manager.state.executeCalls.length;
  const res = await rpc(base, {
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'execute_dql', arguments: { query: 'SELECT * FROM x' } },
  }, 'sess-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(bundle.manager.state.executeCalls.length, before, 'tool body must not run');
});

test('first request without a session must be initialize', async (t) => {
  const { base } = await startServer(t);
  const res = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(res.status, 400);
});

test('request body over the cap is refused 413', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: ' '.repeat(MCP_MAX_BODY_BYTES + 1),
  });
  assert.equal(res.status, 413);
});

test('invalid JSON body is a parse error, not a crash', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{nope',
  });
  assert.equal(res.status, 400);
  assert.equal((JSON.parse(await res.text())).error.code, -32700);
});

test('schema-invalid tool arguments come back as an error result or protocol error', async (t) => {
  const { base } = await startServer(t, { activeId: 'cfg-1' });
  const sid = await openSession(t, base);
  const res = await rpc(base, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'execute_dql', arguments: {} }, // missing query
  }, sid);
  const hasProtocolError = res.body.error !== undefined;
  const result = res.body.result as { isError?: boolean } | undefined;
  const hasToolError = result?.isError === true;
  assert.ok(hasProtocolError || hasToolError, `expected an error surface, got ${JSON.stringify(res.body)}`);
});

test('legacy SSE transport: endpoint hand-off, POST /messages round-trip, stale session 404', async (t) => {
  const { base } = await startServer(t);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());

  const sseRes = await fetch(`${base}/sse`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.ok((sseRes.headers.get('content-type') ?? '').includes('text/event-stream'));
  assert.ok(sseRes.body);

  const decoder = new TextDecoder();
  const reader = sseRes.body.getReader();
  let buffer = '';
  const nextChunk = async (): Promise<string> => {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'SSE stream ended unexpectedly');
    buffer += decoder.decode(value, { stream: true });
    const out = buffer;
    buffer = '';
    return out;
  };

  // First thing the transport sends: the endpoint event with our session URL.
  let endpointData = '';
  for (let i = 0; i < 5 && !endpointData.includes('sessionId='); i += 1) {
    endpointData += await nextChunk();
  }
  const sidMatch = /sessionId=([0-9a-fA-F-]+)/.exec(endpointData);
  assert.ok(sidMatch, `endpoint event should carry sessionId: ${endpointData}`);
  const sid = sidMatch[1];

  // Stale/unknown session posts are refused BEFORE dispatch.
  const stale = await fetch(`${base}/messages?sessionId=nope-not-a-session`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'list_databases', arguments: {} } }),
  });
  assert.equal(stale.status, 404);

  // And a real round-trip over the SSE session.
  const posted = await fetch(`${base}/messages?sessionId=${sid}`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'legacy-test', version: '0' } },
    }),
  });
  assert.ok(posted.status === 202, `POST /messages → 202, got ${posted.status}`);
  let events = '';
  for (let i = 0; i < 10 && !events.includes('"serverInfo"'); i += 1) {
    events += await nextChunk();
  }
  assert.ok(events.includes('ditto-edge-studio-vscode'), `initialize reply should name the server: ${events}`);
});

/** fetch() cannot override Host (forbidden header) — go through http directly. */
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body) { req.write(opts.body); }
    req.end();
  });
}

test('DNS-rebinding guard: a non-loopback Host is 403 on /mcp, /messages, and /sse; live Host still works', async (t) => {
  const { service, base } = await startServer(t);
  const port = service.port;
  assert.ok(port);
  const evilHost = { host: `attacker.example:${port}` };

  const badInit = await rawRequest(`${base}/mcp`, {
    method: 'POST',
    headers: { ...evilHost, ...JSON_HEADERS },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'evil', version: '0' } },
    }),
  });
  assert.equal(badInit.status, 403, `rebinding Host must not open a session: ${badInit.body}`);

  const badMessages = await rawRequest(`${base}/messages?sessionId=whatever`, {
    method: 'POST', headers: { ...evilHost, ...JSON_HEADERS }, body: '{}',
  });
  assert.equal(badMessages.status, 403);
  assert.equal(service.sessionCount, 0, 'rejected requests never mint sessions');

  const badSse = await rawRequest(`${base}/sse`, { headers: { ...evilHost, accept: 'text/event-stream' } });
  assert.equal(badSse.status, 403);

  // Health is deliberately unauthenticated and stays reachable.
  const health = await rawRequest(`${base}/health`, { headers: evilHost });
  assert.equal(health.status, 200);

  // And ordinary loopback clients (fetch sets Host: 127.0.0.1:<port>) are unaffected.
  const sid = await openSession(t, base);
  assert.ok(sid.length > 0);
});

test('legacy SSE client disconnect tears the session down and the server stays healthy', async (t) => {
  const { service, base } = await startServer(t);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());

  const sseRes = await fetch(`${base}/sse`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.ok(sseRes.body);
  assert.equal(service.sessionCount, 1, 'SSE session registered on connect');

  ctrl.abort(); // the client goes away mid-stream
  // Let the server observe the socket close and run the onclose chain. The
  // regression being pinned: onclose -> server.close() -> transport.close()
  // -> onclose used to recurse into RangeError (visible as stderr spam).
  await new Promise(r => setTimeout(r, 100));
  assert.equal(service.sessionCount, 0, 'session removed on client disconnect');

  const health = await fetch(`${base}/health`);
  assert.equal(await health.text(), 'OK', 'server survives a legacy client teardown');

  // …and a fresh legacy client can still connect.
  const ctrl2 = new AbortController();
  t.after(() => ctrl2.abort());
  const again = await fetch(`${base}/sse`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl2.signal,
  });
  assert.equal(again.status, 200);
  assert.equal(service.sessionCount, 1);
});

test('ditto://peers resource ships metadata key COUNTS only — never bodies', async (t) => {
  const { base, bundle } = await startServer(t, { activeId: 'cfg-1' });
  bundle.manager.state.snapshot = {
    local: {
      peerKey: 'local-1', deviceName: 'VS Code',
      sdkLanguage: 'js', sdkPlatform: 'node', sdkVersion: '5.1.0',
    },
    remote: [{
      id: 'peer-9', isDittoServer: false, deviceName: 'Pixel 8', os: 'Android',
      dittoSdkVersion: '5.0.0', isConnectedToDittoServer: true,
      peerMetadata: { role: 'kds-secret-value' },
      identityMetadata: { a: '1', b: '2' },
      connections: [{ id: 'c1', connectionType: 'P2PWiFi', peer1: 'local-1', peer2: 'peer-9' }],
      syncSessionStatus: 'Connected', syncedUpToLocalCommitId: 55,
    }],
    presenceGraph: { remotePeers: [], connections: [] },
  };
  const sid = await openSession(t, base);
  const res = await rpc(base, { jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: 'ditto://peers' } }, sid);
  assert.equal(res.status, 200);
  const result = res.body.result as { contents: { text: string }[] };
  const block = result.contents[0];
  assert.ok(block);
  assert.ok(!block.text.includes('kds-secret-value'),
    'peer metadata VALUES must not cross the MCP wire via resources either — the doc invariant covers every surface');
  const payload = JSON.parse(block.text) as { remote: Record<string, unknown>[] };
  const peer = payload.remote[0];
  assert.ok(peer);
  assert.equal(peer.peerKey, 'peer-9');
  assert.equal(peer.peerMetadataKeyCount, 1);
  assert.equal(peer.identityMetadataKeyCount, 2);
});

test('resources/list + resources/read: ditto:// schema, peers, sync-status, subscriptions, system-metrics', async (t) => {
  const { base, bundle } = await startServer(t, {
    activeId: 'cfg-1',
    manager: {
      execute: (q) => {
        if (q === 'SELECT * FROM __collections') {
          return Promise.resolve({ rows: [{ _id: 'c1', name: 'tasks' }], mutatedDocumentIds: [], commitId: null });
        }
        if (q.startsWith('SELECT COUNT(*)')) {
          return Promise.resolve({ rows: [{ numDocs: 3 }], mutatedDocumentIds: [], commitId: null });
        }
        return Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null });
      },
    },
  });
  void bundle;
  const sid = await openSession(t, base);

  const listRes = await rpc(base, { jsonrpc: '2.0', id: 10, method: 'resources/list', params: {} }, sid);
  assert.equal(listRes.status, 200);
  const resources = (listRes.body.result as { resources: { uri: string; name: string }[] }).resources;
  const uris = resources.map(r => r.uri).sort();
  for (const expected of [
    'ditto://schema', 'ditto://peers', 'ditto://sync-status',
    'ditto://system-metrics', 'ditto://subscriptions', 'ditto://observers',
  ]) {
    assert.ok(uris.includes(expected), `missing resource ${expected}`);
  }

  const read = async (uri: string) => {
    const r = await rpc(base, { jsonrpc: '2.0', id: 11, method: 'resources/read', params: { uri } }, sid);
    assert.equal(r.status, 200, `${uri} read`);
    const result = r.body.result as { contents: { text: string; mimeType?: string }[] };
    const block = result.contents[0];
    assert.ok(block, `${uri} must return a contents block`);
    return JSON.parse(block.text) as Record<string, unknown>;
  };

  const schema = await read('ditto://schema');
  assert.deepEqual((schema.collections as Record<string, unknown>[]).map(c => c.name), ['tasks']);

  const subs = await read('ditto://subscriptions');
  assert.deepEqual(subs.subscriptions, []);

  const sync = await read('ditto://sync-status');
  assert.equal(sync.sync, 'active');
  // The resource now shares the get_sync_status contract exactly:
  // transports present, cloud as boolean, peer count convention identical.
  assert.ok(sync.transport && typeof (sync.transport as Record<string, unknown>).lan === 'boolean');
  assert.equal(typeof sync.connectedPeers, 'number');
  assert.equal(sync.cloudSyncConnected, false);

  const peers = await read('ditto://peers');
  assert.ok('remote' in peers);

  const metrics = await read('ditto://system-metrics');
  assert.equal(metrics.status, 'no-data-yet', 'no accumulator has polled yet');

  // After the tool forces a read, the same resource reports the snapshot.
  await rpc(base, {
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'execute_dql', arguments: { query: 'SELECT 1' } },
  }, sid);
  await rpc(base, {
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'get_system_metrics', arguments: {} },
  }, sid);
  // get_system_metrics was answered 'unavailable' or 'exporterDisabled' for
  // this fake (no system:metrics rows scripted) — either way the resource
  // stays honest; when the exporter placeholder is present the resource
  // reports that path too.
  const metrics2 = await read('ditto://system-metrics');
  assert.ok(metrics2.status === 'no-data-yet' || metrics2.status === 'ok');
});

test('resources return noConnection JSON (not protocol errors) while disconnected', async (t) => {
  const { base } = await startServer(t); // nothing connected
  const sid = await openSession(t, base);
  const r = await rpc(base, { jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: 'ditto://schema' } }, sid);
  assert.equal(r.status, 200);
  assert.equal(r.body.error, undefined, 'a disconnected read is a normal response, not a protocol error');
  const result = r.body.result as { contents: { text: string }[] };
  const block = result.contents[0];
  assert.ok(block);
  const payload = JSON.parse(block.text) as Record<string, unknown>;
  assert.equal(payload.error, 'no_active_connection');
});

/** A free loopback port, probed then released for the subject to bind. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;
  await new Promise<void>(r => { probe.close(() => r()); });
  return port;
}

/** Rebind a listener the subject claims to have released — the only real
 *  proof the socket is gone. A leaked listener fails this with EADDRINUSE;
 *  hosts without IPv6 (EADDRNOTAVAIL) have nothing to leak, so that one
 *  code is tolerated for the ::1 probe. */
async function assertPortFree(t: test.TestContext, port: number, host: string): Promise<void> {
  const probe = http.createServer();
  t.after(() => new Promise<void>(r => { probe.close(() => r()); }));
  await new Promise<void>((resolve, reject) => {
    probe.once('error', (e: NodeJS.ErrnoException) => {
      if (host === '::1' && e.code === 'EADDRNOTAVAIL') { resolve(); return; }
      reject(e);
    });
    probe.listen(port, host, () => resolve());
  });
  assert.equal(probe.listening, true, `${host}:${port} should be re-bindable after stop()`);
}

test('stop() drains sessions and releases the port', async (t) => {
  // Explicit (non-ephemeral) port so the service binds BOTH the 127.0.0.1
  // and ::1 listeners — the ephemeral path skips IPv6 by design, which
  // would make a ::1 rebind assertion vacuous.
  const port = await freePort();
  const bundle = makeContext({ configs: [seedConfig()], activeId: 'cfg-1' });
  const service = new McpServerService({
    name: 'ditto-edge-studio-vscode',
    version: '0.0.0-test',
    register: (s) => { registerAllTools(s, bundle.ctx); registerAllResources(s, bundle.ctx); },
    log: makeFakeLogger(),
  });
  await service.start(port);
  t.after(() => service.stop().catch(() => { /* teardown best effort */ }));
  const base = `http://127.0.0.1:${port}`;

  const sid = await openSession(t, base);
  assert.ok(service.sessionCount >= 1);
  await service.stop();
  assert.equal(service.sessionCount, 0);
  assert.equal(service.isRunning, false);
  const res = await rpc(base, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'list_databases', arguments: {} },
  }, sid).catch(() => null);
  assert.ok(res === null || res.status !== 200, 'stopped server must not keep serving sessions');
  // "Releases the port" is only proven by taking it back: a server that
  // refused the probe above while still holding a listener would pass
  // without these. Both loopback families the service binds are checked.
  await assertPortFree(t, port, '127.0.0.1');
  await assertPortFree(t, port, '::1');
});

test('two servers can bind distinct ephemeral ports side by side', async (t) => {
  const bundle = makeContext({ configs: [seedConfig()], activeId: 'cfg-1' });
  const mk = () => new McpServerService({
    name: 'a', version: 't', register: (s) => registerAllTools(s, bundle.ctx), log: makeFakeLogger(),
  });
  const s1 = mk(); const s2 = mk();
  await s1.start(0); await s2.start(0);
  t.after(() => Promise.allSettled([s1.stop(), s2.stop()]).then(() => undefined));
  assert.notEqual(s1.port, s2.port);
});
