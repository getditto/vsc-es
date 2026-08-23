import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import { CollectionsRepository } from '../ditto/CollectionsRepository.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import { importDocuments } from '../ditto/ImportService.js';
import { quoteIdentifier, isBareIdentifier } from '../ditto/dql-identifier.js';
import type { Logger } from '../logging/types.js';

/**
 * DQL round-trips against a real Ditto store.
 *
 * The SDK opens in `smallPeersOnly` mode against a temp directory with no
 * credentials, no license token, and no network — `sync.start()` is never
 * called, so nothing leaves the machine. That makes the *actual emitted DQL*
 * testable, which is a stronger claim than the unit tests in
 * `dql-identifier.test.ts`: those prove the quoting function returns the string
 * we expect, while these prove Ditto's parser accepts it and the statement does
 * what we intended.
 *
 * This is the layer that used to be a MANUAL_TESTING recipe. It shouldn't have
 * been: everything the recipe asked a human to click is asserted below.
 */

// The SDK logs its startup at INFO, which would bury the test output. Disabled
// outright rather than raised to Error: a store that fails to open fails the
// assertion below anyway, and the thrown DittoError carries the reason.
DittoLogger.enabled = false;

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

/** Open a throwaway store and hand back the pieces the subjects need. */
async function withStore<T>(
  body: (ctx: {
    ditto: Ditto;
    exec: (q: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    repo: CollectionsRepository;
  }) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-dql-test-'));
  const ditto = await Ditto.open(new DittoConfig(
    '00000000-0000-4000-8000-000000000000',
    { mode: 'smallPeersOnly', privateKey: null },
    dir,
  ));
  const exec = async (q: string, args?: Record<string, unknown>) => {
    const r = args === undefined
      ? await ditto.store.execute(q)
      : await ditto.store.execute(q, args as never);
    return r.items.map(i => i.value as Record<string, unknown>);
  };
  // CollectionsRepository only reaches the store through executeRaw, so a
  // manager that forwards to the real store exercises the real query text.
  const repo = new CollectionsRepository(
    { executeRaw: exec } as unknown as DittoManager,
    noopLogger(),
  );
  try {
    return await body({ ditto, exec, repo });
  } finally {
    try { await ditto.close(); } catch { /* closing a test store is best-effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Collection names Ditto accepts that the old `^[A-Za-z0-9_]+$` guard rejected. */
const AWKWARD_NAMES = [
  'order-items',      // hyphen — the case that broke Add Index in the field
  'two words',        // space
  'Bestellungen',     // plain, but proves nothing regressed
  'Ünïcödé',          // non-ASCII
  '9lives',           // leading digit: invalid *unquoted*, fine quoted
  'select',           // a keyword as an identifier
];

test('live DQL: insert and select round-trip for names that need quoting', async () => {
  await withStore(async ({ exec }) => {
    for (const name of AWKWARD_NAMES) {
      const target = quoteIdentifier(name, 'collection');
      await exec(`INSERT INTO ${target} DOCUMENTS (:doc)`, { doc: { _id: 'a', qty: 1 } });
      const rows = await exec(`SELECT * FROM ${target}`);
      assert.equal(rows.length, 1, `round-trip for ${name}`);
      assert.equal(rows[0]._id, 'a');
      assert.equal(rows[0].qty, 1);
    }
  });
});

test('live DQL: createIndex/dropIndex work on a hyphenated collection', async () => {
  // The exact regression: the old character whitelist threw before reaching the
  // store, so a collection named `order-items` could not be indexed at all.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `order-items` DOCUMENTS (:doc)', { doc: { _id: 'a', qty: 1 } });

    await repo.createIndex('order-items', 'qty');
    const after = await exec('SELECT * FROM system:indexes');
    const mine = after.find(r => r._id === 'order-items.idx_order-items_qty');
    assert.ok(mine, `index created; saw ${JSON.stringify(after.map(r => r._id))}`);
    assert.equal(mine.collection, 'order-items');

    await repo.dropIndex('idx_order-items_qty', 'order-items');
    const gone = await exec('SELECT * FROM system:indexes');
    assert.ok(
      !gone.some(r => r._id === 'order-items.idx_order-items_qty'),
      'index dropped',
    );
  });
});

test('live DQL: createIndex accepts a nested field path', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `people` DOCUMENTS (:doc)', {
      doc: { _id: 'a', address: { city: 'Austin' } },
    });
    await repo.createIndex('people', 'address.city');
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 'people.idx_people_address_city');
    assert.ok(mine, `nested-path index created; saw ${JSON.stringify(rows.map(r => r._id))}`);
  });
});

