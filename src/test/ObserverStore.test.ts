import test from 'node:test';
import assert from 'node:assert/strict';
import { ObserverStore } from '../storage/ObserverStore.js';

function fakeMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string, d?: T): T | undefined => (m.has(k) ? m.get(k) as T : d),
    update: async (k: string, v: unknown): Promise<void> => { m.set(k, v); },
    keys: () => [...m.keys()],
  } as never;
}

test('save then list returns the saved observer', async () => {
  const s = new ObserverStore(fakeMemento());
  await s.save('A', { id: 'o1', name: 'tasks', query: 'SELECT * FROM tasks' });
  assert.deepEqual(s.list('A'), [
    { id: 'o1', name: 'tasks', query: 'SELECT * FROM tasks' },
  ]);
});

test('save with the same id replaces in place (no duplicates)', async () => {
  const s = new ObserverStore(fakeMemento());
  await s.save('A', { id: 'o1', name: 'tasks', query: 'SELECT * FROM tasks' });
  await s.save('A', { id: 'o1', name: 'renamed', query: 'SELECT * FROM cars' });
  assert.deepEqual(s.list('A'), [
    { id: 'o1', name: 'renamed', query: 'SELECT * FROM cars' },
  ]);
});

test('per-database isolation', async () => {
  const s = new ObserverStore(fakeMemento());
  await s.save('A', { id: 'o1', name: 'a', query: 'SELECT 1' });
  await s.save('B', { id: 'o2', name: 'b', query: 'SELECT 2' });
  assert.equal(s.list('A').length, 1);
  assert.equal(s.list('B').length, 1);
  assert.equal(s.list('A')[0].id, 'o1');
  assert.equal(s.list('B')[0].id, 'o2');
});

test('delete by id', async () => {
  const s = new ObserverStore(fakeMemento());
  await s.save('A', { id: 'o1', name: 'x', query: 'SELECT 1' });
  await s.delete('A', 'o1');
  assert.deepEqual(s.list('A'), []);
});

test('deleteAll clears one database', async () => {
  const s = new ObserverStore(fakeMemento());
  await s.save('A', { id: 'o1', name: 'a', query: 'SELECT 1' });
  await s.save('B', { id: 'o2', name: 'b', query: 'SELECT 2' });
  await s.deleteAll('A');
  assert.deepEqual(s.list('A'), []);
  assert.equal(s.list('B').length, 1);
});

test('onDidChange fires for save and delete', async () => {
  const s = new ObserverStore(fakeMemento());
  const events: string[] = [];
  s.onDidChange(dbId => events.push(dbId));
  await s.save('A', { id: 'o1', name: 'a', query: 'SELECT 1' });
  await s.delete('A', 'o1');
  assert.deepEqual(events, ['A', 'A']);
});
