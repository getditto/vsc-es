import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateJsonDocuments,
  validateCollectionName,
  buildBatchInsertQuery,
  buildSingleInsertQuery,
  buildBatchArguments,
  chunkArray,
  importDocuments,
  ImportValidationError,
  type ImportProgress,
} from '../ditto/ImportService.js';

// ─── validateJsonDocuments ─────────────────────────────────────

test('validateJsonDocuments: parses array of objects with _id', () => {
  const raw = JSON.stringify([{ _id: 'a', name: 'Alice' }, { _id: 'b', name: 'Bob' }]);
  const docs = validateJsonDocuments(raw);
  assert.equal(docs.length, 2);
  assert.equal(docs[0]._id, 'a');
  assert.equal(docs[1]._id, 'b');
});

test('validateJsonDocuments: rejects non-array top level', () => {
  assert.throws(() => validateJsonDocuments('{"_id": "a"}'),
    (err: unknown) => err instanceof ImportValidationError && err.kind === 'invalidJson',
  );
});

test('validateJsonDocuments: rejects malformed JSON with parse error in message', () => {
  assert.throws(() => validateJsonDocuments('this is not json'),
    (err: unknown) => err instanceof ImportValidationError && err.kind === 'invalidJson',
  );
});

test('validateJsonDocuments: rejects array entry that is not an object', () => {
  assert.throws(() => validateJsonDocuments(JSON.stringify(['scalar'])),
    (err: unknown) => err instanceof ImportValidationError && /index 0/.test((err as Error).message),
  );
});

test('validateJsonDocuments: rejects nested-array entry', () => {
  assert.throws(() => validateJsonDocuments(JSON.stringify([[{ _id: 'a' }]])),
    (err: unknown) => err instanceof ImportValidationError,
  );
});

test('validateJsonDocuments: rejects entry missing _id', () => {
  assert.throws(() => validateJsonDocuments(JSON.stringify([{ name: 'no id here' }])),
    (err: unknown) => err instanceof ImportValidationError && err.kind === 'missingId',
  );
});

test('validateJsonDocuments: accepts non-string _id values (numbers, etc.)', () => {
  const docs = validateJsonDocuments(JSON.stringify([{ _id: 42 }, { _id: 'x' }]));
  assert.equal(docs.length, 2);
});

test('validateJsonDocuments: empty array is valid (zero docs)', () => {
  assert.deepEqual(validateJsonDocuments('[]'), []);
});

// ─── validateCollectionName ────────────────────────────────────

test('validateCollectionName: accepts letters, numbers, underscores', () => {
  validateCollectionName('Users');
  validateCollectionName('orders_2026');
  validateCollectionName('_internal');
  validateCollectionName('a1b2c3');
});

test('validateCollectionName: accepts names that need backtick quoting', () => {
  // Ditto allows these; the query builders backtick-quote the target, so
  // rejecting them only locked the user out of collections they already had.
  for (const ok of ['has-dash', 'a b', 'Bestellungen', 'order.items', '9starts_with_digit']) {
    validateCollectionName(ok);
  }
});

test('validateCollectionName: injection attempts are neutralised by quoting, not rejection', () => {
  // The defence is the backtick quoting in the builder, so assert on the
  // statement rather than on a thrown error: a `;` or a `--` inside a quoted
  // identifier is just part of the name.
  for (const bad of ['users; DROP TABLE', 'users--comment', "x'", '$weird']) {
    validateCollectionName(bad);
    const q = buildSingleInsertQuery(bad, 'regular');
    assert.match(q, /^INSERT INTO `/, `quoted: ${bad}`);
    assert.equal(q.split('\n')[0], `INSERT INTO \`${bad}\``);
  }
});

test('buildSingleInsertQuery: a backtick in the name is doubled, not escaped out', () => {
  // The one character with meaning inside a quoted identifier. Doubling it is
  // the only correct escape; anything else lets the identifier terminate early.
  assert.equal(
    buildSingleInsertQuery('we`ird', 'regular').split('\n')[0],
    'INSERT INTO `we``ird`',
  );
});

test('validateCollectionName: rejects empty string', () => {
  assert.throws(() => validateCollectionName(''), ImportValidationError);
});

test('validateCollectionName: rejects control characters', () => {
  for (const bad of ['a\0b', 'a\nb', 'a\rb']) {
    assert.throws(() => validateCollectionName(bad), ImportValidationError);
  }
});

// ─── Query builders ────────────────────────────────────────────

test('buildBatchInsertQuery: regular insert produces ON ID CONFLICT clause', () => {
  const q = buildBatchInsertQuery('Users', 2, 'regular');
  assert.match(q, /INSERT INTO `Users`/);
  assert.match(q, /\(deserialize_json\(:doc0\)\), \(deserialize_json\(:doc1\)\)/);
  assert.match(q, /ON ID CONFLICT DO UPDATE/);
});

test('buildBatchInsertQuery: initial insert produces INITIAL DOCUMENTS clause', () => {
  const q = buildBatchInsertQuery('Users', 1, 'initial');
  assert.match(q, /INITIAL DOCUMENTS/);
  assert.doesNotMatch(q, /ON ID CONFLICT/);
});

test('buildSingleInsertQuery: uses :jsonDoc placeholder', () => {
  assert.match(buildSingleInsertQuery('Users', 'regular'), /:jsonDoc/);
  assert.match(buildSingleInsertQuery('Users', 'initial'), /:jsonDoc/);
});

