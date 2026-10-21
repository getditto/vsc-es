import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_METRICS_ENV_VAR,
  SystemMetricsService,
  accumulateMetricRows,
  isExporterDisabledRows,
  readCollectSystemMetrics,
  withSystemMetricsEnv,
} from '../ditto/SystemMetricsService.js';
import type { SystemMetricsStatus } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { SystemMetricSample } from '../ipc/messages.js';

/**
 * system:metrics service, pure unit level. Deltas flush on every read in
 * the real SDK, so the assertions focus on the accumulation contract; the
 * end-to-end flush behaviour against a live store is in
 * system-metrics-live.test.ts.
 */

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

function counterRow(key: string, delta: number, labels: Record<string, string> = {}): Record<string, unknown> {
  return { key, labels, level: 'info', unit: 'count', description: `${key} desc`, current: 0, updates: 0, delta };
}

function histogramRow(key: string, dcount: number, dsum: number, labels: Record<string, string> = {}): Record<string, unknown> {
  return { key, labels, level: 'info', unit: 'seconds', description: `${key} desc`, count: 1, sum: 1, abs_max: 5, dcount, dsum, dabs_max: 1 };
}

/** Gauge rows share the counter row shape (`current`/`updates`/`delta`);
 *  what makes them gauges is the KEY matching the SDK's static gauge
 *  declarations — see KNOWN_GAUGE_KEYS in the service. */
function gaugeRow(key: string, current: number, delta: number, labels: Record<string, string> = {}): Record<string, unknown> {
  return { key, labels, level: 'info', unit: 'count', description: `${key} desc`, current, updates: 1, delta };
}

function makeService(opts: {
  rows?: () => Promise<Record<string, unknown>[]> | never;
  readEnabled?: () => boolean;
  isExpectedActive?: () => boolean;
  intervalMs?: number;
}) {
  const statuses: SystemMetricsStatus[] = [];
  const store = {
    calls: 0,
    executeRaw: async (query: string) => {
      store.calls += 1;
      assert.equal(query, 'SELECT * FROM system:metrics');
      if (!opts.rows) { return []; }
      return await opts.rows();
    },
  };
  const service = new SystemMetricsService(store, noopLogger(), {
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.readEnabled ? { readEnabled: opts.readEnabled } : {}),
    ...(opts.isExpectedActive ? { isExpectedActive: opts.isExpectedActive } : {}),
    onStatus: s => statuses.push(s),
  });
  return { store, service, statuses };
}

// ─── accumulation ──────────────────────────────────────────────

test('accumulateMetricRows folds counter deltas into a running total and keeps the last period', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [counterRow('ditto.network.dsoq.connection.opened', 3)]);
  accumulateMetricRows(samples, [counterRow('ditto.network.dsoq.connection.opened', 2)]);
  const s = [...samples.values()];
  assert.equal(s.length, 1);
  assert.equal(s[0]?.sinceConnect, 5, 'deltas accumulate — reads flush, so last-read rendering would show 2');
  assert.equal(s[0]?.periodDelta, 2);
  assert.equal(s[0]?.kind, 'counter');
});

test('accumulateMetricRows keeps label combinations as separate series', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [
    counterRow('ditto.backend.sqlite3.fsync_total', 4, { db: 'main' }),
    counterRow('ditto.backend.sqlite3.fsync_total', 1, { db: 'replication_metadata' }),
  ]);
  accumulateMetricRows(samples, [counterRow('ditto.backend.sqlite3.fsync_total', 2, { db: 'main' })]);
  const byDb = new Map([...samples.values()].map(s => [s.labels.db, s]));
  assert.equal(byDb.get('main')?.sinceConnect, 6);
  assert.equal(byDb.get('replication_metadata')?.sinceConnect, 1);
  assert.equal(samples.size, 2);
});

test('accumulateMetricRows histograms accumulate dcount/dsum and track the latest abs_max', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [histogramRow('ditto.backend.sqlite3.fsync_duration_secs', 3, 0.012, { db: 'main' })]);
  accumulateMetricRows(samples, [histogramRow('ditto.backend.sqlite3.fsync_duration_secs', 2, 0.008, { db: 'main' })]);
  const s = samples.get('ditto.backend.sqlite3.fsync_duration_secs{db=main}');
  assert.ok(s);
  assert.equal(s.kind, 'histogram');
  assert.equal(s.sinceConnect, 5, 'dcount accumulates');
  assert.equal(s.periodDelta, 2);
  assert.equal(s.sumSinceConnect, 0.02, 'dsum accumulates');
  assert.equal(s.absMax, 5);
});

