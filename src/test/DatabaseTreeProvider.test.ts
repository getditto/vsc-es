import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../storage/ConfigStore.js';
import { DatabaseTreeProvider } from '../tree/DatabaseTreeProvider.js';
import { newConfig } from '../models/DittoConfig.js';
import { SubscriptionStore } from '../storage/SubscriptionStore.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeStore(): ConfigStore { return new ConfigStore(new FakeMemento() as any); }
function emptySubs(): SubscriptionStore { return new SubscriptionStore(new FakeMemento() as any); }

test('getRootChildren returns [] when no configs', async () => {
  const cfg = makeStore();
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs());
  assert.deepEqual(await provider.getRootChildren(), []);
});

test('getRootChildren returns one database node per stored config (idle by default)', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs());
  const roots = await provider.getRootChildren();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].kind, 'database');
  assert.equal(roots[0].kind === 'database' && roots[0].status, 'idle');
  assert.equal(roots[1].kind === 'database' && roots[1].config.name, 'B');
});

test('idle database has no children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs());
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children, []);
});

test('active database has a single databaseDetails wrapper child', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', emptySubs());
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children.map(c => c.kind), ['databaseDetails']);
});

test('databaseDetails expands to subs/collections/section/peers/query', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', emptySubs());
  const [root] = await provider.getRootChildren();
  const [details] = await provider.getNodeChildren(root);
  const grandchildren = await provider.getNodeChildren(details);
  assert.deepEqual(grandchildren.map(c => c.kind), [
    'subscriptionsParent',
    'collectionsParent',
    'sectionHeader',       // blank divider before the feature shortcuts
    'peerListing',
    'queryEditor',
  ]);
});

test('Subscriptions parent expands to leaves from SubscriptionStore', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const subs = new SubscriptionStore(new FakeMemento() as any);
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', subs);
  const [root] = await provider.getRootChildren();
  const [details] = await provider.getNodeChildren(root);
  const dbChildren = await provider.getNodeChildren(details);
  const subsParent = dbChildren.find(n => n.kind === 'subscriptionsParent')!;
  const leaves = await provider.getNodeChildren(subsParent);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].kind, 'subscription');
  assert.equal(leaves[0].kind === 'subscription' && leaves[0].sub.name, 'tasks-all');
});

test('Subscription expands to a single subscriptionQuery leaf carrying the full DQL', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const subs = new SubscriptionStore(new FakeMemento() as any);
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks WHERE done = false' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', subs);
  const [root] = await provider.getRootChildren();
  const [details] = await provider.getNodeChildren(root);
  const dbChildren = await provider.getNodeChildren(details);
  const subsParent = dbChildren.find(n => n.kind === 'subscriptionsParent')!;
  const [sub] = await provider.getNodeChildren(subsParent);
  const queryLeaves = await provider.getNodeChildren(sub);
  assert.equal(queryLeaves.length, 1);
  assert.equal(queryLeaves[0].kind, 'subscriptionQuery');
  assert.equal(
    queryLeaves[0].kind === 'subscriptionQuery' && queryLeaves[0].sub.query,
    'SELECT * FROM tasks WHERE done = false',
  );
});
