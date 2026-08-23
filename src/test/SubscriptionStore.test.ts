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
  const s = new SubscriptionStore(new FakeMemento());
  assert.deepEqual(s.list('db1'), []);
});

test('save() then list() round-trips a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  await s.save('db1', { id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  assert.deepEqual(s.list('db1'), [{ id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' }]);
});

test('subscriptions are scoped per database', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db2', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db2').length, 1);
  assert.equal(s.list('db1')[0].id, 'sub1');
});

test('save() updates an existing subscription by id', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub1', name: 'a-renamed', query: 'SELECT 1' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db1')[0].name, 'a-renamed');
});

test('delete() removes a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.delete('db1', 'sub1');
  assert.deepEqual(s.list('db1'), []);
});

test('deleteAll(dbId) clears all subscriptions for that DB', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  await s.deleteAll('db1');
  assert.deepEqual(s.list('db1'), []);
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
  const s = new SubscriptionStore(new CopyingMemento());
  await Promise.all([
    s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' }),
    s.save('db1', { id: 'sub2', name: 'b', query: 'SELECT 2' }),
  ]);
  assert.deepEqual(s.list('db1').map(x => x.id).sort(), ['sub1', 'sub2']);
});

test('a throwing listener does not break save or the remaining listeners', async () => {
  const s = new SubscriptionStore(new FakeMemento());
  const events: string[] = [];
  s.onDidChange(() => { throw new Error('listener bug'); });
  s.onDidChange(dbId => events.push(dbId));
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  assert.deepEqual(events, ['db1']);
  assert.equal(s.list('db1').length, 1, 'the write must still land');
});
