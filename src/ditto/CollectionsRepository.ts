import * as vscode from 'vscode';
import type { DittoManager } from './DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { DittoCollection, DittoIndex, IndexField } from '../models/DittoCollection.js';
import {
  buildCreateIndexQuery, buildDropIndexQuery, makeIndexName, normalizeIndexFields,
  parseIndexKeys, indexKeysMatch, describeIndexKeys, InvalidIndexError,
} from './index-builder.js';
import { quoteIdentifier } from './dql-identifier.js';

/**
 * Cache of collections (with counts + indexes) for the active database.
 *
 * Hydration runs in two stages:
 *
 *   1. **Initial load** — runs `SELECT * FROM __collections`, fans out
 *      `COUNT(*)` per collection, then loads indexes from
 *      `system:indexes`. Fired by `load()` on lifecycle-active.
 *   2. **Live observer** — registers a store observer on the same
 *      `__collections` query so the cache updates automatically when
 *      synced data introduces (or removes) a collection. Without this
 *      the user has to disconnect/reconnect or manually refresh after
 *      every new subscription before its collection appears in the
 *      tree. Mirrors `CollectionsRepository.swift` from the SwiftUI
 *      Edge Studio app — same call shape, same dematerialize pattern.
 *
 * `refresh()` is the user's manual override (e.g. the inline refresh
 * codicon on each collection row); it re-runs hydration but doesn't
 * restart the observer.
 */
export class CollectionsRepository {
  private _collections: DittoCollection[] = [];
  private readonly _changeEmitter = new vscode.EventEmitter<DittoCollection[]>();
  readonly onChange: vscode.Event<DittoCollection[]> = this._changeEmitter.event;
  private readonly log: Logger;
  private collectionsObserver?: { cancel(): void } | undefined;

  constructor(
    private readonly manager: DittoManager,
    parentLogger: Logger,
  ) {
    this.log = parentLogger.withTag('ext:CollectionsRepository');
  }

  /** Synchronous reader for tree provider. */
  current(): DittoCollection[] { return this._collections; }

  /** Initial cache load + start the live observer. Fired on lifecycle-active.
   *  Never rejects: a transient hydrate failure must not skip the observer —
   *  it is what heals the cache once the store recovers, and skipping it
   *  leaves collections dead for the whole session (nothing re-invokes
   *  load()). */
  async load(): Promise<void> {
    try {
      await this.hydrate('load');
    } catch {
      // Already logged + cache emptied inside hydrate(); the rethrow exists
      // for the manual refresh command's error surface, not for this path.
    }
    this.startObserver();
  }

  /** Manual re-hydrate (e.g. user clicked the refresh icon). Doesn't
   *  restart the observer — that lives across the whole session. */
  async refresh(): Promise<void> {
    await this.hydrate('refresh');
  }

  /** Result of {@link createIndex} — the generated index name is included so
   *  automation callers (the MCP create_index tool) can drop/manage the index
   *  without a list_indexes round-trip to learn what it was called.
   *
   *  Outcome semantics —
   * Create an index over one or more fields. More than one field produces a
   * composite index (SDK 5.1+); their order is preserved because the optimizer
   * only uses a composite index from its leading key onwards.
   *
   * `outcome` is 'created' when the DDL ran, 'already-exists' when an
   * equivalent index was already present. `IF NOT EXISTS` compares index NAMES
   * only, so the pre-check against system:indexes is what makes this
   * distinction (and the same-name/different-definition conflict) observable.
   */
  async createIndex(
    collection: string,
    fields: readonly IndexField[],
  ): Promise<{ outcome: 'created' | 'already-exists'; name: string }> {
    const cleaned = normalizeIndexFields(fields);
    const indexName = makeIndexName(collection, cleaned);

    // Mid-switch guard: the switch orchestrator closes the Add Index
    // panel but cannot cancel an in-flight createIndex, and every
    // executeRaw call resolves against the CURRENT session. Snapshot the
    // active config id at entry and re-check it right before the CREATE
    // runs so a switch between the system:indexes probe and the write
    // fails loudly instead of creating the index on the new database.
    const activeAtEntry = this.readActiveConfigId();

    // `IF NOT EXISTS` compares index NAMES only, so an existing index with the
    // same generated name but a different definition — a flipped direction, or
    // a different field that sanitized to the same name — makes the statement
    // silently succeed while changing nothing. Detect that instead of letting
    // the user believe their new definition took effect.
    const existing = await this.manager.executeRaw(
      'SELECT * FROM system:indexes WHERE _id = :id',
      { id: `${collection}.${indexName}` },
    );
    const firstExisting = existing[0];
    if (firstExisting) {
      const existingKeys = parseIndexKeys(firstExisting.fields);
      if (indexKeysMatch(existingKeys, cleaned)) {
        this.log.info('Index already exists with the same definition', { collection, indexName });
        return { outcome: 'already-exists', name: indexName };
      }
      throw new InvalidIndexError(
        `An index named "${indexName}" already exists on "${collection}" with a different `
        + `definition (${describeIndexKeys(existingKeys)}). Delete it before re-creating.`,
      );
    }

    this.assertStillActive(activeAtEntry);

    const query = buildCreateIndexQuery(collection, cleaned, indexName);
    this.log.info('Creating index', {
      collection, indexName, keys: describeIndexKeys(cleaned),
    });
    await this.manager.executeRaw(query);
    await this.hydrate('createIndex');
    return { outcome: 'created', name: indexName };
  }

