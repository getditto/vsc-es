import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionsRepository } from '../ditto/CollectionsRepository.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { DittoCollection } from '../models/DittoCollection.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * CollectionsRepository against a scripted DittoManager fake. The live DQL
 * round-trips (real store, real query text) live in dql-live.test.ts; here
 * the repository's own bookkeeping is the subject: the two-stage hydration,
 * the live __collections observer (including its transient and failure
 * guards), the per-collection COUNT fan-out absorbing single failures, and
 * the system:indexes row parser's fallback shapes. A fake manager is what
 * makes the failure paths deterministic.
 */

type Rows = Record<string, unknown>[];
type ExecResult = Rows | Error | (() => Rows | Error);

interface ManagerFake {
  calls: { query: string; args?: Record<string, unknown> | undefined }[];
  registerCalls: string[];
  cancels: number;
  /** The observer callback the repository registered, if any. */
  observerCb: ((rows: Rows) => void) | null;
  /** When true, registerStoreObserver returns null (no active session). */
  refuseRegister: boolean;
  /** When true, the observer handle's cancel() throws. */
  cancelThrows: boolean;
}

interface LogFake {
  logger: Logger;
  infos: string[];
  warns: string[];
  errors: string[];
}

function recordingLogger(): LogFake {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const self = {
    info: (m: string, _c?: LogContext) => { infos.push(m); },
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, infos, warns, errors };
}

/**
 * Script executeRaw by query. Keys are matched by prefix:
 *   'collections' → the __collections SELECT
 *   'count'       → a per-collection COUNT(*)
 *   'indexes'     → the system:indexes SELECT
 * Anything unmatched resolves to [].
 */
function fakeManager(
  script: { collections?: ExecResult; count?: ExecResult; indexes?: ExecResult },
  over: Partial<ManagerFake> = {},
): { manager: DittoManager; fake: ManagerFake } {
  const fake: ManagerFake = {
    calls: [],
    registerCalls: [],
    cancels: 0,
    observerCb: null,
    refuseRegister: false,
    cancelThrows: false,
    ...over,
  };
  const resolve = (r: ExecResult | undefined): Rows => {
    const v = typeof r === 'function' ? r() : r;
    if (v instanceof Error) { throw v; }
    return v ?? [];
  };
  const manager = {
    getActiveConfigId: () => 'db-1',
    executeRaw: async (query: string, args?: Record<string, unknown>) => {
      fake.calls.push({ query, args });
      if (query.includes('__collections')) { return resolve(script.collections); }
      if (query.startsWith('SELECT COUNT')) { return resolve(script.count); }
      if (query.includes('system:indexes')) { return resolve(script.indexes); }
      return [];
    },
    registerStoreObserver: (query: string, cb: (rows: Rows) => void) => {
      fake.registerCalls.push(query);
      if (fake.refuseRegister) { return null; }
      fake.observerCb = cb;
      return { cancel: () => {
        fake.cancels += 1;
        if (fake.cancelThrows) { throw new Error('already gone'); }
      } };
    },
  } as unknown as DittoManager;
  return { manager, fake };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for repository update'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

function collectionsOf(repo: CollectionsRepository): DittoCollection[] {
  return repo.current();
}

// ─── load / hydrate ────────────────────────────────────────────

test('load hydrates counts and indexes, sorts by name, and attaches the live observer', async () => {
  const { manager, fake } = fakeManager({
    collections: [
      { _id: 'x', name: 'tasks' },
      { _id: 'y', name: 'people' },
      { _id: 'sys1', name: '__ditto_internal' },   // system collection — filtered
      { _id: 'z' },                                 // no name — filtered
      { name: 'name-without-id' },                  // non-string _id — kept, _id ''
    ],
    count: [{ numDocs: 3 }],
    indexes: [
      { _id: 'tasks.idx_tasks_qty', collection: 'tasks', fields: ['qty'] },
      { _id: 'people.idx_people_name', collection: 'people',
        fields: [{ key: ['name'], direction: 'DESC' }] },
    ],
  });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });

  await repo.load();

  const cols = collectionsOf(repo);
  assert.deepEqual(cols.map(c => c.name), ['name-without-id', 'people', 'tasks'], 'sorted by name');
  assert.equal(cols.find(c => c.name === 'name-without-id')?._id, '', 'non-string _id decoded as empty');

  const tasks = cols.find(c => c.name === 'tasks');
  assert.equal(tasks?.documentCount, 3);
  assert.deepEqual(
    tasks?.indexes.map(i => ({ id: i.id, displayName: i.displayName, fields: i.fields })),
    [{ id: 'tasks.idx_tasks_qty', displayName: 'idx_tasks_qty', fields: [{ name: 'qty', ascending: true }] }],
  );
  const people = cols.find(c => c.name === 'people');
  assert.deepEqual(people?.indexes.map(i => i.displayName), ['idx_people_name']);
  assert.deepEqual(people?.indexes[0]?.fields, [{ name: 'name', ascending: false }]);

  assert.deepEqual(fake.registerCalls, ['SELECT * FROM __collections'], 'live observer attached');
  assert.ok(fake.observerCb, 'observer callback captured');
  assert.equal(snapshots.length, 1, 'one onChange for the hydration');
  assert.ok(log.infos.includes('Hydration complete'));
});

