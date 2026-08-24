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
  assert.equal(s.list('A')[0]?.id, 'o1');
  assert.equal(s.list('B')[0]?.id, 'o2');
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

/** A memento that behaves like the real one under concurrency: reads get a
 *  fresh copy and writes settle a tick later, so two overlapping
 *  read-modify-write cycles each observe the pre-state unless the store
 *  serializes them. */
function copyingMemento() {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string, d?: T): T | undefined =>
      (m.has(k) ? structuredClone(m.get(k)) as T : d),
    update: async (k: string, v: unknown): Promise<void> => {
      await Promise.resolve();
      if (v === undefined) { m.delete(k); } else { m.set(k, structuredClone(v)); }
    },
    keys: () => [...m.keys()],
  } as never;
}

test('concurrent saves do not lose writes', async () => {
  const s = new ObserverStore(copyingMemento());
  await Promise.all([
    s.save('A', { id: 'o1', name: 'a', query: 'SELECT 1' }),
    s.save('A', { id: 'o2', name: 'b', query: 'SELECT 2' }),
  ]);
  assert.deepEqual(s.list('A').map(o => o.id).sort(), ['o1', 'o2']);
});

test('a throwing listener does not break save or the remaining listeners', async () => {
  const s = new ObserverStore(fakeMemento());
  const events: string[] = [];
  s.onDidChange(() => { throw new Error('listener bug'); });
  s.onDidChange(dbId => events.push(dbId));
  await s.save('A', { id: 'o1', name: 'a', query: 'SELECT 1' });
  assert.deepEqual(events, ['A']);
  assert.equal(s.list('A').length, 1, 'the write must still land');
});