  /**
   * Fresh lookup of every index whose DISPLAY name (the `_id` minus its
   * "<collection>." prefix) equals `displayName`, optionally narrowed to
   * one collection. Reads `system:indexes` live — the cache in
   * `current()` would answer the same question only for the hydrated
   * collections and can lag a DDL statement issued out-of-band (e.g. by
   * an MCP create_index earlier in the same agent conversation).
   *
   * Used by the MCP drop_index tool to reproduce the SwiftUI server's
   * ambiguity rule: a bare name that exists on multiple collections must
   * be rejected unless the caller passes `collection`, because DROP's
   * target would otherwise be ambiguous.
   */
  async findIndexesByDisplayName(displayName: string, collection?: string): Promise<DittoIndex[]> {
    const rows = await this.manager.executeRaw('SELECT * FROM system:indexes');
    const matches: DittoIndex[] = [];
    for (const row of rows) {
      const idx = parseSystemIndexRow(row);
      if (!idx || idx.displayName !== displayName) { continue; }
      if (collection !== undefined && idx.collection !== collection) { continue; }
      matches.push(idx);
    }
    return matches;
  }

  /** Drops an index by its bare name + collection. DQL requires the
   *  collection because the bare name isn't globally unique — two
   *  collections can each have an `idx_done` index. We use the
   *  `<name> ON <collection>` form (matches the CREATE INDEX shape);
   *  the equivalent `<collection>.<name>` form would also work.
   *  Re-hydrates so the tree updates immediately. */
  async dropIndex(indexName: string, collection: string): Promise<void> {
    const query = buildDropIndexQuery(indexName, collection);
    this.log.info('Dropping index', { indexName, collection });
    await this.manager.executeRaw(query);
    await this.hydrate('dropIndex');
  }

  /** Empties the cache, cancels the observer, and fires onChange. Called
   *  when DB transitions to non-active. */
  clear(): void {
    this.stopObserver();
    if (this._collections.length === 0) {
      this._changeEmitter.fire(this._collections);
      return;
    }
    this._collections = [];
    this._changeEmitter.fire(this._collections);
  }

  // ─── private ─────────────────────────────────────────────────

  /** The currently-active config id, or undefined when the manager
   *  cannot tell (unit-test fakes only forward executeRaw). A null/
   *  empty value is treated as "no session" and bubbles down through
   *  the natural executeRaw failure — the guard only defends against
   *  a switch BETWEEN two known sessions. */
  private readActiveConfigId(): string | null | undefined {
    return typeof this.manager.getActiveConfigId === 'function'
      ? this.manager.getActiveConfigId()
      : undefined;
  }

  /** Throw if the active config changed away from `expected` since it
   *  was snapshotted. No-op when either side is unknown. */
  private assertStillActive(expected: string | null | undefined): void {
    if (!expected) { return; }
    const current = this.readActiveConfigId();
    if (current !== undefined && current !== expected) {
      throw new Error('The active connection changed mid-index-operation; index not created. Reopen the panel and try again.');
    }
  }

  /**
   * Subscribe to live `__collections` updates. Re-entrant — if an
   * observer is already attached, this is a no-op so calling load()
   * twice doesn't leak.
   */
  private startObserver(): void {
    if (this.collectionsObserver) {
      this.log.info('Observer already attached — skipping');
      return;
    }
    const handle = this.manager.registerStoreObserver(
      'SELECT * FROM __collections',
      (rows) => { void this.onCollectionsRowsChanged(rows); },
    );
    if (!handle) {
      this.log.warn('No active session — collections observer not registered');
      return;
    }
    this.collectionsObserver = handle;
    this.log.info('Live __collections observer attached');
  }

  private stopObserver(): void {
    if (!this.collectionsObserver) { return; }
    try { this.collectionsObserver.cancel(); } catch { /* ignore */ }
    this.collectionsObserver = undefined;
    this.log.info('Live __collections observer cancelled');
  }

