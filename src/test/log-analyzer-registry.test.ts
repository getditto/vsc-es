import test from 'node:test';
import assert from 'node:assert/strict';
import { LogAnalyzerRegistry, type StartableAnalyzer } from '../logAnalyzer/LogAnalyzerRegistry.js';

/**
 * Regression tests for the MCP log-analyzer lifecycle review findings:
 *  - two concurrent opens must single-flight (an orphaned second service
 *    keeps a live sink subscription past disconnect teardown);
 *  - a disconnect landing mid-open must dispose the fresh service rather
 *    than resurrecting an analyzer into the freshly-cleared map.
 */

interface FakeService extends StartableAnalyzer {
  startCalls: { backfillLines?: readonly string[]; minTimestamp?: Date | undefined }[];
  disposeCalls: number;
}

function only(services: FakeService[], i: number): FakeService {
  const s = services[i];
  assert.ok(s, `expected services[${i}] to exist`);
  return s;
}

function makeHarness(opts: {
  backfill?: () => Promise<readonly string[]>;
  timestamp?: Date;
  connected?: boolean;
} = {}) {
  const services: FakeService[] = [];
  const state = { connected: opts.connected ?? true };
  const registry = new LogAnalyzerRegistry<FakeService>(
    () => {
      const service: FakeService = {
        startCalls: [],
        disposeCalls: 0,
        start(p) { this.startCalls.push(p); },
        dispose() { this.disposeCalls += 1; },
      };
      services.push(service);
      return service;
    },
    opts.backfill ?? (() => Promise.resolve(['line-1', 'line-2'])),
    () => opts.timestamp,
    () => state.connected,
  );
  return { registry, services, state };
}

test('concurrent opens single-flight: one service, one start(), both callers share it', async () => {
  const ts = new Date(1_700_000_000_000);
  const { registry, services } = makeHarness({ timestamp: ts });
  const [a, b] = await Promise.all([registry.open('cfg-1'), registry.open('cfg-1')]);
  assert.equal(services.length, 1, 'exactly one service constructed');
  assert.equal(a, b, 'both callers receive the same instance');
  assert.deepEqual(only(services, 0).startCalls, [{ backfillLines: ['line-1', 'line-2'], minTimestamp: ts }]);

  registry.disposeAll();
  // Disposal of resolved entries is queued as microtasks on their promises.
  await new Promise(r => setImmediate(r));
  assert.equal(only(services, 0).disposeCalls, 1, 'teardown disposes the shared service once');
});

test('disconnect mid-open disposes the fresh service and rejects; the next open starts fresh', async () => {
  let releaseBackfill: (lines: readonly string[]) => void = () => undefined;
  const backfillGate = new Promise<readonly string[]>((resolve) => { releaseBackfill = resolve; });
  const { registry, services } = makeHarness({ backfill: () => backfillGate });

  const opening = registry.open('cfg-1');
  // The open is suspended in the backfill read when the disconnect lands.
  registry.disposeAll();
  releaseBackfill(['stale']);

  await assert.rejects(opening, /disconnected while the Log Analyzer was opening/);
  assert.equal(services.length, 1);
  assert.equal(only(services, 0).disposeCalls, 1, 'the orphaned service is disposed, not leaked');
  assert.equal(only(services, 0).startCalls.length, 0, 'never started — no sink subscription was taken');

  // A later open (post-reconnect, new generation) builds a fresh service.
  const reopened = await registry.open('cfg-1');
  assert.equal(services.length, 2, 'reconnect does not reuse the discarded service');
  assert.equal(reopened, only(services, 1));
  registry.disposeAll();
});

test('a failed open does not poison the cache — the next call retries with a fresh service', async () => {
  let attempts = 0;
  const { registry, services } = makeHarness({
    backfill: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('log rotated mid-read')) : Promise.resolve(['ok']);
    },
  });

  await assert.rejects(registry.open('cfg-1'), /log rotated mid-read/);
  assert.equal(only(services, 0).startCalls.length, 0, 'never started on a failed read');

  const service = await registry.open('cfg-1');
  assert.equal(services.length, 2, 'retry constructs a new service instead of serving the rejection');
  assert.equal(service, only(services, 1));
  registry.disposeAll();
});

test('disposeAll with only an in-flight open leaves nothing undisposed and no unhandled rejection', async () => {
  let releaseBackfill: (lines: readonly string[]) => void = () => undefined;
  const backfillGate = new Promise<readonly string[]>((resolve) => { releaseBackfill = resolve; });
  const { registry, services } = makeHarness({ backfill: () => backfillGate });

  const opening = registry.open('cfg-1');
  registry.disposeAll(); // nothing resolved yet — pure in-flight case
  releaseBackfill(['late']);
  await assert.rejects(opening);
  assert.equal(only(services, 0).disposeCalls, 1);
});