test('accumulateMetricRows gauges track the absolute current value, never a delta sum', () => {
  const samples = new Map<string, SystemMetricSample>();
  // awdl.interface_up goes 0 → 1 → 1: a delta-accumulating read would
  // show 1 (lucky) then 1 (correct by accident); the sequence below is
  // the discriminating one — 1 → 0 → 1 must read 1, not 2.
  accumulateMetricRows(samples, [gaugeRow('ditto.transport.awdl.interface_up', 1, 1)]);
  accumulateMetricRows(samples, [gaugeRow('ditto.transport.awdl.interface_up', 0, -1)]);
  accumulateMetricRows(samples, [gaugeRow('ditto.transport.awdl.interface_up', 1, 1)]);
  const s = [...samples.values()];
  assert.equal(s.length, 1);
  assert.equal(s[0]?.kind, 'gauge');
  assert.equal(s[0]?.sinceConnect, 1, 'absolute current value, not sum-of-deltas (2)');
  assert.equal(s[0]?.periodDelta, 1);
});

test('accumulateMetricRows gauges keep negative periodDelta (value went down)', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [gaugeRow('ditto.network.connections', 3, 3)]);
  accumulateMetricRows(samples, [gaugeRow('ditto.network.connections', 1, -2)]);
  const s = [...samples.values()][0];
  assert.equal(s?.kind, 'gauge');
  assert.equal(s?.sinceConnect, 1, 'current absolute value');
  assert.equal(s?.periodDelta, -2, 'negative delta preserved for the ▼ indicator');
});

test('accumulateMetricRows gauge prefix families match (quic udp child keys)', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [
    gaugeRow('ditto.network.quic.udp_tx.bytes', 4096, 512, { remote: '10.0.0.2' }),
    gaugeRow('ditto.network.quic.path.rtt', 0.045, 0.005, { remote: '10.0.0.2' }),
    gaugeRow('ditto.multiplexer.phy.last_sent_at', 1761000000, 5, { transport_type: 'awdl' }),
  ]);
  const kinds = [...samples.values()].map(s => s.kind);
  assert.deepEqual(kinds, ['gauge', 'gauge', 'gauge']);
});

test('accumulateMetricRows gauge row missing current keeps the last-known value', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [gaugeRow('ditto.transport.awdl.interface_up', 1, 1)]);
  // Exporter always emits `current`, but if a row ever lacks it the
  // sample must not reset to 0.
  accumulateMetricRows(samples, [{ key: 'ditto.transport.awdl.interface_up', labels: {}, delta: 0 }]);
  const s = [...samples.values()][0];
  assert.equal(s?.sinceConnect, 1);
});

test('accumulateMetricRows first-seen gauge without current starts at 0', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [{ key: 'ditto.network.connections', labels: {}, delta: 2 }]);
  const s = [...samples.values()][0];
  assert.equal(s?.kind, 'gauge');
  assert.equal(s?.sinceConnect, 0, 'no current to track — do not fall back to delta');
});

test('accumulateMetricRows does not misclassify lookalike counter keys as gauges', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [
    // New 5.2 counters whose prefixes sit near gauge families.
    counterRow('ditto.network.peers.discovered_count', 7),
    counterRow('ditto.network.dsoq.connection.opened', 3),
    // A key that merely STARTS WITH a gauge key (not a prefix entry).
    counterRow('ditto.network.connections.total', 9),
    // Prefix entries end with '.' so 'ditto.network.quic.udp_tx' itself
    // (no trailing segment) is not a match.
    counterRow('ditto.network.quic.udp_tx', 4),
  ]);
  const kinds = [...samples.values()].map(s => s.kind);
  assert.deepEqual(kinds, ['counter', 'counter', 'counter', 'counter']);
});

test('accumulateMetricRows skips placeholder rows that carry no key', () => {
  const samples = new Map<string, SystemMetricSample>();
  accumulateMetricRows(samples, [{ status: 'disabled', description: 'set the system parameter…' }]);
  accumulateMetricRows(samples, [{ labels: { db: 'main' } }]);
  assert.equal(samples.size, 0);
});

test('isExporterDisabledRows recognises the disabled placeholder and nothing else', () => {
  assert.equal(isExporterDisabledRows([{ status: 'disabled', description: 'x' }]), true);
  assert.equal(isExporterDisabledRows([]), false);
  assert.equal(isExporterDisabledRows([counterRow('a', 1)]), false);
  assert.equal(isExporterDisabledRows([{ status: 'disabled' }, counterRow('a', 1)]), false);
});

// ─── pollOnce status mapping ───────────────────────────────────

test('pollOnce reports settingDisabled without touching the store', async () => {
  const { store, service } = makeService({ readEnabled: () => false });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'settingDisabled');
  assert.equal(store.calls, 0);
});

test('pollOnce translates "No active database" into noConnection', async () => {
  const { service } = makeService({ rows: () => { throw new Error('No active database.'); } });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'noConnection');
});

test('pollOnce translates arbitrary query failures into unavailable', async () => {
  const { service } = makeService({ rows: () => { throw new Error('unknown collection system:metrics'); } });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'unavailable');
  if (status.kind === 'unavailable') { assert.match(status.message, /unknown collection/); }
});