  /**
   * Observer callback. The SDK already gave us the new `__collections`
   * rows, so we skip the SELECT and only fan out counts + indexes.
   * Failures are non-fatal — the cache stays at its previous state and
   * a warning logs. Fires onChange so the tree picks up new collections
   * without a manual refresh.
   *
   * NOTE: defensive guard against the observer firing with empty rows
   * while the cache has data — that would clear the tree and is almost
   * certainly an SDK transient (e.g. mid-write). Logged so it's
   * obvious if this happens in practice.
   */
  private async onCollectionsRowsChanged(rows: Record<string, unknown>[]): Promise<void> {
    this.log.info('Observer fired', { rowCount: rows.length, cachedCount: this._collections.length });
    if (rows.length === 0 && this._collections.length > 0) {
      this.log.warn('Observer fired with empty rows but cache has data — ignoring transient');
      return;
    }
    try {
      const collections = rowsToCollections(rows);
      await this.attachCountsAndIndexes(collections);
      collections.sort((a, b) => a.name.localeCompare(b.name));
      this._collections = collections;
      this.log.info('Live observer: collections updated', { count: collections.length });
      this._changeEmitter.fire(this._collections);
    } catch (err) {
      this.log.warn('Live observer hydrate failed; keeping previous cache', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async hydrate(reason: 'load' | 'refresh' | 'createIndex' | 'dropIndex'): Promise<void> {
    this.log.info('Hydrating collections', { reason });
    try {
      // A. SELECT * FROM __collections — discover non-system collections.
      const collectionRows = await this.manager.executeRaw('SELECT * FROM __collections');
      const collections = rowsToCollections(collectionRows);

      // B. + C. Fan out counts and indexes — extracted so the observer
      // path can reuse them without re-running the __collections SELECT.
      await this.attachCountsAndIndexes(collections);

      collections.sort((a, b) => a.name.localeCompare(b.name));
      this._collections = collections;
      this.log.info('Hydration complete', { count: collections.length, reason });
    } catch (err) {
      this.log.error('Hydration failed', {
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
      this._collections = [];
      // Re-throw so the caller (refresh command) can surface the error.
      this._changeEmitter.fire(this._collections);
      throw err;
    }
    this._changeEmitter.fire(this._collections);
  }

  /**
   * Per-collection COUNT(*) + system:indexes load. Mutates `collections`
   * in place so the caller can sort + cache the result. Used by both
   * `hydrate` (initial + manual refresh) and `onCollectionsRowsChanged`
   * (live observer path).
   */
  private async attachCountsAndIndexes(collections: DittoCollection[]): Promise<void> {
    if (collections.length === 0) {
      // Nothing to count or index — but we still want to clear stale
      // index data, so we just skip the queries and return.
      return;
    }

    // Per-collection COUNT(*) — fan out with allSettled so one bad
    // collection doesn't poison the rest. `count` is a reserved word in
    // DQL; alias as `numDocs`.
    const countResults = await Promise.allSettled(
      collections.map(c => this.manager.executeRaw(
        `SELECT COUNT(*) AS numDocs FROM ${quoteIdentifier(c.name, 'collection')}`,
      )),
    );
    countResults.forEach((res, i) => {
      const c = collections[i];
      if (!c) { return; }
      if (res.status === 'fulfilled') {
        const first = res.value[0];
        const n = first?.numDocs;
        if (typeof n === 'number') { c.documentCount = n; }
      } else {
        this.log.warn('COUNT(*) failed for collection', {
          collection: c.name,
          err: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    });

    // SELECT * FROM system:indexes — group by collection.
    const indexRows = await this.manager.executeRaw('SELECT * FROM system:indexes');
    const indexesByCollection = new Map<string, DittoIndex[]>();
    for (const row of indexRows) {
      const idx = parseSystemIndexRow(row);
      if (!idx) {
        this.log.warn('Skipping index row missing _id or collection', { row });
        continue;
      }
      const existing = indexesByCollection.get(idx.collection);
      if (existing) { existing.push(idx); }
      else { indexesByCollection.set(idx.collection, [idx]); }
    }
    for (const c of collections) {
      c.indexes = indexesByCollection.get(c.name) ?? [];
    }
  }
}


/** Pure parser for a `system:indexes` row into a `DittoIndex`. Returns
 *  `undefined` if the row is missing required fields so the caller can
 *  log + skip. */
function parseSystemIndexRow(row: Record<string, unknown>): DittoIndex | undefined {
  const id = typeof row._id === 'string' ? row._id : '';
  const collection = typeof row.collection === 'string' ? row.collection : '';
  if (!id || !collection) { return undefined; }

  const fields = parseIndexKeys(row.fields);

  // Strip the collection prefix to get the display name — NOT the first
  // dot. A dotted collection name (`app.ios`) puts its own dot first, and
  // splitting there turned `app.ios.idx_name` into `ios.idx_name`, which
  // broke both the tree display and the DROP INDEX the delete flow builds
  // from the display name. Fall back to the first-dot split only if the id
  // doesn't carry the collection prefix at all (defensive — the store
  // always prefixes today).
  const displayName = id.startsWith(`${collection}.`)
    ? id.slice(collection.length + 1)
    : (() => {
      const dotIdx = id.indexOf('.');
      return dotIdx >= 0 ? id.slice(dotIdx + 1) : id;
    })();
  return { id, collection, fields, displayName };
}

/** Decode `__collections` rows → `DittoCollection[]`, filtering out
 *  system collections. Pure, used from both the initial SELECT and the
 *  live observer. */
function rowsToCollections(rows: Record<string, unknown>[]): DittoCollection[] {
  const out: DittoCollection[] = [];
  for (const row of rows) {
    const _id = typeof row._id === 'string' ? row._id : '';
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name || name.startsWith('__')) { continue; }
    out.push({ _id, name, indexes: [] });
  }
  return out;
}
