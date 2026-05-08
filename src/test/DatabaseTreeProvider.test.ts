import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../storage/ConfigStore.js';
import { DatabaseTreeProvider } from '../tree/DatabaseTreeProvider.js';
import { newConfig } from '../models/DittoConfig.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeStore(): ConfigStore { return new ConfigStore(new FakeMemento() as any); }

test('getRootChildren returns [] when no configs', async () => {
  const cfg = makeStore();
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  assert.deepEqual(await provider.getRootChildren(), []);
});

test('getRootChildren returns one database node per stored config (idle by default)', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  const roots = await provider.getRootChildren();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].kind, 'database');
  assert.equal(roots[0].kind === 'database' && roots[0].status, 'idle');
  assert.equal(roots[1].kind === 'database' && roots[1].config.name, 'B');
});

test('idle database has no children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children, []);
});

test('active database has Subscriptions parent and Peer Listing as children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active');
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.equal(children.length, 2);
  assert.equal(children[0].kind, 'subscriptionsParent');
  assert.equal(children[1].kind, 'peerListing');
});
