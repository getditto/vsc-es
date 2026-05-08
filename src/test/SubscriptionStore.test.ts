import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionStore } from '../storage/SubscriptionStore.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

test('list(dbId) returns [] when nothing stored', () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  assert.deepEqual(s.list('db1'), []);
});

test('save() then list() round-trips a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  assert.deepEqual(s.list('db1'), [{ id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' }]);
});

test('subscriptions are scoped per database', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db2', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db2').length, 1);
  assert.equal(s.list('db1')[0].id, 'sub1');
});

test('save() updates an existing subscription by id', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub1', name: 'a-renamed', query: 'SELECT 1' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db1')[0].name, 'a-renamed');
});

test('delete() removes a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.delete('db1', 'sub1');
  assert.deepEqual(s.list('db1'), []);
});

test('deleteAll(dbId) clears all subscriptions for that DB', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  await s.deleteAll('db1');
  assert.deepEqual(s.list('db1'), []);
});
