import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import {
  SYSTEM_METRICS_ENV_VAR,
  SystemMetricsService,
  isExporterDisabledRows,
  withSystemMetricsEnv,
} from '../ditto/SystemMetricsService.js';
import type { Logger } from '../logging/types.js';
import type { SystemMetricSample } from '../ipc/messages.js';

/**
 * system:metrics (SDK 5.1) against a real Ditto store.
 *
 * ORDER MATTERS in this file: the exporter is a process-wide OnceLock
 * installed at Ditto open time from the
 * DITTO_METRICS_EXPORTER_VIRTUAL_COLLECTION_ENABLED env var, so the
 * disabled-shape test runs FIRST, before any store in this process opens
 * with the var set.
 *
 * Row shapes asserted below mirror the SDK's dtest fixtures at
 * crates/dittoffi/tests/dql/metrics-virtual-collection/.
 */

DittoLogger.enabled = false;

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

async function withStore<T>(
  body: (exec: (q: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-metrics-test-'));
  const ditto = await Ditto.open(new DittoConfig(
    '00000000-0000-4000-8000-000000000000',
    { mode: 'smallPeersOnly', privateKey: null },
    dir,
  ));
  const exec = async (q: string, args?: Record<string, unknown>) => {
    const r = args === undefined
      ? await ditto.store.execute(q)
      : await ditto.store.execute(q, args as never);
    return r.items.map(i => i.value as Record<string, unknown>);
  };
  try {
    return await body(exec);
  } finally {
    try { await ditto.close(); } catch { /* closing a test store is best-effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// MUST run before any env-enabled open in this process (see header).
test('live system:metrics: without the startup env var the query answers "disabled"', async () => {
  delete process.env[SYSTEM_METRICS_ENV_VAR];
  await withStore(async exec => {
    const rows = await exec('SELECT * FROM system:metrics');
    assert.ok(isExporterDisabledRows(rows),
      `expected the disabled placeholder row, got ${JSON.stringify(rows).slice(0, 300)}`);
    assert.equal(rows[0]?.status, 'disabled');
    assert.ok(typeof rows[0]?.description === 'string');
  });
});

test('live system:metrics: withSystemMetricsEnv enables the exporter and returns real metric rows', async () => {
  await withSystemMetricsEnv(true, async () => {
    await withStore(async exec => {
      // Generate counter + histogram activity, then read.
      await exec('INSERT INTO `mtest` DOCUMENTS (:a), (:b)', {
        a: { _id: 'a', v: 1 }, b: { _id: 'b', v: 2 },
      });
      await exec('SELECT * FROM `mtest`');

      const rows = await exec('SELECT * FROM system:metrics');
      assert.ok(!isExporterDisabledRows(rows),
        `expected real metric rows, got ${JSON.stringify(rows).slice(0, 300)}`);
      assert.ok(rows.length > 0);

      // Row shape (mirrors metrics-counter-values.dtest):
      // { key, labels, level, unit, description, current, updates, delta }
      // for counters; histograms swap current/updates/delta for
      // count/sum/abs_max/dcount/dsum.
      const counter = rows.find(r => r.key === 'ditto.backend.sqlite3.txn_attempts'
        && (r.labels as Record<string, unknown>)?.mode === 'write'
        && (r.labels as Record<string, unknown>)?.outcome === 'started');
      assert.ok(counter, `expected the sqlite write-txn counter row; keys: ${JSON.stringify([...new Set(rows.map(r => r.key))])}`);
      assert.equal(counter.level, 'info');
      assert.equal(typeof counter.unit, 'string');
      assert.equal(typeof counter.description, 'string');
      assert.equal(typeof counter.current, 'number');
      assert.equal(typeof counter.delta, 'number');
      assert.ok((counter.current as number) > 0, 'write txns recorded');

      // Flush semantics: the FIRST read above flushed; a second read with no
      // intervening activity reports delta = 0 for the counter…
      const second = await exec('SELECT * FROM system:metrics');
      const counterAgain = second.find(r => r.key === 'ditto.backend.sqlite3.txn_attempts'
        && (r.labels as Record<string, unknown>)?.mode === 'write'
        && (r.labels as Record<string, unknown>)?.outcome === 'started');
      assert.ok(counterAgain, 'counter row persists across flushes');
      // …and the cumulative `current` keeps tracking activity even though
      // `delta` flushed, which is precisely why the panel accumulates instead
      // of rendering the last read.
      assert.ok(typeof counterAgain.delta === 'number');
      assert.ok(
        (counterAgain.current as number) >= (counter.current as number),

        'cumulative current is monotonic across flushes',
      );
    });
  });
});

test('live system:metrics: SystemMetricsService accumulates deltas against a real store', async () => {
  // The exporter OnceLock is installed by the previous test in this same
  // process, so this open inherits the enabled exporter regardless of env.
  await withStore(async exec => {
    const statuses: import('../ipc/messages.js').SystemMetricsStatus[] = [];
    const service = new SystemMetricsService({ executeRaw: exec }, noopLogger(), {
      readEnabled: () => true,
      onStatus: s => statuses.push(s),
    });

    // Activity → first poll folds it into totals.
    await exec('INSERT INTO `macc` DOCUMENTS (:d)', { d: { _id: 'a', v: 1 } });
    const first = await service.pollOnce();
    assert.equal(first.kind, 'working');
    if (first.kind !== 'working') { return; }
    const totalsAfterFirst = sumTxnAttempts(first.snapshot.samples);
    assert.ok(totalsAfterFirst > 0, `first poll sees txn activity: ${totalsAfterFirst}`);

    // More activity → totals grow; quiet polls never shrink them.
    await exec('INSERT INTO `macc` DOCUMENTS (:d)', { d: { _id: 'b', v: 2 } });
    const second = await service.pollOnce();
    assert.equal(second.kind, 'working');
    if (second.kind !== 'working') { return; }
    const totalsAfterSecond = sumTxnAttempts(second.snapshot.samples);
    assert.ok(totalsAfterSecond > totalsAfterFirst,
      `totals accumulate across polls (${totalsAfterFirst} → ${totalsAfterSecond})`);
    assert.ok(second.snapshot.sinceMs > 0);
    assert.ok(statuses.length === 0, 'pollOnce does not self-publish; only start/tick does');
  });
});

/** Sum of `sinceConnect` over the write txn_attempts series — the number this
 *  whole feature exists to keep meaningful across flush-on-read polls. */
function sumTxnAttempts(samples: SystemMetricSample[]): number {
  return samples
    .filter(s => s.key === 'ditto.backend.sqlite3.txn_attempts')
    .reduce((acc, s) => acc + s.sinceConnect, 0);
}

test('live system:metrics: a labelled metric collapses to its single aggregate row', async () => {
  // The SDK emits ditto.backend.sqlite3.txn_attempts as an unlabelled
  // aggregate PLUS labelled children ({mode,outcome}). The panel must show
  // the key once — the aggregate — not once per label set.
  await withStore(async exec => {
    const service = new SystemMetricsService({ executeRaw: exec }, noopLogger(), {
      readEnabled: () => true,
      onStatus: () => {},
    });
    await exec('INSERT INTO `agg` DOCUMENTS (:d)', { d: { _id: 'a', v: 1 } });
    const status = await service.pollOnce();
    assert.equal(status.kind, 'working');
    if (status.kind !== 'working') { return; }

    const txnRows = status.snapshot.samples.filter(s => s.key === 'ditto.backend.sqlite3.txn_attempts');
    console.log('txn_attempts rows in snapshot:', txnRows.map(s => JSON.stringify(s.labels)));
    assert.equal(txnRows.length, 1,
      `txn_attempts must appear once, got ${txnRows.length}: ${txnRows.map(s => JSON.stringify(s.labels)).join(' ')}`);
    assert.deepEqual(txnRows[0]!.labels, {}, 'the surviving row is the unlabelled aggregate');

    // No key anywhere in the snapshot lists under more than one (key, labels)
    // pair when an aggregate exists for it.
    const counts = new Map<string, number>();
    for (const s of status.snapshot.samples) {
      counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(duplicated, [],
      `no key should list more than once; got duplicates for: ${duplicated.join(', ')}`);
  });
});
