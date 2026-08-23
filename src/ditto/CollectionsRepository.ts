import * as vscode from 'vscode';
import type { DittoManager } from './DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { DittoCollection, DittoIndex } from '../models/DittoCollection.js';
import { quoteIdentifier, quoteFieldPath } from './dql-identifier.js';

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
  private collectionsObserver?: { cancel(): void };

  constructor(
    private readonly manager: DittoManager,
    parentLogger: Logger,
  ) {
    this.log = parentLogger.withTag('ext:CollectionsRepository');
  }

  /** Synchronous reader for tree provider. */
  current(): DittoCollection[] { return this._collections; }

  /** Initial cache load + start the live observer. Fired on lifecycle-active. */
  async load(): Promise<void> {
    await this.hydrate('load');
    this.startObserver();
  }

  /** Manual re-hydrate (e.g. user clicked the refresh icon). Doesn't
   *  restart the observer — that lives across the whole session. */
  async refresh(): Promise<void> {
    await this.hydrate('refresh');
  }

  async createIndex(collection: string, fieldName: string): Promise<void> {
    // DQL has no bind parameters for identifiers, so these are concatenated
    // into the statement. Backtick-quote rather than restrict the character
    // set: a collection named `order-items` is perfectly legal in Ditto, and
    // rejecting it would lock the user out of indexing it entirely.
    const safeField = fieldName.replace(/[. ]/g, '_');
    const indexName = `idx_${collection}_${safeField}`;
    const query = `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName, 'index')} `
      + `ON ${quoteIdentifier(collection, 'collection')} (${quoteFieldPath(fieldName)})`;
    this.log.info('Creating index', { collection, fieldName, indexName });
    await this.manager.executeRaw(query);
    await this.hydrate('createIndex');
  }

  /** Drops an index by its bare name + collection. DQL requires the
   *  collection because the bare name isn't globally unique — two
   *  collections can each have an `idx_done` index. We use the
   *  `<name> ON <collection>` form (matches the CREATE INDEX shape);
   *  the equivalent `<collection>.<name>` form would also work.
   *  Re-hydrates so the tree updates immediately. */
  async dropIndex(indexName: string, collection: string): Promise<void> {
    const query = `DROP INDEX IF EXISTS ${quoteIdentifier(indexName, 'index')} `
      + `ON ${quoteIdentifier(collection, 'collection')}`;
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
      if (res.status === 'fulfilled') {
        const first = res.value[0];
        const n = first?.numDocs;
        if (typeof n === 'number') { collections[i].documentCount = n; }
      } else {
        this.log.warn('COUNT(*) failed for collection', {
          collection: collections[i].name,
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

/** Shape of a row from `SELECT * FROM system:indexes`. Two field shapes
 *  exist in the wild:
 *   - Newer SDK: `[{ direction: 'asc', key: ['`fieldName`'] }, …]`
 *   - Older SDK: `['fieldName', …]`
 *
 *  Everything is typed as `unknown` because the SDK doesn't expose a
 *  declarative type for system rows. `parseSystemIndexRow` does the
 *  runtime narrowing in one place. */
interface SystemIndexFieldDescriptor {
  direction?: string;
  key?: unknown[];
}

/** Pure parser for a `system:indexes` row into a `DittoIndex`. Returns
 *  `undefined` if the row is missing required fields so the caller can
 *  log + skip. */
function parseSystemIndexRow(row: Record<string, unknown>): DittoIndex | undefined {
  const id = typeof row._id === 'string' ? row._id : '';
  const collection = typeof row.collection === 'string' ? row.collection : '';
  if (!id || !collection) { return undefined; }

  const rawFields = row.fields;
  const fields: string[] = [];
  if (Array.isArray(rawFields)) {
    for (const f of rawFields) {
      if (typeof f === 'string') {
        fields.push(f.replace(/`/g, ''));
      } else if (f && typeof f === 'object' && !Array.isArray(f)) {
        const desc = f as SystemIndexFieldDescriptor;
        const key = desc.key;
        if (Array.isArray(key) && key.length > 0 && typeof key[0] === 'string') {
          fields.push(key[0].replace(/`/g, ''));
        }
      }
    }
  }

  const dotIdx = id.indexOf('.');
  const displayName = dotIdx >= 0 ? id.slice(dotIdx + 1) : id;
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
