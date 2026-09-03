import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DebugSocketClient } from '../ditto/DebugSocketClient.js';

/**
 * Realtime tests for the debug_socket client protocol against a REAL
 * in-process `net.createServer` on a tmpdir Unix socket (macOS/Linux).
 *
 * The fake server speaks the wire protocol from
 * crates/ditto-peer/src/subsystems/debug_socket.rs: newline-delimited; one
 * DQL statement per line in, exactly one reply line per statement out, in
 * order — either a single-line JSON array of result items or a line
 * starting with `ERROR:`.
 */

const noopLogger = {
  warn() { /* no-op */ },
  error() { /* no-op */ },
  info() { /* no-op */ },
};

interface FakeServer {
  server: net.Server;
  socketPath: string;
  /** Every line the server has received, in order. */
  received: string[];
  /** The live client sockets, so tests can kill the server side of one. */
  connections: net.Socket[];
  close(): Promise<void>;
}

/** Map from statement → reply line to send back, with an optional delay. */
interface ResponderMap {
  replies?: Map<string, string>;
  /** Statements the server never replies to (holds the line open). */
  hold?: Set<string>;
  /** Called for any statement not in `replies`; return the reply line. */
  fallback?: (statement: string) => string;
}

async function startFakeServer(t: test.TestContext, respond: ResponderMap): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-debug-sock-test-'));
  const socketPath = path.join(dir, 'test.sock');
  const received: string[] = [];
  const connections: net.Socket[] = [];

  const server = net.createServer((socket) => {
    connections.push(socket);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) { break; }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) { continue; }
        received.push(line);
        if (respond.hold?.has(line)) { continue; }
        const reply = respond.replies?.get(line) ?? respond.fallback?.(line) ?? '[]';
        socket.write(reply + '\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  const handle: FakeServer = {
    server,
    socketPath,
    received,
    connections,
    async close() {
      for (const c of connections) { c.destroy(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  t.after(() => handle.close());
  return handle;
}

function makeClient(t: test.TestContext, options?: ConstructorParameters<typeof DebugSocketClient>[1]): DebugSocketClient {
  const client = new DebugSocketClient(noopLogger, options);
  t.after(() => client.disconnect());
  return client;
}

test('happy path: one connection serves many statements with replies matched in order', async (t) => {
  const srv = await startFakeServer(t, {
    fallback: (stmt) => (stmt.startsWith('SELECT')
      ? `[{"q":${JSON.stringify(stmt)}}]`
      : `[{"n":2}]`),
  });
  const client = makeClient(t);
  await client.connect(srv.socketPath);
  assert.equal(client.state, 'connected');

  const first = await client.query('SELECT * FROM cars');
  assert.deepEqual(first, { ok: true, items: [{ q: 'SELECT * FROM cars' }] });
  const second = await client.query('SELECT * FROM bikes');
  assert.deepEqual(second, { ok: true, items: [{ q: 'SELECT * FROM bikes' }] });
  const third = await client.query('INSERT INTO cars DOCUMENTS ({})');
  assert.deepEqual(third, { ok: true, items: [{ n: 2 }] });

  assert.deepEqual(srv.received, [
    'SELECT * FROM cars',
    'SELECT * FROM bikes',
    'INSERT INTO cars DOCUMENTS ({})',
  ]);
});

test('quick successive sends receive in-order replies, not out-of-order', async (t) => {
  // Even without awaiting, the wire must stay aligned: statement N's reply
  // resolves promise N.
  const srv = await startFakeServer(t, { fallback: (stmt) => `[{"echo":${JSON.stringify(stmt)}}]` });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const results = await Promise.all([
    client.query('q1'), client.query('q2'), client.query('q3'), client.query('q4'),
  ]);
  assert.deepEqual(results.map(r => r.ok && r.items[0]), [
    { echo: 'q1' }, { echo: 'q2' }, { echo: 'q3' }, { echo: 'q4' },
  ]);
});

test('ERROR: lines resolve as error results with the prefix stripped', async (t) => {
  const srv = await startFakeServer(t, {
    replies: new Map([['SELECT *** FROM cars', 'ERROR: Parse error: unexpected token `*`']]),
  });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT *** FROM cars');
  assert.equal(r.ok, false);
  assert.equal(r.ok ? undefined : r.error, 'Parse error: unexpected token `*`');
});

test('an empty result line resolves to an empty items array', async (t) => {
  const srv = await startFakeServer(t, { fallback: () => '[]' });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT * FROM nonexistent');
  assert.deepEqual(r, { ok: true, items: [] });
});

test('a non-JSON reply line resolves as a malformed-response error', async (t) => {
  const srv = await startFakeServer(t, { fallback: () => 'this is not json' });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT 1');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /not JSON/i);
});

test('a JSON-but-not-array reply resolves as a malformed-response error', async (t) => {
  const srv = await startFakeServer(t, { fallback: () => '{"oops":true}' });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT 1');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /array/i);
});

test('disconnect mid-flight fails the pending request and ends the state', async (t) => {
  const replies: string[] = [];
  const srv = await startFakeServer(t, { hold: new Set(['SELECT slow']), fallback: () => '[]' });
  void replies;
  const client = makeClient(t);
  const states: string[] = [];
  const watch = new DebugSocketClient(noopLogger, {
    onStateChange: (s) => { states.push(s); },
  });
  t.after(() => watch.disconnect());
  await watch.connect(srv.socketPath);

  const inFlight = watch.query('SELECT slow');
  // Give the socket a tick to deliver the statement, then kill the server
  // side of the connection.
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(srv.received, ['SELECT slow']);
  srv.connections[0]?.destroy();

  const r = await inFlight;
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /closed/i);
  assert.equal(watch.state, 'disconnected');
  assert.ok(states.includes('connected') && states.at(-1) === 'disconnected');
  client.disconnect();
});

test('reconnect: disconnect() then connect() to the same server works', async (t) => {
  const srv = await startFakeServer(t, { fallback: () => '[1]' });
  const client = makeClient(t);

  await client.connect(srv.socketPath);
  assert.equal((await client.query('SELECT 1')).ok, true);
  client.disconnect();
  assert.equal(client.state, 'disconnected');

  await client.connect(srv.socketPath);
  const r = await client.query('SELECT 2');
  assert.deepEqual(r, { ok: true, items: [1] });
});

test('queries issued while disconnected fail without touching the wire', async () => {
  const client = new DebugSocketClient(noopLogger);
  const r = await client.query('SELECT 1');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /[Nn]ot connected/);
});

test('connect() rejects a relative socket path', async (t) => {
  const client = makeClient(t);
  await assert.rejects(() => client.connect('relative/path.sock'), /absolute/);
});

test('multi-line statements are rejected before they can desync the FIFO', async (t) => {
  const srv = await startFakeServer(t, { fallback: () => '[]' });
  const client = makeClient(t);
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT 1\nSELECT 2');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /one statement/i);
  assert.deepEqual(srv.received, [], 'nothing should have been written to the socket');
});

test('requests beyond maxInFlight fail with a queue-full error', async (t) => {
  const srv = await startFakeServer(t, { hold: new Set(['held-1', 'held-2']), fallback: () => '[]' });
  const client = makeClient(t, { maxInFlight: 2 });
  await client.connect(srv.socketPath);

  const held1 = client.query('held-1');
  const held2 = client.query('held-2');
  const overflow = await client.query('held-3');
  assert.equal(overflow.ok, false);
  assert.match(overflow.ok ? '' : overflow.error, /queue is full/i);

  client.disconnect();
  await held1;
  await held2;
});

test('a request timeout closes the connection and fails everything pending', async (t) => {
  const srv = await startFakeServer(t, { hold: new Set(['slow-1', 'slow-2']), fallback: () => '[]' });
  let drop: { state: string; error?: string | undefined } | undefined;
  const client = new DebugSocketClient(noopLogger, {
    requestTimeoutMs: 100,
    onStateChange: (s, detail) => { if (s === 'disconnected') { drop = { state: s, error: detail?.error }; } },
  });
  t.after(() => client.disconnect());
  await client.connect(srv.socketPath);

  const first = client.query('slow-1');
  const second = client.query('slow-2');
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.ok, false);
  assert.match(r1.ok ? '' : r1.error, /timed out/i);
  assert.equal(r2.ok, false, 'later pending requests fail with it');
  assert.equal(client.state, 'disconnected');
  assert.match(drop?.error ?? '', /timed out/i);
});

test('a response line beyond maxLineBytes closes the connection', async (t) => {
  const huge = '[' + '0,'.repeat(500) + '0]';
  const srv = await startFakeServer(t, { fallback: () => huge });
  const client = makeClient(t, { maxLineBytes: 200 });
  await client.connect(srv.socketPath);

  const r = await client.query('SELECT big');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /safety limit/i);
  assert.equal(client.state, 'disconnected');
});

test('blank reply lines are skipped, not paired with a pending request', async (t) => {
  let blankInjected = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-debug-sock-blank-'));
  const socketPath = path.join(dir, 't.sock');
  const server = net.createServer((socket) => {
    socket.on('data', () => {
      if (blankInjected) { return; }
      blankInjected = true;
      // Two blank lines, then the real reply: the query must resolve with
      // the reply, proving the blanks were consumed without a pending entry.
      socket.write('\n\n[{"ok":true}]\n');
    });
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  const client = makeClient(t);
  await client.connect(socketPath);
  const r = await client.query('SELECT 1');
  assert.deepEqual(r, { ok: true, items: [{ ok: true }] });
});
