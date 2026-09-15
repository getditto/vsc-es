import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DebugSocketClient } from '../ditto/DebugSocketClient.js';
import { SystemMetricsService } from '../ditto/SystemMetricsService.js';
import { ObserverPanel } from '../panels/ObserverPanel.js';
import { LogAnalyzerService } from '../logAnalyzer/LogAnalyzerService.js';
import { AnalyzerSink } from '../logAnalyzer/AnalyzerSink.js';
import { PatternEngine } from '../logAnalyzer/PatternEngine.js';
import { ConnectionTracker } from '../logAnalyzer/ConnectionTracker.js';
import type { Logger } from '../logging/types.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { StoredObserver } from '../models/StoredObserver.js';

/**
 * MEMORY-LEAK / LIFECYCLE-LEAK VALIDATION for the extension host.
 *
 * The structural layer (every panel disposes its webview listeners, is
 * stop-the-world idempotent, and resets its singleton) lives in
 * panel-lifecycle-contract.test.ts. This file adds the three layers that
 * suite cannot express:
 *
 *   1. TIMER ACCOUNTING — patch the global timer functions per test and
 *      assert that construct→use→dispose leaves ZERO outstanding handles.
 *      A leaked setInterval/setTimeout is the classic extension-host leak:
 *      it pins its closure (and everything that closure captured) forever
 *      and re-fires against dead objects.
 *
 *   2. GC PROOFS — WeakRef assertions that teardown actually releases the
 *      object. This is the strongest claim: not "the right dispose calls
 *      happened", but "the engine collected the instance". Requires
 *      --expose-gc (wired into npm test); skips cleanly without it.
 *
 *   3. HEAP-GROWTH FLATTENING — repeat a realistic cycle hundreds of
 *      times and assert the post-warmup heap does not grow. Catches
 *      accumulation leaks that (1) and (2) miss because the container is
 *      technically reachable (growing Map, FIFO without a cap).
 *
 * If a future change leaks, one of these layers should fail — fix the
 * leak, never loosen the assertion.
 */

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

// ─── Timer accounting harness ─────────────────────────────────

interface TimerTracker {
  outstanding(): number;
  restore(): void;
}

/** Replace the global timer functions with tracking versions. Scope is
 *  this file's process (node:test isolates files), and every test
 *  restores via t.after. A handle leaves the live set when it fires
 *  (timeouts) or when cleared (both kinds). */
function trackTimers(): TimerTracker {
  const live = new Set<NodeJS.Timeout>();
  const origTimeout = globalThis.setTimeout;
  const origInterval = globalThis.setInterval;
  const origClearTimeout = globalThis.clearTimeout;
  const origClearInterval = globalThis.clearInterval;

  globalThis.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    let handle: NodeJS.Timeout;
    const wrapped = (...a: unknown[]) => { live.delete(handle); cb(...a); };
    handle = origTimeout(wrapped, ms, ...args);
    live.add(handle);
    return handle;
  }) as unknown as typeof setTimeout;

  globalThis.setInterval = ((cb: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = origInterval(cb, ms, ...args);
    live.add(handle);
    return handle;
  }) as unknown as typeof setInterval;

  globalThis.clearTimeout = ((h?: NodeJS.Timeout) => { if (h) { live.delete(h); } origClearTimeout(h); }) as typeof clearTimeout;
  globalThis.clearInterval = ((h?: NodeJS.Timeout) => { if (h) { live.delete(h); } origClearInterval(h); }) as typeof clearInterval;

  return {
    outstanding: () => live.size,
    restore() {
      globalThis.setTimeout = origTimeout;
      globalThis.setInterval = origInterval;
      globalThis.clearTimeout = origClearTimeout;
      globalThis.clearInterval = origClearInterval;
    },
  };
}

