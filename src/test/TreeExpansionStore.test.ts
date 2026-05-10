import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeExpansionStore } from '../storage/TreeExpansionStore.js';

function fakeMemento() {
  const m = new Map<string, any>();
  return {
    api: {
      get: (k: string, d?: any) => m.has(k) ? m.get(k) : d,
      update: async (k: string, v: any) => {
        if (v === undefined) { m.delete(k); } else { m.set(k, v); }
      },
      keys: () => [...m.keys()],
    } as any,
    map: m,
  };
}

test('TreeExpansionStore: empty list by default', () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  assert.deepEqual(s.list('A'), []);
});

test('TreeExpansionStore: add records the node id once', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.add('A', 'subs.A');
  await s.add('A', 'col.A.tasks');
  assert.deepEqual(s.list('A'), ['subs.A', 'col.A.tasks']);
});

test('TreeExpansionStore: add is idempotent', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.add('A', 'subs.A');
  await s.add('A', 'subs.A');
  assert.deepEqual(s.list('A'), ['subs.A']);
});

test('TreeExpansionStore: remove drops a single id', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.add('A', 'subs.A');
  await s.add('A', 'col.A.tasks');
  await s.remove('A', 'subs.A');
  assert.deepEqual(s.list('A'), ['col.A.tasks']);
});

test('TreeExpansionStore: remove is idempotent', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.remove('A', 'never-existed');
  assert.deepEqual(s.list('A'), []);
});

test('TreeExpansionStore: per-DB isolation', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.add('A', 'subs.A');
  await s.add('B', 'subs.B');
  assert.deepEqual(s.list('A'), ['subs.A']);
  assert.deepEqual(s.list('B'), ['subs.B']);
});

test('TreeExpansionStore: clearAll wipes one DB only', async () => {
  const f = fakeMemento();
  const s = new TreeExpansionStore(f.api);
  await s.add('A', 'subs.A');
  await s.add('B', 'subs.B');
  await s.clearAll('A');
  assert.deepEqual(s.list('A'), []);
  assert.deepEqual(s.list('B'), ['subs.B']);
});
