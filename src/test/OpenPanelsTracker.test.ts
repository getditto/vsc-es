import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';

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

test('OpenPanelsTracker: empty state by default', () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  assert.deepEqual(t.get('A'), { query: [], peers: false });
});

test('OpenPanelsTracker: upsert adds a new query tab', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'SELECT * FROM tasks' });
  assert.deepEqual(t.get('A').query, [{ id: 't1', text: 'SELECT * FROM tasks' }]);
});

test('OpenPanelsTracker: upsert updates in place by id (preserves order)', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.upsertQueryTab('A', { id: 't2', text: 'B' });
  await t.upsertQueryTab('A', { id: 't1', text: 'A2' }); // update
  assert.deepEqual(t.get('A').query, [
    { id: 't1', text: 'A2' },
    { id: 't2', text: 'B' },
  ]);
});

test('OpenPanelsTracker: removeQueryTab drops a single slot, leaves others', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.upsertQueryTab('A', { id: 't2', text: 'B' });
  await t.removeQueryTab('A', 't1');
  assert.deepEqual(t.get('A').query, [{ id: 't2', text: 'B' }]);
});

test('OpenPanelsTracker: removeQueryTab is idempotent', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.removeQueryTab('A', 'never-existed');
  assert.deepEqual(t.get('A').query, []);
});

test('OpenPanelsTracker: clearQueryTabs wipes only query, keeps peers', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.setPeers('A', true);
  await t.clearQueryTabs('A');
  const s = t.get('A');
  assert.deepEqual(s.query, []);
  assert.equal(s.peers, true);
});

test('OpenPanelsTracker: setPeers toggles cleanly', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.setPeers('A', true);
  assert.equal(t.get('A').peers, true);
  await t.setPeers('A', false);
  assert.equal(t.get('A').peers, false);
});

test('OpenPanelsTracker: per-DB state aggregates both kinds', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.upsertQueryTab('A', { id: 't2', text: 'B' });
  await t.setPeers('A', true);
  const s = t.get('A');
  assert.equal(s.query.length, 2);
  assert.equal(s.peers, true);
});

test('OpenPanelsTracker: per-DB isolation', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.setPeers('B', true);
  assert.deepEqual(t.get('A').query.length, 1);
  assert.equal(t.get('A').peers, false);
  assert.deepEqual(t.get('B').query.length, 0);
  assert.equal(t.get('B').peers, true);
});

test('OpenPanelsTracker: deleteAll clears one DB only', async () => {
  const f = fakeMemento();
  const t = new OpenPanelsTracker(f.api);
  await t.upsertQueryTab('A', { id: 't1', text: 'A' });
  await t.setPeers('B', true);
  await t.deleteAll('A');
  assert.deepEqual(t.get('A'), { query: [], peers: false });
  assert.equal(t.get('B').peers, true);
});
