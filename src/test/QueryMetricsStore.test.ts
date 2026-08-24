import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryMetricsStore } from '../storage/QueryMetricsStore.js';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';

const md = (overrides: Partial<QueryResultMetadata> = {}): QueryResultMetadata => ({
  dql: 'SELECT * FROM tasks',
  durationMs: 10,
  resultCount: 1,
  explain: '{}',
  timestamp: Date.now(),
  location: 'local',
  ...overrides,
});

test('QueryMetricsStore: empty by default', () => {
  const s = new QueryMetricsStore();
  assert.deepEqual(s.list('A'), []);
});

test('QueryMetricsStore: capture mints a stable id', () => {
  const s = new QueryMetricsStore();
  s.capture('A', md());
  const list = s.list('A');
  assert.equal(list.length, 1);
  assert.equal(typeof list[0]?.id, 'string');
  assert.ok((list[0]?.id.length ?? 0) > 0);
});

test('QueryMetricsStore: list is newest-first', () => {
  const s = new QueryMetricsStore();
  s.capture('A', md({ dql: 'first' }));
  s.capture('A', md({ dql: 'second' }));
  s.capture('A', md({ dql: 'third' }));
  assert.deepEqual(s.list('A').map(r => r.dql), ['third', 'second', 'first']);
});

test('QueryMetricsStore: caps at MAX_RECORDS, drops oldest', () => {
  const s = new QueryMetricsStore();
  for (let i = 0; i < QueryMetricsStore.MAX_RECORDS + 5; i += 1) {
    s.capture('A', md({ dql: `q${i}` }));
  }
  const list = s.list('A');
  assert.equal(list.length, QueryMetricsStore.MAX_RECORDS);
  // Newest record (latest q-index) is at the front.
  assert.equal(list[0]?.dql, `q${QueryMetricsStore.MAX_RECORDS + 5 - 1}`);
  // Records q0..q4 should have fallen off.
  assert.ok(!list.some(r => r.dql === 'q0'));
  assert.ok(!list.some(r => r.dql === 'q4'));
});

test('QueryMetricsStore: per-DB isolation', () => {
  const s = new QueryMetricsStore();
  s.capture('A', md({ dql: 'a-query' }));
  s.capture('B', md({ dql: 'b-query' }));
  assert.equal(s.list('A')[0]?.dql, 'a-query');
  assert.equal(s.list('B')[0]?.dql, 'b-query');
});

test('QueryMetricsStore: clear wipes one DB only', () => {
  const s = new QueryMetricsStore();
  s.capture('A', md({ dql: 'a-query' }));
  s.capture('B', md({ dql: 'b-query' }));
  s.clear('A');
  assert.deepEqual(s.list('A'), []);
  assert.equal(s.list('B').length, 1);
});

test('QueryMetricsStore: onChange fires on capture and clear with databaseId', () => {
  const s = new QueryMetricsStore();
  const events: { databaseId: string }[] = [];
  s.onChange(e => events.push(e));
  s.capture('A', md());
  s.capture('B', md());
  s.clear('A');
  assert.deepEqual(events, [{ databaseId: 'A' }, { databaseId: 'B' }, { databaseId: 'A' }]);
});

test('QueryMetricsStore: onChange does NOT fire when clearing an unknown DB', () => {
  const s = new QueryMetricsStore();
  const events: { databaseId: string }[] = [];
  s.onChange(e => events.push(e));
  s.clear('unknown');
  assert.equal(events.length, 0);
});
