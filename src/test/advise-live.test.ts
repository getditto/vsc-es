import test from 'node:test';
import { removeSdkTempDir } from './fixtures/remove-sdk-temp-dir.js';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import { DittoManager } from '../ditto/DittoManager.js';
import { CollectionsRepository } from '../ditto/CollectionsRepository.js';
import { extractQueryAdvice } from '../ditto/advise.js';
import { parseIndexKeys } from '../ditto/index-builder.js';
import type { Logger } from '../logging/types.js';

/**
 * ADVISE (SDK 5.1) against a real Ditto store. `smallPeersOnly` offline
 * mode, no sync.start, nothing leaves the machine — same harness as
 * dql-live.test.ts.
 *
 * These tests are the ROW-SHAPE PROOF for the whole feature: the claim that
 * ADVISE returns one row carrying `advice.statement` +
 * `advice.suggestedIndexes[{collection, reason, statement}]` (with a
 * ready-to-run `CREATE INDEX IF NOT EXISTS …`) comes from
 * crates/ditto-dql/src/execution/advise.rs and the dtest fixtures at
 * crates/dittoffi/tests/dql/sp-indexing/advise.dtest — and the assertions
 * below execute that contract against the actual installed SDK.
 *
 * The pipeline tests drive DittoManager.executeQuery by injecting a real
 * Ditto instance as the private session (connect() itself needs license
 * credentials we deliberately don't have in tests); executeQuery's whole
 * gating surface — PROFILE prefix decision, envelope strip, EXPLAIN
 * side-trip — runs for real.
 */

DittoLogger.enabled = false;

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

