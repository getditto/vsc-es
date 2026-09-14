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

test('TreeExpansionStore: concurrent add bursts do not lose node ids', async () => {
  // Regression: add/remove each did an unserialized read-modify-write,
  // unlike every sibling store. A memento whose update applies
  // asynchronously (next tick) makes the interleaving deterministic:
  // without the enqueue queue both adds read the same pre-state and the
  // second write dropped the first node from the restored tree.
  const backing = new Map<string, unknown>();
  const slowMemento = {
    get: <T,>(k: string): T | undefined => backing.get(k) as T | undefined,
    update: async (k: string, v: unknown): Promise<void> => {
      await new Promise(r => setTimeout(r, 1)); // apply a tick later
      if (v === undefined) { backing.delete(k); } else { backing.set(k, v); }
    },
  };
  const s = new TreeExpansionStore(slowMemento);

  await Promise.all([s.add('A', 'subs.A'), s.add('A', 'col.A.tasks'), s.add('A', 'obs.A')]);
  assert.deepEqual(s.list('A').sort(), ['col.A.tasks', 'obs.A', 'subs.A']);

  await Promise.all([s.remove('A', 'obs.A'), s.add('A', 'idx.A.tasks')]);
  assert.deepEqual(s.list('A').sort(), ['col.A.tasks', 'idx.A.tasks', 'subs.A']);
});