test('pollOnce maps the disabled placeholder row to exporterDisabled', async () => {
  const { service } = makeService({
    rows: async () => [{ status: 'disabled', description: 'enable at startup' }],
  });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'exporterDisabled');
});

test('pollOnce accumulates and returns a working snapshot', async () => {
  let reads = 0;
  const { service } = makeService({
    rows: async () => [counterRow('ditto.network.dsoq.connection.opened', ++reads)],
  });
  const first = await service.pollOnce();
  assert.equal(first.kind, 'working');
  const second = await service.pollOnce();
  if (second.kind !== 'working') { assert.fail('expected working'); }
  const sample = second.snapshot.samples[0];
  assert.equal(sample?.sinceConnect, 3);
  assert.equal(sample?.periodDelta, 2);
  assert.ok(second.snapshot.sinceMs <= second.snapshot.polledAtMs);
});

// ─── mid-switch guard ──────────────────────────────────────────

test('pollOnce refuses to query when this panel\'s connection is not active', async () => {
  const { store, service } = makeService({ isExpectedActive: () => false });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'noConnection');
  assert.equal(store.calls, 0);
});

test('pollOnce discards rows when the connection switched mid-read', async () => {
  let active = true;
  const { service } = makeService({
    rows: async () => {
      active = false; // the switch lands while the query is in flight
      return [counterRow('ditto.network.dsoq.connection.opened', 7)];
    },
    isExpectedActive: () => active,
  });
  const status = await service.pollOnce();
  assert.equal(status.kind, 'noConnection', 'the other database\'s deltas must not pollute this snapshot');
});

// ─── start/stop lifecycle ──────────────────────────────────────

test('start polls immediately, then on the interval; stop ends polling', async () => {
  const { store, service, statuses } = makeService({
    rows: async () => [counterRow('ditto.network.dsoq.connection.opened', 1)],
    intervalMs: 10,
  });
  service.start();
  assert.equal(service.isPolling, true);
  await new Promise(r => setTimeout(r, 55));
  service.stop();
  assert.equal(service.isPolling, false);
  assert.ok(store.calls >= 2, `expected the immediate poll plus interval ticks, got ${store.calls}`);
  assert.ok(statuses.every(s => s.kind === 'working'));
  const callsAtStop = store.calls;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(store.calls, callsAtStop, 'no polls after stop');
});

test('start reports settingDisabled instead of arming the timer', async () => {
  const { store, service, statuses } = makeService({ readEnabled: () => false });
  service.start();
  assert.equal(service.isPolling, false);
  assert.deepEqual(statuses.map(s => s.kind), ['settingDisabled']);
  assert.equal(store.calls, 0);
});

// ─── env var helper ────────────────────────────────────────────

test('withSystemMetricsEnv sets the var for the duration of fn and deletes it after', async () => {
  delete process.env[SYSTEM_METRICS_ENV_VAR];
  let seenDuring: string | undefined;
  await withSystemMetricsEnv(true, async () => {
    seenDuring = process.env[SYSTEM_METRICS_ENV_VAR];
  });
  assert.equal(seenDuring, 'true');
  assert.equal(process.env[SYSTEM_METRICS_ENV_VAR], undefined);
});

test('withSystemMetricsEnv restores a pre-existing value', async () => {
  process.env[SYSTEM_METRICS_ENV_VAR] = 'false';
  try {
    await withSystemMetricsEnv(true, async () => {
      assert.equal(process.env[SYSTEM_METRICS_ENV_VAR], 'true');
    });
    assert.equal(process.env[SYSTEM_METRICS_ENV_VAR], 'false');
  } finally {
    delete process.env[SYSTEM_METRICS_ENV_VAR];
  }
});

test('withSystemMetricsEnv restores on throw', async () => {
  delete process.env[SYSTEM_METRICS_ENV_VAR];
  await assert.rejects(
    withSystemMetricsEnv(true, async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(process.env[SYSTEM_METRICS_ENV_VAR], undefined);
});

test('withSystemMetricsEnv disabled passes through untouched', async () => {
  process.env[SYSTEM_METRICS_ENV_VAR] = 'operator-set';
  try {
    let seen: string | undefined;
    await withSystemMetricsEnv(false, async () => { seen = process.env[SYSTEM_METRICS_ENV_VAR]; });
    assert.equal(seen, 'operator-set', 'a disabled setting must never rewrite an operator-provided value');
  } finally {
    delete process.env[SYSTEM_METRICS_ENV_VAR];
  }
});

test('readCollectSystemMetrics defaults to true under the workspace stub', () => {
  // The vscode stub's getConfiguration returns the default — this pins the
  // deliberate default-on decision for the dev-tool setting.
  assert.equal(readCollectSystemMetrics(), true);
});
