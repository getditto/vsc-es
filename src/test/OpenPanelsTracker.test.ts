import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';

function fakeMemento() {
  const m = new Map<string, any>();
  return {
    api: {
      get: (k: string, d?: any) => m.has(k) ? m.get(k) : d,
      update: async (k: string, v: any) => { m.set(k, v); },
      keys: () => [...m.keys()],
    } as any,
    map: m,
  };
}

test('OpenPanelsTracker: add/list/remove', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.add('A', 'query');
  await t.add('A', 'peers');
  assert.deepEqual(t.list('A'), ['query', 'peers']);
  await t.remove('A', 'query');
  assert.deepEqual(t.list('A'), ['peers']);
});

test('OpenPanelsTracker: dedupes on add', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.add('A', 'query');
  await t.add('A', 'query');
  assert.deepEqual(t.list('A'), ['query']);
});

test('OpenPanelsTracker: per-DB isolation', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.add('A', 'query');
  await t.add('B', 'peers');
  assert.deepEqual(t.list('A'), ['query']);
  assert.deepEqual(t.list('B'), ['peers']);
});

test('OpenPanelsTracker: deleteAll clears one DB only', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.add('A', 'query');
  await t.add('B', 'peers');
  await t.deleteAll('A');
  assert.deepEqual(t.list('A'), []);
  assert.deepEqual(t.list('B'), ['peers']);
});

test('OpenPanelsTracker: remove is idempotent', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.add('A', 'query');
  await t.remove('A', 'query');
  await t.remove('A', 'query');
  assert.deepEqual(t.list('A'), []);
});