test('load with no active session hydrates but warns that the observer was not registered', async () => {
  const { manager } = fakeManager({ collections: [{ _id: 'x', name: 'tasks' }] },
    { refuseRegister: true });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);

  await repo.load();

  assert.equal(collectionsOf(repo).length, 1, 'the cache still hydrated');
  assert.ok(log.warns.includes('No active session — collections observer not registered'));
});

test('a second load re-hydrates but does not leak a second observer', async () => {
  const { manager, fake } = fakeManager({ collections: [{ _id: 'x', name: 'tasks' }] });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);

  await repo.load();
  await repo.load();

  assert.equal(fake.registerCalls.length, 1, 're-entrant startObserver is a no-op');
  assert.ok(log.infos.includes('Observer already attached — skipping'));
});

test('refresh re-runs the hydration without touching the observer', async () => {
  const { manager, fake } = fakeManager({ collections: [{ _id: 'x', name: 'tasks' }] });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);

  await repo.load();
  await repo.refresh();

  const collectionSelects = fake.calls.filter(c => c.query === 'SELECT * FROM __collections');
  assert.equal(collectionSelects.length, 2, 'hydration re-ran');
  assert.equal(fake.registerCalls.length, 1, 'the observer was not re-registered');
});

test('an empty store skips the count and index queries entirely', async () => {
  const { manager, fake } = fakeManager({ collections: [] });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);

  await repo.load();

  assert.deepEqual(fake.calls.map(c => c.query), ['SELECT * FROM __collections'],
    'nothing to count or index — no fan-out');
  assert.deepEqual(collectionsOf(repo), []);
});

test('a hydration failure empties the cache, fires onChange, and rethrows', async () => {
  const { manager } = fakeManager({ collections: new Error('store not ready') });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });

  await assert.rejects(repo.refresh(), /store not ready/);

  assert.deepEqual(collectionsOf(repo), []);
  assert.equal(snapshots.length, 1, 'the tree heard about the failure');
  assert.deepEqual(snapshots[0], []);
  assert.deepEqual(log.errors, ['Hydration failed']);
});

// ─── COUNT(*) fan-out ──────────────────────────────────────────

test('a failed COUNT(*) for one collection does not poison the others', async () => {
  const { fake } = fakeManager({});
  const log = recordingLogger();
  // Route COUNTs per collection: `bad` rejects, `good` answers.
  const repo = new CollectionsRepository({
    getActiveConfigId: () => 'db-1',
    executeRaw: async (query: string, args?: Record<string, unknown>) => {
      fake.calls.push({ query, args });
      if (query.includes('__collections')) { return [{ _id: 'a', name: 'good' }, { _id: 'b', name: 'bad' }]; }
      if (query.startsWith('SELECT COUNT') && query.includes('`bad`')) { throw new Error('corrupt store'); }
      if (query.startsWith('SELECT COUNT')) { return [{ numDocs: 7 }]; }
      if (query.includes('system:indexes')) { return []; }
      return [];
    },
    registerStoreObserver: () => null,
  } as unknown as DittoManager, log.logger);

  await repo.load();

  const cols = collectionsOf(repo);
  assert.equal(cols.find(c => c.name === 'good')?.documentCount, 7);
  assert.equal(cols.find(c => c.name === 'bad')?.documentCount, undefined,
    'no fabricated count for the failed collection');
  assert.ok(log.warns.includes('COUNT(*) failed for collection'));
});

test('a COUNT(*) row without a numeric numDocs leaves documentCount unset', async () => {
  const { manager } = fakeManager({
    collections: [{ _id: 'a', name: 'weird' }],
    count: [{ numDocs: 'not-a-number' }],
  });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);

  await repo.load();

  assert.equal(collectionsOf(repo)[0]?.documentCount, undefined);
});

// ─── system:indexes parsing ────────────────────────────────────

test('index rows missing _id or collection are skipped with a warning', async () => {
  const { manager } = fakeManager({
    collections: [{ _id: 'a', name: 'tasks' }],
    count: [{ numDocs: 0 }],
    indexes: [
      { collection: 'tasks', fields: ['qty'] },          // no _id
      { _id: 'tasks.idx_tasks_qty', fields: ['qty'] },   // no collection
      { _id: 'tasks.idx_tasks_qty', collection: 'tasks', fields: ['qty'] },
    ],
  });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);

  await repo.load();

  const tasks = collectionsOf(repo)[0];
  assert.deepEqual(tasks?.indexes.map(i => i.displayName), ['idx_tasks_qty'], 'only the valid row survived');
  assert.equal(
    log.warns.filter(w => w === 'Skipping index row missing _id or collection').length, 2,
  );
});

