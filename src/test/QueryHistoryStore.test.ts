import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryHistoryStore } from '../storage/QueryHistoryStore.js';

function fakeMemento() {
  const m = new Map<string, any>();
  return { get: (k: string, d?: any) => m.has(k) ? m.get(k) : d, update: async (k: string, v: any) => { m.set(k, v); }, keys: () => [...m.keys()] } as any;
}

test('add/list: newest first', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  await s.add('A', 'q1');
  await s.add('A', 'q2');
  const list = s.list('A');
  assert.equal(list[0].query, 'q2');
  assert.equal(list[1].query, 'q1');
});

test('bounded at 50; oldest dropped', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  for (let i = 0; i < 55; i++) await s.add('A', `q${i}`);
  const list = s.list('A');
  assert.equal(list.length, 50);
  assert.equal(list[0].query, 'q54');
  assert.equal(list[49].query, 'q5');
});

test('per-DB isolation', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  await s.add('A', 'a1');
  await s.add('B', 'b1');
  assert.equal(s.list('A').length, 1);
  assert.equal(s.list('B').length, 1);
});

test('delete by id', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  const e = await s.add('A', 'q1');
  await s.delete('A', e.id);
  assert.equal(s.list('A').length, 0);
});

test('deleteAll clears one DB', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  await s.add('A', 'q1');
  await s.add('B', 'q2');
  await s.deleteAll('A');
  assert.equal(s.list('A').length, 0);
  assert.equal(s.list('B').length, 1);
});

test('onChange fires on add', async () => {
  const s = new QueryHistoryStore(fakeMemento());
  let fired: string | null = null;
  s.onChange(({ databaseId }) => { fired = databaseId; });
  await s.add('A', 'q1');
  assert.equal(fired, 'A');
});