async function withStore<T>(
  body: (ctx: {
    ditto: Ditto;
    exec: (q: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    repo: CollectionsRepository;
  }) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-advise-test-'));
  const ditto = await Ditto.open(new DittoConfig(
    '00000000-0000-4000-8000-000000000000',
    { mode: 'smallPeersOnly', privateKey: null },
    dir,
  ));
  const exec = async (q: string, args?: Record<string, unknown>) => {
    const r = args === undefined
      ? await ditto.store.execute(q)
      : await ditto.store.execute(q, args as never);
    try { return r.items.map(i => i.value as Record<string, unknown>); }
    finally { await r.close(); }
  };
  const repo = new CollectionsRepository(
    { executeRaw: exec } as unknown as DittoManager,
    noopLogger(),
  );
  try {
    return await body({ ditto, exec, repo });
  } finally {
    try { await ditto.close(); } catch { /* closing a test store is best-effort */ }
    await removeSdkTempDir(dir);
  }
}

/** Wrap a real Ditto's store.execute so every statement the pipeline issues
 *  is recorded — this is how we prove ADVISE skipped the EXPLAIN side-trip
 *  and that JOIN/ADVISE got no PROFILE prefix. */
function recordingStore(ditto: Ditto): { ditto: Ditto; statements: string[] } {
  const statements: string[] = [];
  const store = ditto.store;
  const original = store.execute.bind(store);
  (store as unknown as { execute: typeof original }).execute =
    (statement: string, queryArgs?: never) => {
      statements.push(statement);
      return original(statement, queryArgs as never);
    };
  return { ditto, statements };
}

/** A DittoManager whose private session points straight at a real store. */
function managerForSession(ditto: Ditto): DittoManager {
  const manager = new DittoManager(
    { globalStorageUri: { fsPath: os.tmpdir() } } as never,
    noopLogger(),
  );
  (manager as unknown as { session: unknown }).session = {
    configId: 'db-live',
    ditto,
    subscriptionHandles: new Map(),
  };
  return manager;
}

test('live ADVISE: one row, advice object, suggestion with ready-to-run CREATE INDEX', async () => {
  await withStore(async ({ exec }) => {
    await exec('INSERT INTO `atest` DOCUMENTS (:d)', { d: { _id: 'a', e: 1 } });

    const rows = await exec('ADVISE SELECT * FROM atest WHERE e = 1');
    assert.equal(rows.length, 1, `expected a single advice row, got ${JSON.stringify(rows)}`);
    const advice = rows[0]?.advice as Record<string, unknown> | undefined;
    assert.ok(advice && typeof advice === 'object', `row carries an advice object: ${JSON.stringify(rows[0])}`);
    assert.equal(typeof advice.statement, 'string', 'advice.statement is the analysed SELECT');

    const suggestions = advice.suggestedIndexes;
    assert.ok(Array.isArray(suggestions) && suggestions.length >= 1,
      `expected suggestedIndexes, got ${JSON.stringify(advice)}`);
    const first = suggestions[0] as Record<string, unknown>;
    assert.equal(first.collection, 'atest');
    assert.equal(typeof first.reason, 'string');
    assert.ok(
      typeof first.statement === 'string' && first.statement.startsWith('CREATE INDEX IF NOT EXISTS'),
      `suggestion.statement is a ready-to-run CREATE INDEX: ${String(first.statement)}`,
    );

    // The extractor the Query Editor ships advice through.
    const extracted = extractQueryAdvice(rows);
    assert.ok(extracted);
    assert.equal(extracted.suggestions.length, 1);
  });
});

test('live ADVISE: nothing to advise on reports an outcome instead of suggestions', async () => {
  await withStore(async ({ exec }) => {
    await exec('INSERT INTO `atest` DOCUMENTS (:d)', { d: { _id: 'a', e: 1 } });
    const rows = await exec('ADVISE SELECT * FROM atest');
    const advice = extractQueryAdvice(rows);
    assert.ok(advice, `extracted advice: ${JSON.stringify(rows)}`);
    assert.equal(advice.suggestions.length, 0);
    assert.equal(typeof advice.outcome, 'string', 'an outcome string explains the no-op');
  });
});

test('live ADVISE: executing the suggestion lands a composite index in system:indexes', async () => {
  // The full round-trip the Query Editor's "Create index" button performs:
  // ADVISE → run the suggested statement verbatim → system:indexes carries
  // it → the tree's parse path (CollectionsRepository + parseIndexKeys)
  // reads it back.
  await withStore(async ({ exec, repo }) => {
    await exec('INSERT INTO `adv` DOCUMENTS (:d)', { d: { _id: 'a', e: 1, r: 2 } });

    const advice = extractQueryAdvice(await exec('ADVISE SELECT * FROM adv WHERE e = 1 AND r > 0'));
    assert.ok(advice && advice.suggestions.length === 1, `one suggestion: ${JSON.stringify(advice)}`);
    const suggestion = advice.suggestions[0];
    assert.ok(suggestion);

    // The statement Ditto proposes quotes as `ON default:`adv`` — run it verbatim.
    await exec(suggestion.statement);

    const indexes = await exec(
      'SELECT * FROM system:indexes WHERE collection = :c',
      { c: 'adv' },
    );
    assert.equal(indexes.length, 1, `suggested index present: ${JSON.stringify(indexes.map(i => i._id))}`);
    const keys = parseIndexKeys(indexes[0]?.fields);
    assert.deepEqual(keys.map(k => k.name), ['e', 'r'], `composite keys in order: ${JSON.stringify(indexes[0]?.fields)}`);

    // The tree's read path picks the index up too.
    await repo.refresh();
    const coll = repo.current().find(c => c.name === 'adv');
    assert.ok(coll);
    assert.equal(coll.indexes.length, 1, `repo sees the advised index: ${JSON.stringify(coll.indexes)}`);
    assert.equal(coll.indexes[0]?.fields.length, 2);
  });
});

test('live ADVISE: a suggestion naming composite DESC keys round-trips through execute + parse', async () => {
  // ADVISE emits `ASC` keys today; this pins the DESC half of the machinery
  // (index 8118be1 parsing) the moment ADVISE's key derivation changes, by
  // running the hand-built statement through the exact same consumers.
  await withStore(async ({ exec }) => {
    await exec('INSERT INTO `advdesc` DOCUMENTS (:d)', { d: { _id: 'a', e: 1, r: 2 } });
    await exec('CREATE INDEX IF NOT EXISTS adv_manual ON `advdesc` (`e` ASC, `r` DESC)');
    const indexes = await exec(
      'SELECT * FROM system:indexes WHERE collection = :c',
      { c: 'advdesc' },
    );
    assert.equal(indexes.length, 1, 'index created');
    assert.deepEqual(parseIndexKeys(indexes[0]?.fields), [
      { name: 'e', ascending: true },
      { name: 'r', ascending: false },
    ]);
  });
});

test('live pipeline: executeQuery runs ADVISE with no PROFILE prefix and no EXPLAIN side-trip', async () => {
  await withStore(async ({ ditto }) => {
    await ditto.store.execute('INSERT INTO `atest` DOCUMENTS (:d)', { d: { _id: 'a', e: 1 } } as never);
    const { statements } = recordingStore(ditto);
    const manager = managerForSession(ditto);

    const { rows, metadata } = await manager.executeQuery(
      'ADVISE SELECT * FROM atest WHERE e = 1',
      { collectProfiling: true, collectMetrics: true },
    );

    assert.equal(rows.length, 1, `advice row: ${JSON.stringify(rows)}`);
    assert.ok(extractQueryAdvice(rows), 'rows carry advice');
    assert.equal(metadata.explain, '', 'EXPLAIN is skipped for ADVISE');

    const prefixes = statements.map(s => s.split(/\s+/)[0]?.toUpperCase());
    assert.deepEqual(prefixes, ['ADVISE'],
      `exactly one store call, the statement verbatim — statements were: ${JSON.stringify(statements)}`);
  });
});

test('live pipeline: executeQuery passes a JOIN through (PROFILE prefix + EXPLAIN side-trip intact)', async () => {
  // JOINs are bare SELECTs, so both gates SHOULD fire — this proves the
  // gating's wholesale. The inner leg needs an index or the planner
  // rejects the join outright (QE-989, see
  // crates/dittoffi/tests/dql/joins/advise.dtest), so create one first.
  await withStore(async ({ ditto, repo }) => {
    for (let i = 0; i < 5; i++) {
      await ditto.store.execute('INSERT INTO `jcust` DOCUMENTS (:d)', { d: { _id: `c${i}`, cid: i, name: `n${i}` } } as never);
      await ditto.store.execute('INSERT INTO `jord` DOCUMENTS (:d)', { d: { _id: `o${i}`, cid: i, amount: i * 10 } } as never);
    }
    await repo.createIndex('jord', [{ name: 'cid', ascending: true }]);

    const { statements } = recordingStore(ditto);
    const manager = managerForSession(ditto);

    const dql = 'SELECT * FROM jcust t1 JOIN jord t2 ON t1.cid = t2.cid';
    const { rows, metadata } = await manager.executeQuery(dql, {
      collectProfiling: true,
      collectMetrics: true,
    });

    assert.equal(rows.length, 5, `join over indexed inner leg: ${JSON.stringify(rows[0])}`);
    assert.ok(
      rows.every(r => !('~request_profile' in r)),
      'the PROFILE envelope was stripped out of the row set',
    );
    assert.notEqual(metadata.explain, '', 'EXPLAIN side-trip fired for the JOIN');

    assert.equal(statements.length, 2, `main query + EXPLAIN: ${JSON.stringify(statements)}`);
    assert.ok(statements[0]?.startsWith(`PROFILE ${dql}`),
      `auto-PROFILE prefix applied to the bare-SELECT JOIN: ${statements[0]}`);
    assert.ok(statements[1]?.startsWith(`EXPLAIN ${dql}`),
      `EXPLAIN side-trip ran against what the user typed: ${statements[1]}`);
  });
});