test('an index id without the collection prefix falls back to the first-dot split', async () => {
  const { manager } = fakeManager({
    collections: [{ _id: 'a', name: 'app.ios' }],
    count: [{ numDocs: 0 }],
    indexes: [
      // Defensive shapes the store does not produce today: the _id lacks
      // the `<collection>.` prefix entirely.
      { _id: 'other.idx_qty', collection: 'app.ios', fields: ['qty'] },
      { _id: 'prefixless', collection: 'app.ios', fields: ['sku'] },
    ],
  });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);

  await repo.load();

  const idx = collectionsOf(repo)[0]?.indexes;
  assert.deepEqual(idx?.map(i => i.displayName), ['idx_qty', 'prefixless'],
    'dotted fallback and no-dot fallback');
});

// ─── Live observer ─────────────────────────────────────────────

test('an observer event re-hydrates from the delivered rows and fires onChange', async () => {
  const { manager, fake } = fakeManager({
    collections: [{ _id: 'a', name: 'tasks' }],
    count: [{ numDocs: 1 }],
  });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });
  await repo.load();
  assert.equal(snapshots.length, 1);

  // A sync delivers a brand-new collection; the observer rows name it, so
  // no __collections SELECT runs for the update.
  const callsBefore = fake.calls.length;
  fake.observerCb?.([{ _id: 'a', name: 'tasks' }, { _id: 'b', name: 'orders' }]);

  await waitFor(() => snapshots.length === 2);
  assert.deepEqual(collectionsOf(repo).map(c => c.name), ['orders', 'tasks']);
  assert.ok(
    !fake.calls.slice(callsBefore).some(c => c.query.includes('__collections')),
    'the observer path trusts the delivered rows instead of re-selecting',
  );
  assert.equal(collectionsOf(repo).find(c => c.name === 'orders')?.documentCount, 1);
});

test('an observer event with empty rows while the cache has data is ignored as transient', async () => {
  const { manager, fake } = fakeManager({
    collections: [{ _id: 'a', name: 'tasks' }],
    count: [{ numDocs: 1 }],
  });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });
  await repo.load();

  const callsBefore = fake.calls.length;
  fake.observerCb?.([]);
  await new Promise(r => setTimeout(r, 60));

  assert.deepEqual(collectionsOf(repo).map(c => c.name), ['tasks'], 'cache untouched');
  assert.equal(snapshots.length, 1, 'no spurious onChange');
  assert.equal(fake.calls.length, callsBefore, 'no queries ran');
  assert.ok(log.warns.some(w => w.includes('ignoring transient')));
});

test('an observer hydrate failure keeps the previous cache and warns', async () => {
  let indexesReads = 0;
  const { manager, fake } = fakeManager({
    collections: [{ _id: 'a', name: 'tasks' }],
    count: [{ numDocs: 1 }],
    // load() reads system:indexes fine; the observer-triggered read fails.
    indexes: () => {
      indexesReads += 1;
      if (indexesReads > 1) { return new Error('system:indexes vanished'); }
      return [];
    },
  });
  const log = recordingLogger();
  const repo = new CollectionsRepository(manager, log.logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });
  await repo.load();

  fake.observerCb?.([{ _id: 'a', name: 'tasks' }, { _id: 'b', name: 'orders' }]);
  await waitFor(() => log.warns.includes('Live observer hydrate failed; keeping previous cache'));

  assert.deepEqual(collectionsOf(repo).map(c => c.name), ['tasks']);
  assert.equal(snapshots.length, 1, 'no onChange for the failed update');
});

// ─── clear ─────────────────────────────────────────────────────

test('clear empties the cache, cancels the observer, and fires onChange', async () => {
  const { manager, fake } = fakeManager({ collections: [{ _id: 'a', name: 'tasks' }] });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });
  await repo.load();

  repo.clear();

  assert.deepEqual(collectionsOf(repo), []);
  assert.equal(fake.cancels, 1, 'the SDK observer was cancelled');
  assert.deepEqual(snapshots.at(-1), [], 'the tree heard the clear');
});

test('clear on an already-empty cache still fires onChange without querying', async () => {
  const { manager, fake } = fakeManager({ collections: [] });
  const repo = new CollectionsRepository(manager, recordingLogger().logger);
  const snapshots: DittoCollection[][] = [];
  repo.onChange(c => { snapshots.push(c); });
  await repo.load();
  const callsBefore = fake.calls.length;

  repo.clear();

  assert.deepEqual(snapshots.at(-1), []);
  assert.equal(fake.calls.length, callsBefore, 'no hydration ran for a clear');
});

test('a throwing observer cancel is swallowed by clear', async () => {
  const { manager } = fakeManager(
    { collections: [{ _id: 'a', name: 'tasks' }] },
    { cancelThrows: true },
  );
  const repo = new CollectionsRepository(manager, recordingLogger().logger);
  await repo.load();

  assert.doesNotThrow(() => repo.clear());
  assert.deepEqual(collectionsOf(repo), []);
});