test('buildBatchArguments: produces docN keys matching batch order', () => {
  const args = buildBatchArguments([
    { _id: 'a', n: 1 },
    { _id: 'b', n: 2 },
  ]);
  assert.equal(Object.keys(args).length, 2);
  assert.equal(JSON.parse(args.doc0 as string)._id, 'a');
  assert.equal(JSON.parse(args.doc1 as string)._id, 'b');
});

// ─── chunkArray ────────────────────────────────────────────────

test('chunkArray: splits into evenly-sized buckets with final remainder', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunkArray: input shorter than chunk size → one chunk', () => {
  assert.deepEqual(chunkArray([1, 2], 5), [[1, 2]]);
});

test('chunkArray: empty input → empty output', () => {
  assert.deepEqual(chunkArray([], 5), []);
});

test('chunkArray: chunk size 0 throws', () => {
  assert.throws(() => chunkArray([1], 0), RangeError);
});

// ─── importDocuments (the orchestrator) ────────────────────────

test('importDocuments: happy path inserts all docs in batches; success count matches total', async () => {
  const calls: { query: string; args?: Record<string, unknown> }[] = [];
  const execute = async (query: string, args?: Record<string, unknown>) => { calls.push({ query, args }); };
  const docs = Array.from({ length: 7 }, (_, i) => ({ _id: `id-${i}` }));
  const result = await importDocuments({
    documents: docs,
    collection: 'Users',
    insertType: 'regular',
    execute,
    batchSize: 3,
  });
  assert.equal(result.successCount, 7);
  assert.equal(result.failureCount, 0);
  assert.deepEqual(result.errors, []);
  // 7 docs / batch 3 → 3 batches (3, 3, 1) → 3 executor calls.
  assert.equal(calls.length, 3);
  // Each call goes through the BATCH path; no single-doc fallback.
  for (const c of calls) {
    assert.match(c.query, /INSERT INTO `Users`/);
    assert.doesNotMatch(c.query, /:jsonDoc/);
  }
});

test('importDocuments: unquotable collection name throws before any execute call', async () => {
  let executed = false;
  await assert.rejects(importDocuments({
    documents: [{ _id: 'a' }],
    // A NUL can't be expressed as a DQL identifier at all. An injection-shaped
    // name like 'evil; DROP TABLE' is NOT rejected any more — it's quoted, and
    // the builder tests assert that it stays inside the backticks.
    collection: 'evil\0name',
    insertType: 'regular',
    execute: async () => { executed = true; },
  }), ImportValidationError);
  assert.equal(executed, false, 'execute must NOT be called when collection name is invalid');
});

test('importDocuments: batch failure → falls back to single-doc inserts, errors per row', async () => {
  let firstCall = true;
  const execute = async (query: string) => {
    if (firstCall) {
      firstCall = false;
      // Fail the entire batch.
      throw new Error('batch boom');
    }
    // Single-doc fallback: succeed on docs except for _id === 'bad'.
    if (query.includes(':jsonDoc')) {
      // We can't see the bound arg from query alone; the test instead
      // varies behaviour by call index — make the 2nd single-doc call fail.
      if (singleCallIndex === 1) {
        singleCallIndex += 1;
        throw new Error('row 2 bad');
      }
      singleCallIndex += 1;
    }
  };
  let singleCallIndex = 0;
  const result = await importDocuments({
    documents: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }],
    collection: 'Users',
    insertType: 'regular',
    execute,
    batchSize: 3,
  });
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Document b/);
  assert.match(result.errors[0], /row 2 bad/);
});

test('importDocuments: every doc in a failing batch can fail independently', async () => {
  let firstCall = true;
  const execute = async () => {
    if (firstCall) { firstCall = false; throw new Error('batch fail'); }
    throw new Error('row fail');
  };
  const result = await importDocuments({
    documents: [{ _id: 'a' }, { _id: 'b' }],
    collection: 'Users',
    insertType: 'regular',
    execute,
    batchSize: 2,
  });
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 2);
  assert.equal(result.errors.length, 2);
});

test('importDocuments: progress callback fires at expected boundaries', async () => {
  const ticks: ImportProgress[] = [];
  await importDocuments({
    documents: Array.from({ length: 5 }, (_, i) => ({ _id: `id-${i}` })),
    collection: 'Users',
    insertType: 'regular',
    execute: async () => {},
    batchSize: 2,
    onProgress: (p) => { ticks.push(p); },
  });
  // 3 batches (2,2,1) → 6 ticks total: 3 "starting" + 3 "completed".
  assert.equal(ticks.length, 6);
  // First tick: starting batch 1, currentDocumentId='id-0'.
  assert.equal(ticks[0].current, 1);
  assert.equal(ticks[0].currentDocumentId, 'id-0');
  // Last tick: completion of final partial batch → current = total.
  assert.equal(ticks[ticks.length - 1].current, 5);
  assert.equal(ticks[ticks.length - 1].total, 5);
});

test('importDocuments: progress callback that throws does not abort import', async () => {
  const result = await importDocuments({
    documents: [{ _id: 'a' }],
    collection: 'Users',
    insertType: 'regular',
    execute: async () => {},
    batchSize: 1,
    onProgress: () => { throw new Error('UI exploded'); },
  });
  assert.equal(result.successCount, 1);
});

test('importDocuments: insertType=initial threads through to query string', async () => {
  let observed = '';
  await importDocuments({
    documents: [{ _id: 'a' }],
    collection: 'Users',
    insertType: 'initial',
    execute: async (q) => { observed = q; },
    batchSize: 1,
  });
  assert.match(observed, /INITIAL DOCUMENTS/);
});

test('importDocuments: empty document set returns zero counts without calling execute', async () => {
  let called = false;
  const result = await importDocuments({
    documents: [],
    collection: 'Users',
    insertType: 'regular',
    execute: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 0);
});
