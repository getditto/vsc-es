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
import { parseIndexKeys } from '../ditto/index-builder.js';
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
      assert.equal(rows[0]?._id, 'a');
      assert.equal(rows[0]?.qty, 1);
    }
  });
});

test('live DQL: createIndex/dropIndex work on a hyphenated collection', async () => {
  // The exact regression: the old character whitelist threw before reaching the
  // store, so a collection named `order-items` could not be indexed at all.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `order-items` DOCUMENTS (:doc)', { doc: { _id: 'a', qty: 1 } });

    await repo.createIndex('order-items', [{ name: 'qty', ascending: true }]);
    const after = await exec('SELECT * FROM system:indexes');
    const mine = after.find(r => r._id === 'order-items.idx_order_items_qty');
    assert.ok(mine, `index created; saw ${JSON.stringify(after.map(r => r._id))}`);
    assert.equal(mine.collection, 'order-items');

    await repo.dropIndex('idx_order_items_qty', 'order-items');
    const gone = await exec('SELECT * FROM system:indexes');
    assert.ok(
      !gone.some(r => r._id === 'order-items.idx_order_items_qty'),
      'index dropped',
    );
  });
});

test('live DQL: an index on a dotted collection parses, displays, and drops by its bare name', async () => {
  // Regression: parseSystemIndexRow split the index _id at the FIRST dot,
  // so collection `app.ios` produced displayName `ios.idx_…` — breaking the
  // tree display and making deleteIndex build a DROP against a name that
  // never existed while the UI reported success.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `app.ios` DOCUMENTS (:d)', { d: { _id: 'a', qty: 1 } });

    await repo.createIndex('app.ios', [{ name: 'qty', ascending: true }]);
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 'app.ios.idx_app_ios_qty');
    assert.ok(mine, `index created; saw ${JSON.stringify(rows.map(r => r._id))}`);
    assert.equal(mine.collection, 'app.ios');

    // The tree's view of the same row: displayName must be the BARE index
    // name, not the suffix after the collection's own dot.
    const parsed = repo.current().find(c => c.name === 'app.ios');
    assert.ok(parsed, 'collection in the hydrated cache');
    const idx = parsed.indexes.find(i => i.id === 'app.ios.idx_app_ios_qty');
    assert.ok(idx, `cache carries the index; saw ${JSON.stringify(parsed.indexes.map(i => i.id))}`);
    assert.equal(idx.displayName, 'idx_app_ios_qty');

    // The delete flow feeds displayName straight into buildDropIndexQuery.
    await repo.dropIndex(idx.displayName, 'app.ios');
    const left = await exec('SELECT * FROM system:indexes');
    assert.ok(!left.some(r => r._id === 'app.ios.idx_app_ios_qty'), 'index dropped');
  });
});

test('live DQL: createIndex refuses to write when the active config switches mid-create', async () => {
  // The switch orchestrator closes the Add Index panel but cannot cancel an
  // in-flight createIndex, and executeRaw always targets the CURRENT session.
  // The guard must stop the CREATE when the active config id changed between
  // the entry snapshot and the statement — otherwise the index lands on the
  // new database. The real store stands in for the statement we must NOT send.
  await withStore(async ({ exec }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', qty: 1 } });
    let activeId: string | null = 'db-1';
    const repo = new CollectionsRepository(
      {
        executeRaw: exec,
        // First poll (entry snapshot) sees db-1; the re-check before the
        // CREATE sees the switch.
        getActiveConfigId: () => {
          const id = activeId;
          activeId = 'db-2';
          return id;
        },
      } as unknown as DittoManager,
      noopLogger(),
    );

    await assert.rejects(
      () => repo.createIndex('t', [{ name: 'qty', ascending: true }]),
      /active connection changed mid-index-operation/,
    );
    const rows = await exec('SELECT * FROM system:indexes WHERE collection = :c', { c: 't' });
    assert.equal(rows.length, 0, 'no index was created after the switch was detected');
  });
});

test('live DQL: createIndex with no active-config reader still works (test-fake seam)', async () => {
  // The guard must be a no-op when the manager cannot report an active id —
  // every existing caller builds the repo against a live manager, and tests
  // against an executeRaw-only fake.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', qty: 1 } });
    await repo.createIndex('t', [{ name: 'qty', ascending: true }]);
    const rows = await exec('SELECT * FROM system:indexes');
    assert.ok(rows.some(r => r._id === 't.idx_t_qty'));
  });
});

test('live DQL: createIndex accepts a nested field path', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `people` DOCUMENTS (:doc)', {
      doc: { _id: 'a', address: { city: 'Austin' } },
    });
    await repo.createIndex('people', [{ name: 'address.city', ascending: true }]);
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
    await repo.createIndex('two words', [{ name: 'qty', ascending: true }]);
    const created = await exec('SELECT * FROM system:indexes');
    const mine = created.find(r => r.collection === 'two words');
    assert.ok(mine, 'created');

    // system:indexes reports the bare name; fall back to the name createIndex
    // generates if the SDK ever stops surfacing it.
    const indexName = typeof mine.name === 'string' ? mine.name : 'idx_two_words_qty';
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
    assert.equal(Number(rows[0]?.numDocs), 2);
  });
});

// ─── Composite indexes (SDK 5.1) ───────────────────────────────

