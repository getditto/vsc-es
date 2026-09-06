import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { installSessionLogObservers } from '../ditto/session-log-observers.js';
import { CONNECTION_REQUESTS_TAG, TRANSPORT_CONDITIONS_TAG, logTagForSource } from '../logAnalyzer/log-sources.js';
import { createLogger } from '../logging/Logger.js';
import { parseLine } from '../logAnalyzer/LineParser.js';
import type { Sink } from '../logging/Sink.js';
import type { Logger, LogContext, LogLevel } from '../logging/types.js';
import type { ConnectionRequest, ConnectionType, Ditto } from '@dittolive/ditto';

/**
 * The log-only session observers port SwiftUI/Android Edge Studio's
 * Transport Conditions and Connection Requests tabs. These tests pin the
 * emitted wire format (support playbooks quote it), the unconditional
 * 'allow' from the connection handler, and the teardown semantics.
 */

interface Captured { level: LogLevel; tag: string; message: string }

function captureLogger(): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const make = (tag: string): Logger => ({
    error: (message: string, _c?: LogContext) => { lines.push({ level: 'error', tag, message }); },
    warn: (message: string, _c?: LogContext) => { lines.push({ level: 'warn', tag, message }); },
    info: (message: string, _c?: LogContext) => { lines.push({ level: 'info', tag, message }); },
    debug: (message: string, _c?: LogContext) => { lines.push({ level: 'debug', tag, message }); },
    trace: (message: string, _c?: LogContext) => { lines.push({ level: 'trace', tag, message }); },
    withTag: (child: string) => make(child),
  }) as unknown as Logger;
  return { logger: make('root'), lines };
}

interface FakeDitto {
  transportCb: ((condition: string, source: string) => void) | null;
  stopped: number;
  handler: unknown;
  ditto: Ditto;
}

function fakeDitto(): FakeDitto {
  const f: FakeDitto = {
    transportCb: null,
    stopped: 0,
    handler: null,
    ditto: undefined as never,
  };
  const presence = {
    get connectionRequestHandler(): unknown { return f.handler; },
    set connectionRequestHandler(h: unknown) { f.handler = h; },
  };
  f.ditto = {
    observeTransportConditions: (cb: (condition: string, source: string) => void) => {
      f.transportCb = cb;
      return { stop: () => { f.stopped += 1; } };
    },
    presence,
  } as unknown as Ditto;
  return f;
}

function fakeRequest(over: Partial<{
  connectionType: ConnectionType;
  peerKey: string;
  identityServiceMetadata: Record<string, unknown>;
  peerMetadata: Record<string, unknown>;
}> = {}): ConnectionRequest {
  return {
    connectionType: over.connectionType ?? 'Bluetooth',
    peerKey: over.peerKey ?? 'pkRemote123',
    identityServiceMetadata: over.identityServiceMetadata ?? {},
    peerMetadata: over.peerMetadata ?? {},
  } as ConnectionRequest;
}

test('SessionLogObservers: transport conditions log under the transport tag', () => {
  const fake = fakeDitto();
  const { logger, lines } = captureLogger();
  installSessionLogObservers(fake.ditto, logger);

  assert.ok(fake.transportCb, 'the transport observer was registered');
  fake.transportCb?.('MDNSFailure', 'MDNS');
  fake.transportCb?.('OK', 'TCP');

  assert.deepEqual(lines, [
    { level: 'info', tag: TRANSPORT_CONDITIONS_TAG, message: 'Transport: MDNS → MDNSFailure' },
    { level: 'info', tag: TRANSPORT_CONDITIONS_TAG, message: 'Transport: TCP → OK' },
  ]);
});

test('SessionLogObservers: connection requests log the SwiftUI format and always allow', async () => {
  const fake = fakeDitto();
  const { logger, lines } = captureLogger();
  installSessionLogObservers(fake.ditto, logger);

  assert.equal(typeof fake.handler, 'function', 'the connection request handler was installed');
  const handler = fake.handler as (r: ConnectionRequest) => Promise<'allow'>;

  const empty = await handler(fakeRequest());
  assert.equal(empty, 'allow', 'log-only handler must never deny');

  await handler(fakeRequest({
    connectionType: 'P2PWiFi',
    peerKey: 'pkEdge987',
    identityServiceMetadata: { tenant: 'acme' },
    peerMetadata: { name: 'edge device' },
  }));

  // Peer metadata is remote-peer-controlled; a value JSON can't serialize
  // must degrade to a marker, not break the log line.
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  await handler(fakeRequest({ peerMetadata: circular }));

  assert.deepEqual(lines.map(l => l.message), [
    'Connection Request | type=Bluetooth | key=pkRemote123 | identity=none | meta=none',
    'Connection Request | type=P2PWiFi | key=pkEdge987'
      + ' | identity={"tenant":"acme"} | meta={"name":"edge device"}',
    'Connection Request | type=Bluetooth | key=pkRemote123 | identity=none | meta=<unserializable>',
  ]);
  assert.ok(lines.every(l => l.level === 'info' && l.tag === CONNECTION_REQUESTS_TAG));
});