/** Wait until every tracked handle has fired/been cleared, or fail. */
async function waitForTimerDrain(tracker: TimerTracker, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (tracker.outstanding() > 0) {
    if (Date.now() > deadline) {
      throw new Error(`${tracker.outstanding()} timer(s) still outstanding after teardown`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// ─── Fakes for ObserverPanel (same shape as ObserverPanel.test.ts) ──

const stub = vscode as unknown as {
  createdWebviewPanels: unknown[];
  __resetStub(): void;
};

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('/ext'),
    globalStorageUri: vscode.Uri.file('/global'),
    subscriptions: [],
    globalState: {
      keys: () => [...store.keys()],
      get: <T,>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

const OBSERVER: StoredObserver = { id: 'obs-leak', name: 'leak-watch', query: 'SELECT * FROM things' };

function fakeManager(): DittoManager {
  return {
    getActiveConfigId: () => 'db-leak',
    registerObserver: () => ({ cancel: () => {} }),
  } as unknown as DittoManager;
}

function fakeInspector(): InspectorController {
  return {
    setActiveFeature: () => {},
    setSelectedRowJson: () => {},
  } as unknown as InspectorController;
}

// ─── Fake debug-socket server (real in-process net server) ────

interface FakeServer { socketPath: string; close(): Promise<void> }

async function startEchoServer(t: test.TestContext): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-leak-test-'));
  const socketPath = path.join(dir, 't.sock');
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
        socket.write('[]\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  const handle: FakeServer = {
    socketPath,
    async close() {
      for (const c of connections) { c.destroy(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  t.after(() => handle.close());
  return handle;
}

// ─── LogAnalyzerService plumbing ──────────────────────────────

function makeAnalyzer(opts: { throttleMs?: number } = {}) {
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({
    listAll: () => ({
      bundled: [{ key: 'deadlock_critical', pattern: 'deadlock', severity: 5, recommendation: 'fix' }],
      user: [],
    }),
  });
  engine.load();
  const svc = new LogAnalyzerService({
    sink, engine, tracker: new ConnectionTracker(),
    ...(opts.throttleMs !== undefined ? { throttleMs: opts.throttleMs } : {}),
  });
  return { svc, sink };
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { ObserverPanel.disposeAll(); stub.__resetStub(); });

// ═══════════════════════════════════════════════════════════════
// LAYER 1 — timer accounting
// ═══════════════════════════════════════════════════════════════

test('SystemMetricsService: start→stop leaves zero outstanding timers', async (t) => {
  const tracker = trackTimers();
  t.after(() => tracker.restore());

  const svc = new SystemMetricsService(
    { executeRaw: async () => [] },
    noopLogger(),
    { intervalMs: 60_000, readEnabled: () => true, onStatus: () => {} },
  );
  svc.start();
  assert.equal(tracker.outstanding(), 1, 'the poll interval is tracked while running');
  svc.stop();
  await waitForTimerDrain(tracker);
  // Double stop must not resurrect anything (idempotent teardown).
  svc.stop();
  assert.equal(tracker.outstanding(), 0);
});

test('ObserverPanel: construction-init + event-flush timers all drain on dispose', async (t) => {
  const tracker = trackTimers();
  t.after(() => tracker.restore());

  ObserverPanel.show(fakeContext(), fakeManager(), 'db-leak', OBSERVER, fakeInspector(), noopLogger());

  // Let the 50ms deferred-init timer fire and clear itself.
  await waitForTimerDrain(tracker);

  // Dispose must cancel any pending coalesce window (none armed here, but
  // the drain assertion guards the stop()→cancelFlush() path regardless).
  ObserverPanel.disposeAll();
  await waitForTimerDrain(tracker);
  assert.equal(tracker.outstanding(), 0);
});

test('LogAnalyzerService: a throttled trailing flush is cancelled by dispose', async (t) => {
  const tracker = trackTimers();
  t.after(() => tracker.restore());

  const { svc, sink } = makeAnalyzer({ throttleMs: 60_000 });
  svc.start(); // forceFlush on start — no timer yet
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock in transaction');

  assert.equal(tracker.outstanding(), 1, 'the trailing-edge flush timer is pending');
  svc.dispose();
  await waitForTimerDrain(tracker);
  assert.equal(tracker.outstanding(), 0, 'dispose cancelled the trailing flush');
});

// ═══════════════════════════════════════════════════════════════
// LAYER 2 — GC proofs (WeakRef), require --expose-gc
// ═══════════════════════════════════════════════════════════════

const gc = (globalThis as { gc?: () => void }).gc;
const needsGc = { skip: typeof gc !== 'function' };
const needsUnixSocketAndGc = { skip: process.platform === 'win32' || needsGc.skip };

/** Interleave gc() with macrotask turns so finalizers and destructed
 *  handles release their closures before we measure. */
async function collectGarbage(): Promise<void> {
  await new Promise(r => setImmediate(r));
  gc!(); gc!();
  await new Promise(r => setImmediate(r));
  gc!();
}

test('GC: a disconnected DebugSocketClient is collected (socket, decoder, queue, pending closures)', needsUnixSocketAndGc, async (t) => {
  const srv = await startEchoServer(t);
  // Helper-function scope: everything but the WeakRef is dropped when it
  // returns (a same-function binding would be retained by V8 past the block).
  const ref = await useSocketClient(srv.socketPath);
  await collectGarbage();
  assert.equal(ref.deref(), undefined,
    'client survived disconnect — a listener, timer, or socket handler is still holding it');
});

async function useSocketClient(socketPath: string): Promise<WeakRef<DebugSocketClient>> {
  const client = new DebugSocketClient(noopLogger());
  const ref = new WeakRef(client);
  await client.connect(socketPath);
  assert.deepEqual(await client.query('SELECT 1'), { ok: true, items: [] });
  client.disconnect();
  return ref;
}

test('GC: a disposed ObserverPanel is collected (not pinned by its registry, timers, or stub listeners)', needsGc, async () => {
  const ref = showAndDisposeObserverPanel();
  // The 50ms deferred-init closure retains the panel until it fires.
  await new Promise(r => setTimeout(r, 150));
  stub.__resetStub(); // release createdWebviewPanels (the test stub's retain list)
  await collectGarbage();
  assert.equal(ref.deref(), undefined,
    'panel survived disposeAll — the _open registry, a flush timer, or a webview listener still holds it');
});

function showAndDisposeObserverPanel(): WeakRef<ObserverPanel> {
  const panel = ObserverPanel.show(fakeContext(), fakeManager(), 'db-leak', OBSERVER, fakeInspector(), noopLogger());
  const ref = new WeakRef(panel);
  ObserverPanel.disposeAll();
  return ref;
}

test('GC: a disposed LogAnalyzerService is collected after unsubscribing from the sink', needsGc, async () => {
  const ref = useAnalyzer();
  await collectGarbage();
  assert.equal(ref.deref(), undefined,
    'service survived dispose — the sink subscription or a flush timer still holds it');
});

function useAnalyzer(): WeakRef<LogAnalyzerService> {
  // throttleMs: 0 — no trailing-edge flush timer is in flight at dispose
  // time (dispose clears it anyway, but a pending one retains the service
  // until it fires, which would defeat what we're measuring).
  const { svc, sink } = makeAnalyzer({ throttleMs: 0 });
  const ref = new WeakRef(svc);
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock in transaction');
  svc.dispose();
  return ref;
}

test('GC harness self-check: an object still referenced is NOT reported collected', needsGc, async () => {
  // Negative control: a collection assertion that always passes would be
  // worse than no test. Prove the layers above can see a real leak.
  const leakingRegistry = new Set<object>();
  // Confined to a helper so the test function holds no strong binding.
  const ref = leakThenWatch(leakingRegistry);
  await collectGarbage();
  assert.notEqual(ref.deref(), undefined, 'a retained object must surface as retained');
  leakingRegistry.clear();
  await collectGarbage();
  assert.equal(ref.deref(), undefined, 'and collection reported only after the release');
});

function leakThenWatch(registry: Set<object>): WeakRef<object> {
  const retentionRoot = { pinned: true };
  registry.add(retentionRoot);
  return new WeakRef(retentionRoot);
}

// ═══════════════════════════════════════════════════════════════
// LAYER 3 — heap-growth flattening, requires --expose-gc
// ═══════════════════════════════════════════════════════════════

test('HEAP: 400 debug-socket connect/query/disconnect cycles leave a flat heap', needsUnixSocketAndGc, async (t) => {
  const srv = await startEchoServer(t);
  const WARMUP = 50;
  const CYCLES = 400;

  const cycle = async (): Promise<void> => {
    const client = new DebugSocketClient(noopLogger());
    await client.connect(srv.socketPath);
    await client.query('SELECT 1');
    client.disconnect();
  };

  for (let i = 0; i < WARMUP; i++) { await cycle(); }
  gc!();
  const baseline = process.memoryUsage().heapUsed;

  for (let i = 0; i < CYCLES - WARMUP; i++) {
    if (i % 50 === 0) { gc!(); }
    await cycle();
  }
  gc!(); gc!();

  const growth = process.memoryUsage().heapUsed - baseline;
  const LIMIT = 4 * 1024 * 1024;
  assert.ok(
    growth < LIMIT,
    `heap grew ${(growth / 1024 / 1024).toFixed(2)} MiB over ${CYCLES - WARMUP} cycles — check for ` +
    'retained sockets/decoders/pending entries per session',
  );
});