test('live DQL: a composite index is created with both keys and directions', async () => {
  // The feature itself: more than one field in one index. Asserted against
  // system:indexes rather than just "the statement did not throw", because a
  // wrong key order or a dropped direction still parses.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `tasks` DOCUMENTS (:doc)', {
      doc: { _id: 'a', status: 'open', createdAt: 3 },
    });

    await repo.createIndex('tasks', [
      { name: 'status', ascending: true },
      { name: 'createdAt', ascending: false },
    ]);

    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 'tasks.idx_tasks_status_createdAt');
    assert.ok(mine, `composite index created; saw ${JSON.stringify(rows.map(r => r._id))}`);
    assert.deepEqual(parseIndexKeys(mine.fields), [
      { name: 'status', ascending: true },
      { name: 'createdAt', ascending: false },
    ], `stored keys: ${JSON.stringify(mine.fields)}`);
  });
});

test('live DQL: a composite index preserves key order, not alphabetical order', async () => {
  // Order decides which queries the index can serve, so it must survive
  // exactly as entered.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', zebra: 1, alpha: 2 } });
    await repo.createIndex('t', [
      { name: 'zebra', ascending: true },
      { name: 'alpha', ascending: true },
    ]);
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 't.idx_t_zebra_alpha');
    assert.ok(mine);
    assert.deepEqual(parseIndexKeys(mine.fields).map(k => k.name), ['zebra', 'alpha']);
  });
});

test('live DQL: a composite index over nested paths round-trips', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `people` DOCUMENTS (:d)', {
      d: { _id: 'a', address: { city: 'Austin', zip: '78701' } },
    });
    await repo.createIndex('people', [
      { name: 'address.city', ascending: true },
      { name: 'address.zip', ascending: false },
    ]);
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 'people.idx_people_address_city_address_zip');
    assert.ok(mine, `saw ${JSON.stringify(rows.map(r => r._id))}`);
    assert.deepEqual(parseIndexKeys(mine.fields), [
      { name: 'address.city', ascending: true },
      { name: 'address.zip', ascending: false },
    ]);
  });
});

test('live DQL: a composite index on an awkward collection name works', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `order-items` DOCUMENTS (:d)', { d: { _id: 'a', sku: 'x', qty: 1 } });
    await repo.createIndex('order-items', [
      { name: 'sku', ascending: true },
      { name: 'qty', ascending: false },
    ]);
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r.collection === 'order-items');
    assert.ok(mine, `saw ${JSON.stringify(rows.map(r => r._id))}`);
    assert.equal(parseIndexKeys(mine.fields).length, 2);
  });
});

test('live DQL: re-creating the identical index is a silent success', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', s: 1, c: 2 } });
    const keys = [
      { name: 's', ascending: true },
      { name: 'c', ascending: false },
    ];
    await repo.createIndex('t', keys);
    await repo.createIndex('t', keys); // idempotent

    const rows = await exec('SELECT * FROM system:indexes');
    assert.equal(rows.filter(r => r._id === 't.idx_t_s_c').length, 1, 'exactly one index');
  });
});

test('live DQL: a same-name index with a different definition is refused, not ignored', async () => {
  // `IF NOT EXISTS` compares index NAMES only, so flipping a direction would
  // otherwise succeed silently while changing nothing — the user would believe
  // their new definition took effect. The name is direction-independent by
  // design, which is exactly why this check has to exist.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', s: 1, c: 2 } });
    await repo.createIndex('t', [
      { name: 's', ascending: true },
      { name: 'c', ascending: true },
    ]);

    await assert.rejects(
      () => repo.createIndex('t', [
        { name: 's', ascending: true },
        { name: 'c', ascending: false },   // same name, different definition
      ]),
      /already exists on "t" with a different definition/,
    );

    // The original is untouched.
    const rows = await exec('SELECT * FROM system:indexes');
    const mine = rows.find(r => r._id === 't.idx_t_s_c');
    assert.ok(mine);
    assert.deepEqual(parseIndexKeys(mine.fields).map(k => k.ascending), [true, true]);
  });
});

test('live DQL: a composite index is droppable by its generated name', async () => {
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `t` DOCUMENTS (:d)', { d: { _id: 'a', s: 1, c: 2 } });
    await repo.createIndex('t', [
      { name: 's', ascending: true },
      { name: 'c', ascending: false },
    ]);
    await repo.dropIndex('idx_t_s_c', 't');
    const rows = await exec('SELECT * FROM system:indexes');
    assert.ok(!rows.some(r => r._id === 't.idx_t_s_c'), 'dropped');
  });
});

test('live DQL: an all-blank field list is rejected before touching the store', async () => {
  await withStore(async ({ repo }) => {
    await assert.rejects(
      () => repo.createIndex('t', [{ name: '   ', ascending: true }]),
      /At least one field/,
    );
  });
});

test('live DQL: a query can be planned against a composite index', async () => {
  // The point of the feature. EXPLAIN naming the index is the only direct
  // evidence the optimizer can actually use it.
  await withStore(async ({ exec, repo }) => {
    for (let i = 0; i < 20; i++) {
      await exec('INSERT INTO `tasks` DOCUMENTS (:d)', {
        d: { _id: `t${i}`, status: i % 2 === 0 ? 'open' : 'done', createdAt: i },
      });
    }
    await repo.createIndex('tasks', [
      { name: 'status', ascending: true },
      { name: 'createdAt', ascending: false },
    ]);

    const plan = await exec(
      "EXPLAIN SELECT * FROM `tasks` WHERE status = 'open' ORDER BY createdAt DESC",
    );
    const text = JSON.stringify(plan);
    assert.match(
      text, /idx_tasks_status_createdAt/,
      `expected the composite index in the plan, got: ${text.slice(0, 400)}`,
    );
  });
});