test('live DQL: an index on a name needing quotes is created and dropped by name', async () => {
  // The generated index name inherits the collection's awkward characters
  // (`idx_order-items_qty`), so the DROP has to quote it too — a mismatch here
  // would create an index the UI could never delete.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `two words` DOCUMENTS (:doc)', { doc: { _id: 'a', qty: 1 } });
    await repo.createIndex('two words', 'qty');
    const created = await exec('SELECT * FROM system:indexes');
    const mine = created.find(r => r.collection === 'two words');
    assert.ok(mine, 'created');

    // system:indexes reports the bare name; fall back to the name createIndex
    // generates if the SDK ever stops surfacing it.
    const indexName = typeof mine.name === 'string' ? mine.name : 'idx_two words_qty';
    await repo.dropIndex(indexName, 'two words');
    const left = await exec('SELECT * FROM system:indexes');
    assert.ok(!left.some(r => r.collection === 'two words'), 'dropped');
  });
});

test('live DQL: importDocuments lands rows in the collection it was given', async () => {
  // The builder quotes the target, so an awkward name must not silently create
  // a *differently* named collection or fail the whole import.
  await withStore(async ({ exec }) => {
    const result = await importDocuments({
      documents: [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }],
      collection: 'order-items',
      insertType: 'regular',
      execute: async (q, args) => { await exec(q, args); },
    });
    assert.equal(result.successCount, 3, JSON.stringify(result.errors));
    assert.equal(result.failureCount, 0);

    const rows = await exec('SELECT * FROM `order-items`');
    assert.deepEqual(rows.map(r => r._id).sort(), ['a', 'b', 'c']);
  });
});

test('live DQL: importDocuments batch fallback still targets the quoted collection', async () => {
  await withStore(async ({ exec }) => {
    const result = await importDocuments({
      documents: Array.from({ length: 7 }, (_, i) => ({ _id: `d${i}` })),
      collection: 'two words',
      insertType: 'initial',
      batchSize: 3,
      execute: async (q, args) => { await exec(q, args); },
    });
    assert.equal(result.successCount, 7, JSON.stringify(result.errors));
    const rows = await exec('SELECT * FROM `two words`');
    assert.equal(rows.length, 7);
  });
});

test('live DQL: the query-editor prefill runs as-is for every collection name', async () => {
  // `queryAllInCollection` builds `SELECT * FROM <name>` bare when the name
  // allows it and quoted otherwise. Both forms have to be executable, because
  // the string is handed to the user as a runnable query.
  await withStore(async ({ exec }) => {
    for (const name of [...AWKWARD_NAMES, 'tasks', '_internal']) {
      await exec(`INSERT INTO ${quoteIdentifier(name)} DOCUMENTS (:doc)`, { doc: { _id: 'x' } });
      const from = isBareIdentifier(name) ? name : quoteIdentifier(name, 'collection');
      const rows = await exec(`SELECT * FROM ${from}`);
      assert.equal(rows.length, 1, `prefill "SELECT * FROM ${from}" must run`);
    }
  });
});

test('live DQL: an injection-shaped collection name is data, not syntax', async () => {
  // The payload has to survive as a *name*. If quoting leaked, the statement
  // would either fail to parse or execute the tail — both observable here.
  await withStore(async ({ exec }) => {
    const payload = 'x` (a); DROP INDEX `y';
    await exec(`INSERT INTO ${quoteIdentifier(payload)} DOCUMENTS (:doc)`, { doc: { _id: 'a' } });
    const rows = await exec(`SELECT * FROM ${quoteIdentifier(payload)}`);
    assert.equal(rows.length, 1, 'the payload round-trips as one collection name');

    const collections = await exec('SELECT * FROM system:collections');
    assert.ok(
      collections.some(c => c.name === payload),
      `stored verbatim as a name; saw ${JSON.stringify(collections.map(c => c.name))}`,
    );
  });
});

test('live DQL: COUNT(*) hydration query parses for awkward names', async () => {
  // CollectionsRepository builds this per collection during hydrate; an
  // unquoted name here would break the whole tree refresh, not just one row.
  await withStore(async ({ exec }) => {
    await exec('INSERT INTO `order-items` DOCUMENTS (:a), (:b)', {
      a: { _id: 'a' }, b: { _id: 'b' },
    });
    const rows = await exec(
      `SELECT COUNT(*) AS numDocs FROM ${quoteIdentifier('order-items', 'collection')}`,
    );
    assert.equal(Number(rows[0].numDocs), 2);
  });
});
