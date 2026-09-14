import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../storage/ConfigStore.js';
import { newConfig, type StoredDittoConfig } from '../models/DittoConfig.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeConfig(overrides: Partial<StoredDittoConfig> = {}): StoredDittoConfig {
  return { ...newConfig(), id: 'id-' + Math.random().toString(36).slice(2), ...overrides };
}

test('list() returns [] when nothing stored', () => {
  const store = new ConfigStore(new FakeMemento());
  assert.deepEqual(store.list(), []);
});

test('save() then list() round-trips a config', async () => {
  const store = new ConfigStore(new FakeMemento());
  const cfg = makeConfig({ name: 'A', databaseId: 'db-A' });
  await store.save(cfg);
  assert.deepEqual(store.list(), [cfg]);
});

test('legacy configs without advancedConfig remain readable', async () => {
  const memento = new FakeMemento();
  const legacy = makeConfig({ name: 'Legacy', databaseId: 'legacy-db' });
  delete legacy.advancedConfig;
  await memento.update('dittoConfigs.v1', [legacy]);
  const store = new ConfigStore(memento);
  assert.deepEqual(store.get(legacy.id), legacy);
  assert.equal(store.get(legacy.id)?.advancedConfig, undefined);
});

test('save() updates an existing config by id', async () => {
  const store = new ConfigStore(new FakeMemento());
  const cfg = makeConfig({ name: 'A' });
  await store.save(cfg);
  await store.save({ ...cfg, name: 'A renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.name, 'A renamed');
});

test('get(id) returns the matching config or undefined', async () => {
  const store = new ConfigStore(new FakeMemento());
  const cfg = makeConfig();
  await store.save(cfg);
  assert.deepEqual(store.get(cfg.id), cfg);
  assert.equal(store.get('nope'), undefined);
});

test('delete(id) removes the config', async () => {
  const store = new ConfigStore(new FakeMemento());
  const cfg = makeConfig();
  await store.save(cfg);
  await store.delete(cfg.id);
  assert.deepEqual(store.list(), []);
});

test('save() rejects a different config with a duplicate databaseId', async () => {
  const store = new ConfigStore(new FakeMemento());
  await store.save(makeConfig({ name: 'A', databaseId: 'shared-db' }));
  const dup = makeConfig({ name: 'B', databaseId: 'shared-db' });
  await assert.rejects(() => store.save(dup), /already exists.*"A"/);
  // The rejected config should not have been persisted.
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.name, 'A');
});

test('save() allows updating the same config with its own databaseId', async () => {
  const store = new ConfigStore(new FakeMemento());
  const cfg = makeConfig({ name: 'A', databaseId: 'shared-db' });
  await store.save(cfg);
  // Re-saving the same record (same id, same databaseId) must not self-conflict.
  await store.save({ ...cfg, name: 'A renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.name, 'A renamed');
});

test('save() treats whitespace-only databaseId differences as duplicates', async () => {
  const store = new ConfigStore(new FakeMemento());
  await store.save(makeConfig({ name: 'A', databaseId: 'db-A' }));
  const dup = makeConfig({ name: 'B', databaseId: '  db-A  ' });
  await assert.rejects(() => store.save(dup), /already exists/);
});

test('listeners fire on save and delete', async () => {
  const store = new ConfigStore(new FakeMemento());
  const events: string[] = [];
  store.onDidChange(() => events.push('change'));
  await store.save(makeConfig());
  await store.delete(store.list()[0]!.id);
  assert.deepEqual(events, ['change', 'change']);
});

/** A memento that behaves like the real one under concurrency: reads get a
 *  fresh copy and writes settle a tick later, so two overlapping
 *  read-modify-write cycles each observe the pre-state unless the store
 *  serializes them. */
class CopyingMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const v = this.map.get(key);
    return v === undefined ? undefined : structuredClone(v) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, structuredClone(value)); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

test('concurrent saves do not lose writes', async () => {
  const store = new ConfigStore(new CopyingMemento());
  const a = makeConfig({ name: 'A', databaseId: 'db-A' });
  const b = makeConfig({ name: 'B', databaseId: 'db-B' });
  await Promise.all([store.save(a), store.save(b)]);
  assert.deepEqual(store.list().map(c => c.name).sort(), ['A', 'B']);
});

test('a failed save does not wedge the write queue', async () => {
  const store = new ConfigStore(new CopyingMemento());
  await store.save(makeConfig({ name: 'A', databaseId: 'shared' }));
  await assert.rejects(() => store.save(makeConfig({ name: 'B', databaseId: 'shared' })), /already exists/);
  await store.save(makeConfig({ name: 'C', databaseId: 'db-C' }));
  assert.deepEqual(store.list().map(c => c.name).sort(), ['A', 'C']);
});

test('a throwing listener does not break save or the remaining listeners', async () => {
  const store = new ConfigStore(new FakeMemento());
  const events: string[] = [];
  store.onDidChange(() => { throw new Error('listener bug'); });
  store.onDidChange(() => events.push('later listener ran'));
  const cfg = makeConfig();
  await store.save(cfg);
  assert.deepEqual(events, ['later listener ran']);
  assert.deepEqual(store.list(), [cfg], 'the write must still land');
});

test('list() degrades to [] on a corrupted non-array blob', async () => {
  const memento = new FakeMemento();
  await memento.update('dittoConfigs.v1', { not: 'an array' });
  const store = new ConfigStore(memento);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('anything'), undefined);
});

test('member-level corruption is filtered instead of throwing out of every caller forever', async () => {
  // Regression: list() only type-checked the top-level blob, so a stored
  // `[null, validConfig]` made get()/save()/delete() throw TypeErrors on
  // every subsequent call — bricking the tree and making the damage
  // unrecoverable from inside the extension.
  const memento = new FakeMemento();
  const good = makeConfig({ name: 'Good', databaseId: 'db-good' });
  await memento.update('dittoConfigs.v1', [null, good, undefined, 42, 'oops', { id: 7 }]);
  const store = new ConfigStore(memento);

  assert.deepEqual(store.list(), [good], 'only the well-formed member survives');
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.get(good.id)?.name, 'Good');

  // save() and delete() work again — and persist the sanitized list.
  const added = makeConfig({ name: 'New', databaseId: 'db-new' });
  await store.save(added);
  assert.deepEqual(store.list(), [good, added]);
  assert.deepEqual(memento.get('dittoConfigs.v1'), [good, added]);
  await store.delete(good.id);
  assert.deepEqual(store.list(), [added]);
});
