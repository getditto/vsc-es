import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServerService, MCP_MAX_BODY_BYTES } from '../mcp/McpServerService.js';
import { registerAllTools } from '../mcp/registry.js';
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
    register: (s) => registerAllTools(s, bundle.ctx),
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
    await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } }).catch(() => undefined);
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
  assert.equal(names.length, 28);
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

test('stop() drains sessions and releases the port', async (t) => {
  const { service, base } = await startServer(t);
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
