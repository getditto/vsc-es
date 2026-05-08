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
  const store = new ConfigStore(new FakeMemento() as any);
  assert.deepEqual(store.list(), []);
});

test('save() then list() round-trips a config', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig({ name: 'A', databaseId: 'db-A' });
  await store.save(cfg);
  assert.deepEqual(store.list(), [cfg]);
});

test('save() updates an existing config by id', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig({ name: 'A' });
  await store.save(cfg);
  await store.save({ ...cfg, name: 'A renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].name, 'A renamed');
});

test('get(id) returns the matching config or undefined', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig();
  await store.save(cfg);
  assert.deepEqual(store.get(cfg.id), cfg);
  assert.equal(store.get('nope'), undefined);
});

test('delete(id) removes the config', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig();
  await store.save(cfg);
  await store.delete(cfg.id);
  assert.deepEqual(store.list(), []);
});

test('listeners fire on save and delete', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const events: string[] = [];
  store.onDidChange(() => events.push('change'));
  await store.save(makeConfig());
  await store.delete(store.list()[0].id);
  assert.deepEqual(events, ['change', 'change']);
});
