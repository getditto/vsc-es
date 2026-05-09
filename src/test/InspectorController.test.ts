import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectorController } from '../inspector/InspectorController.js';

function fakeMemento() {
  const m = new Map<string, any>();
  return { get: (k: string, d?: any) => m.has(k) ? m.get(k) : d, update: async (k: string, v: any) => { m.set(k, v); }, keys: () => [...m.keys()] } as any;
}

test('initial state is none', () => {
  const c = new InspectorController(fakeMemento());
  assert.equal(c.getContent().kind, 'none');
});

test('setActiveFeature: subscriptions', () => {
  const c = new InspectorController(fakeMemento());
  c.setActiveFeature({ kind: 'subscriptions', databaseId: 'A' });
  assert.deepEqual(c.getContent(), { kind: 'subscriptions', databaseId: 'A' });
});

test('setActiveFeature: query carries default tab from store', async () => {
  const m = fakeMemento();
  await m.update('dittoInspectorQueryTab.v1.A', 'metrics');
  const c = new InspectorController(m);
  c.setActiveFeature({ kind: 'query', databaseId: 'A' });
  assert.equal(c.getContent().kind, 'query');
  assert.equal((c.getContent() as any).tab, 'metrics');
});

test('setActiveFeature: query default tab is "history" when nothing stored', () => {
  const c = new InspectorController(fakeMemento());
  c.setActiveFeature({ kind: 'query', databaseId: 'A' });
  assert.equal((c.getContent() as any).tab, 'history');
});

test('setQueryTab persists per-DB and updates content', async () => {
  const m = fakeMemento();
  const c = new InspectorController(m);
  c.setActiveFeature({ kind: 'query', databaseId: 'A' });
  await c.setQueryTab('favorites');
  assert.equal((c.getContent() as any).tab, 'favorites');
  assert.equal(m.get('dittoInspectorQueryTab.v1.A'), 'favorites');
});

test('clearOnDisconnect → kind: none and clears in-memory state', () => {
  const c = new InspectorController(fakeMemento());
  c.setActiveFeature({ kind: 'query', databaseId: 'A' });
  c.setSelectedRowJson('{"x":1}');
  c.clearOnDisconnect();
  assert.deepEqual(c.getContent(), { kind: 'none' });
});

test('sticky on focus-away (no setActiveFeature called)', () => {
  const c = new InspectorController(fakeMemento());
  c.setActiveFeature({ kind: 'query', databaseId: 'A' });
  // simulate user focusing a non-Ditto editor: nothing happens
  assert.equal(c.getContent().kind, 'query');
});

test('onContentChange fires on setActiveFeature', () => {
  const c = new InspectorController(fakeMemento());
  let fired = 0;
  c.onContentChange(() => { fired++; });
  c.setActiveFeature({ kind: 'peers', databaseId: 'A' });
  assert.equal(fired, 1);
});