test('SessionLogObservers: a logging failure inside the handler still allows the request', async () => {
  const fake = fakeDitto();
  const throwing = new Proxy({} as Logger, {
    get: (_t, prop) => {
      if (prop === 'withTag') { return () => throwing; }
      return () => { throw new Error('sink exploded'); };
    },
  });
  installSessionLogObservers(fake.ditto, throwing);
  const handler = fake.handler as (r: ConnectionRequest) => Promise<'allow'>;
  assert.equal(await handler(fakeRequest()), 'allow');
  // The SDK notes the request is denied if the handler exceeds its response
  // timeout — logging must never delay it, so the resolution is synchronous.
  fake.transportCb?.('TCPListenFailure', 'TCP'); // must not propagate either
});

test('SessionLogObservers: dispose stops the observer and unsets only our handler', async () => {
  const fake = fakeDitto();
  const { logger } = captureLogger();
  const handle = installSessionLogObservers(fake.ditto, logger);

  handle.dispose();
  assert.equal(fake.stopped, 1, 'transport observer stopped');
  assert.equal(fake.handler, null, 'handler removed when it is still ours');

  // A handler installed AFTER ours (e.g. by a future feature, or the next
  // connection) must survive disposing the old session.
  const fake2 = fakeDitto();
  const h2 = installSessionLogObservers(fake2.ditto, logger);
  fake2.handler = async () => 'deny' as const; // someone replaced it
  h2.dispose();
  assert.notEqual(fake2.handler, null, 'a replacement handler is left alone');
  assert.equal(fake2.stopped, 1, 'and its transport observer still stopped');
});

test('SessionLogObservers: end-to-end, the analyzer sees exactly the source tags', async () => {
  // The full chain the Log Analyzer depends on: real createLogger (with the
  // real withTag composition) → formatLogLine → AnalyzerSink's parseLine.
  // A regression in ANY of those (e.g. childing the observers off a tagged
  // logger, which composes to 'ext:DittoManager:transport') leaves the
  // source tabs permanently at zero while events look fine in the Logs tab
  // — exactly the field report this test guards.
  const ch = {
    api: {
      get logLevel() { return 3; }, // vscode.LogLevel.Info
      onDidChangeLogLevel() { return { dispose() {} }; },
      error() {}, warn() {}, info() {}, debug() {}, trace() {},
      show() {}, dispose() {},
    },
  };
  const captured: string[] = [];
  const sink: Sink = { write: (_level, line) => { captured.push(line); } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-sesslog-'));
  const logger = createLogger({ channel: ch.api as never, fileDir: dir, extraSinks: [sink] });
  try {
    const fake = fakeDitto();
    installSessionLogObservers(fake.ditto, logger);
    fake.transportCb?.('MDNSFailure', 'MDNS');
    const handler = fake.handler as (r: ConnectionRequest) => Promise<'allow'>;
    await handler(fakeRequest());

    const parsed = captured.map((line, i) => parseLine(line, i));
    assert.deepEqual(
      parsed.map(l => l.tag),
      [TRANSPORT_CONDITIONS_TAG, CONNECTION_REQUESTS_TAG],
      'tags must be the bare source tags — logTagForSource matches them exactly',
    );
    assert.equal(parsed[0]?.text, 'Transport: MDNS → MDNSFailure');
    assert.match(parsed[1]?.text ?? '', /^Connection Request \| type=Bluetooth \| key=pkRemote123/);
    // And the source mapping the analyzer applies:
    assert.equal(logTagForSource('transport'), parsed[0]?.tag);
    assert.equal(logTagForSource('connectionRequests'), parsed[1]?.tag);
    assert.equal(logTagForSource('all'), null);
  } finally {
    await logger.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
