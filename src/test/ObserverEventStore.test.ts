import test from 'node:test';
import assert from 'node:assert/strict';
import { ObserverEventStore, type ObserverEvent } from '../ditto/ObserverEventStore.js';

function ev(id: string): ObserverEvent {
  return {
    id,
    eventTimeISO: '2026-05-27T17:55:49Z',
    data: [],
    totalRows: 0,
    insertions: [],
    updates: [],
    deletions: [],
    moves: [],
  };
}

test('append + size + isEmpty + get', () => {
  const s = new ObserverEventStore();
  assert.equal(s.isEmpty, true);
  s.append(ev('a'));
  assert.equal(s.size, 1);
  assert.equal(s.isEmpty, false);
  assert.equal(s.get('a')?.id, 'a');
});

test('appendBatch is equivalent to multiple appends', () => {
  const s = new ObserverEventStore();
  s.appendBatch([ev('a'), ev('b'), ev('c')]);
  assert.equal(s.size, 3);
  assert.deepEqual(s.events.map(e => e.id), ['a', 'b', 'c']);
});

test('FIFO eviction at the 500 cap', () => {
  const s = new ObserverEventStore();
  for (let i = 0; i < 600; i++) { s.append(ev(`e${i}`)); }
  assert.equal(s.size, ObserverEventStore.capacity);
  // Oldest events are gone.
  assert.equal(s.get('e0'), undefined);
  assert.equal(s.get('e99'), undefined);
  // The 100th event onwards is retained.
  assert.equal(s.get('e100')?.id, 'e100');
  assert.equal(s.get('e599')?.id, 'e599');
  // Order is preserved.
  assert.equal(s.events[0].id, 'e100');
  assert.equal(s.events[s.events.length - 1].id, 'e599');
});

test('appendBatch evicts older events in one pass', () => {
  const s = new ObserverEventStore();
  for (let i = 0; i < 400; i++) { s.append(ev(`old${i}`)); }
  // Now batch 200 more — total would be 600, must evict 100.
  const batch: ObserverEvent[] = [];
  for (let i = 0; i < 200; i++) { batch.push(ev(`new${i}`)); }
  s.appendBatch(batch);
  assert.equal(s.size, 500);
  assert.equal(s.get('old0'), undefined);
  assert.equal(s.get('old99'), undefined);
  assert.equal(s.get('old100')?.id, 'old100');
  assert.equal(s.get('new199')?.id, 'new199');
});

test('clear removes all events and the id index', () => {
  const s = new ObserverEventStore();
  s.append(ev('a'));
  s.append(ev('b'));
  s.clear();
  assert.equal(s.size, 0);
  assert.equal(s.isEmpty, true);
  assert.equal(s.get('a'), undefined);
});

test('appendBatch with empty array is a no-op', () => {
  const s = new ObserverEventStore();
  s.appendBatch([]);
  assert.equal(s.size, 0);
});
