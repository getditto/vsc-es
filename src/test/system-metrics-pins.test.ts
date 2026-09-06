import test from 'node:test';
import assert from 'node:assert/strict';
import { readPins, writePins } from '../storage/system-metrics-pins.js';
import type { MementoLike } from '../storage/MetricsPreferencesStore.js';

/**
 * system-metrics pinned-series persistence: per-database keys, wholesale
 * replacement writes, clearing on empty, and tolerance for malformed
 * stored entries.
 */

function memento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string) => store.get(key) as T,
    update: (key: string, value: unknown) => {
      if (value === undefined) { store.delete(key); } else { store.set(key, value); }
      return Promise.resolve();
    },
  };
}

test('pins: round-trips a list and isolates databases from each other', async () => {
  const m = memento();
  await writePins(m, 'db-1', [
    { key: 'ditto.network.dsoq.connection.opened', labels: {} },
    { key: 'ditto.backend.sqlite3.fsync_total', labels: { db: 'main' } },
  ]);
  await writePins(m, 'db-2', [{ key: 'ditto.replication.session_resets', labels: {} }]);

  assert.deepEqual(readPins(m, 'db-1'), [
    { key: 'ditto.network.dsoq.connection.opened', labels: {} },
    { key: 'ditto.backend.sqlite3.fsync_total', labels: { db: 'main' } },
  ], 'pin order is preserved');
  assert.deepEqual(readPins(m, 'db-2'), [
    { key: 'ditto.replication.session_resets', labels: {} },
  ]);
  assert.deepEqual(readPins(m, 'db-3'), [], 'unknown database reads as empty');
});

test('pins: writing an empty list clears the stored key entirely', async () => {
  const m = memento();
  await writePins(m, 'db-1', [{ key: 'a', labels: {} }]);
  assert.ok([...m.store.keys()].some(k => k.includes('db-1')), 'stored after pinning');
  await writePins(m, 'db-1', []);
  assert.ok(![...m.store.keys()].some(k => k.includes('db-1')), 'no residue after clearing');
  assert.deepEqual(readPins(m, 'db-1'), []);
});

test('pins: malformed stored entries are dropped, not fatal', async () => {
  const m = memento();
  m.store.set('dittoSystemMetricsPins.v1.db-1', [
    { key: 'good', labels: { db: 'main', bogus: 42 } },
    { labels: {} },                 // no key
    { key: '', labels: {} },        // empty key
    'not-an-object',
    null,
    { key: 'labelless' },           // labels missing
    { key: 'odd', labels: ['nope'] }, // labels not a record
  ]);
  assert.deepEqual(readPins(m, 'db-1'), [
    { key: 'good', labels: { db: 'main' } },
    { key: 'labelless', labels: {} },
    { key: 'odd', labels: {} },
  ], 'keeps valid entries, sanitises labels to string maps');
});

test('pins: a non-array stored value reads as empty', () => {
  const m = memento();
  m.store.set('dittoSystemMetricsPins.v1.db-1', '{"key":"nope"}');
  assert.deepEqual(readPins(m, 'db-1'), []);
});

test('pins: the same series can never be stored twice', async () => {
  const m = memento();
  const a = { key: 'ditto.network.dsoq.connection.opened', labels: {} };
  const b = { key: 'ditto.backend.sqlite3.fsync_total', labels: { db: 'main' } };

  // A writer that bypasses the guard (or legacy/hand-edited storage).
  m.store.set('dittoSystemMetricsPins.v1.db-1', [a, b, a]);
  assert.deepEqual(readPins(m, 'db-1'), [a, b], 'read drops the duplicate, first occurrence wins');

  // The write path itself enforces the invariant.
  await writePins(m, 'db-2', [a, a, b, b]);
  assert.deepEqual(m.store.get('dittoSystemMetricsPins.v1.db-2'), [a, b],
    'write dedupes before persisting');

  // Label maps participate in identity: same key, different label sets
  // are distinct series and both survive.
  const wifi = { key: 'k', labels: { transport: 'wifi' } };
  const ble = { key: 'k', labels: { transport: 'ble' } };
  await writePins(m, 'db-3', [wifi, ble, wifi]);
  assert.deepEqual(m.store.get('dittoSystemMetricsPins.v1.db-3'), [wifi, ble]);
});
