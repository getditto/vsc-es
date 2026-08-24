import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectQueryRows,
  MAX_QUERY_ROWS,
  type ProjectableItem,
} from '../ditto/query-projection.js';

/** Stand-in for the SDK's QueryResultItem. Counts `.value` reads and
 *  `dematerialize()` calls so the memory discipline is assertable, not just
 *  the row output. */
function item(value: unknown): ProjectableItem & { reads: number; demats: number } {
  const it = {
    reads: 0,
    demats: 0,
    get value() { it.reads += 1; return value; },
    dematerialize() { it.demats += 1; },
  };
  return it;
}

const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => item({ _id: `r${i + from}` }));

test('projectQueryRows: passes through a small result set untouched', () => {
  const items = rows(3);
  const r = projectQueryRows(items, { expectsEnvelope: false });
  assert.deepEqual(r.rows, [{ _id: 'r0' }, { _id: 'r1' }, { _id: 'r2' }]);
  assert.equal(r.truncated, false);
  assert.equal(r.totalRowCount, 3);
  assert.equal(r.profile, undefined);
});

test('projectQueryRows: dematerializes every item, including ones past the cap', () => {
  // The point of the cap is to bound host memory. Leaving the un-projected
  // items materialized would defeat it — they'd pin native memory for the
  // life of the result even though nothing ever reads them.
  const items = rows(10);
  projectQueryRows(items, { expectsEnvelope: false, maxRows: 4 });
  assert.ok(items.every(i => i.demats === 1), 'each item dematerialized exactly once');
  assert.deepEqual(items.slice(4).map(i => i.reads), [0, 0, 0, 0, 0, 0], 'past-cap values never read');
});

test('projectQueryRows: caps rows and reports the true total', () => {
  const items = rows(25);
  const r = projectQueryRows(items, { expectsEnvelope: false, maxRows: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.totalRowCount, 25, 'the UI needs the real count to say "10 of 25"');
  assert.equal(r.truncated, true);
  assert.deepEqual(r.rows[0], { _id: 'r0' }, 'keeps the FIRST rows, not the last');
});

test('projectQueryRows: exactly at the cap is not truncated', () => {
  const r = projectQueryRows(rows(10), { expectsEnvelope: false, maxRows: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, false, 'off-by-one here would show a spurious warning on every capped-size result');
});

test('projectQueryRows: the profile envelope is consumed, not shown as a row', () => {
  const envelope = item({
    '~request_profile': {
      _id: 'f701d177',
      queryType: 'select',
      resultCount: 2,
      state: 'completed',
      text: 'PROFILE SELECT * FROM tasks',
      times: { elapsed: 1_670_000, parse: 46_210, plan: 136_880, start: '2026-05-27T17:55:49Z' },
      plan: {
        '#operator': 'sequence',
        '#stats': { documentsIn: 2, documentsOut: 2 },
        children: [
          { '#operator': 'fetch', '#stats': { documentsIn: 2, documentsOut: 2 }, collection: 'tasks' },
        ],
      },
    },
  });
  const items = [...rows(2), envelope];
  const r = projectQueryRows(items, { expectsEnvelope: true });

  assert.equal(r.rows.length, 2, 'envelope excluded from rows');
  assert.deepEqual(r.rows.map(x => x._id), ['r0', 'r1']);
  assert.ok(r.profile, 'envelope parsed into the profile');
  assert.equal(r.totalRowCount, 2, 'the envelope is not a row for counting either');
});

test('projectQueryRows: expectsEnvelope with a non-envelope last row keeps that row', () => {
  // `expectsEnvelope` is a prediction, not a guarantee — a forward-incompatible
  // SDK, or a SELECT that emits no envelope, must not cost the user their last
  // row. This is the case where the last item gets read twice: once to test it
  // for an envelope, once to project it.
  const items = rows(3);
  const r = projectQueryRows(items, { expectsEnvelope: true });
  assert.equal(r.rows.length, 3, 'no row lost');
  assert.deepEqual(r.rows.map(x => x._id), ['r0', 'r1', 'r2']);
  assert.equal(r.profile, undefined);
  assert.ok((items[2]?.reads ?? 0) >= 2, 're-read after the envelope probe');
  assert.ok((items[2]?.demats ?? 0) >= 1, 'and still dematerialized');
});

test('projectQueryRows: empty result set', () => {
  for (const expectsEnvelope of [true, false]) {
    const r = projectQueryRows([], { expectsEnvelope });
    assert.deepEqual(r.rows, []);
    assert.equal(r.truncated, false);
    assert.equal(r.totalRowCount, 0);
  }
});

test('projectQueryRows: a throwing dematerialize does not lose rows', () => {
  // The SDK call is wrapped in try/catch because a failure to release memory
  // must not turn a successful query into an error the user sees.
  const bad: ProjectableItem = {
    get value() { return { _id: 'x' }; },
    dematerialize() { throw new Error('native handle already gone'); },
  };
  const r = projectQueryRows([bad], { expectsEnvelope: false });
  assert.deepEqual(r.rows, [{ _id: 'x' }]);
});

test('projectQueryRows: the default cap is MAX_QUERY_ROWS', () => {
  const r = projectQueryRows(rows(MAX_QUERY_ROWS + 5), { expectsEnvelope: false });
  assert.equal(r.rows.length, MAX_QUERY_ROWS);
  assert.equal(r.truncated, true);
  assert.equal(r.totalRowCount, MAX_QUERY_ROWS + 5);
});
