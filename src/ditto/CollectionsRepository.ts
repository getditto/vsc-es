import * as vscode from 'vscode';
import type { DittoManager } from './DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { DittoCollection, DittoIndex } from '../models/DittoCollection.js';

/** v1: manual-refresh only repo for collections + indexes under the active DB.
 *  Ports `CollectionsRepository.swift` from the SwiftUI Edge Studio app, but
 *  drops the live observer — collections/indexes are usually static and we
 *  want a simple cache here. */
export class CollectionsRepository {
  private _collections: DittoCollection[] = [];
  private readonly _changeEmitter = new vscode.EventEmitter<DittoCollection[]>();
  readonly onChange: vscode.Event<DittoCollection[]> = this._changeEmitter.event;
  private readonly log: Logger;

  constructor(
    private readonly manager: DittoManager,
    parentLogger: Logger,
  ) {
    this.log = parentLogger.withTag('ext:CollectionsRepository');
  }

  /** Synchronous reader for tree provider. */
  current(): DittoCollection[] { return this._collections; }

  /** Full reload of the cache. Idempotent — replaces the cache and fires
   *  onChange even on error (cache is left empty). */
  async load(): Promise<void> {
    await this.hydrate('load');
  }

  /** Same as load(); kept distinct so logs/callers can differentiate
   *  "auto-load on connect" vs "user clicked refresh". */
  async refresh(): Promise<void> {
    await this.hydrate('refresh');
  }

  async createIndex(collection: string, fieldName: string): Promise<void> {
    const safeField = fieldName.replace(/[. ]/g, '_');
    const indexName = `idx_${collection}_${safeField}`;
    const query = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${collection} (${fieldName})`;
    this.log.info('Creating index', { collection, fieldName, indexName });
    await this.manager.executeRaw(query);
    await this.hydrate('createIndex');
  }

  /** Empties the cache and fires onChange. Called when DB transitions to
   *  non-active. */
  clear(): void {
    if (this._collections.length === 0) {
      this._changeEmitter.fire(this._collections);
      return;
    }
    this._collections = [];
    this._changeEmitter.fire(this._collections);
  }

  // ─── private ─────────────────────────────────────────────────

  private async hydrate(reason: 'load' | 'refresh' | 'createIndex'): Promise<void> {
    this.log.info('Hydrating collections', { reason });
    try {
      // A. SELECT * FROM __collections — discover non-system collections.
      const collectionRows = await this.manager.executeRaw('SELECT * FROM __collections');
      const collections: DittoCollection[] = [];
      for (const row of collectionRows) {
        const _id = typeof row._id === 'string' ? row._id : '';
        const name = typeof row.name === 'string' ? row.name : '';
        if (!name || name.startsWith('__')) { continue; }
        collections.push({ _id, name, indexes: [] });
      }

      // B. Per-collection COUNT(*) — fan out with allSettled so one bad
      // collection doesn't poison the rest. `count` is a reserved word in
      // DQL; alias as `numDocs`.
      const countResults = await Promise.allSettled(
        collections.map(c => this.manager.executeRaw(`SELECT COUNT(*) AS numDocs FROM ${c.name}`)),
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

      // C. SELECT * FROM system:indexes — group by collection.
      const indexRows = await this.manager.executeRaw('SELECT * FROM system:indexes');
      const indexesByCollection = new Map<string, DittoIndex[]>();
      for (const row of indexRows) {
        const id = typeof row._id === 'string' ? row._id : '';
        const collection = typeof row.collection === 'string' ? row.collection : '';
        if (!id || !collection) {
          this.log.warn('Skipping index row missing _id or collection', { row });
          continue;
        }
        // Field shape #1: [{direction:'asc', key:['`fieldName`']}, …]
        // Field shape #2 (older SDK): ['fieldName', …]
        const rawFields = (row as any).fields;
        const fields: string[] = [];
        if (Array.isArray(rawFields)) {
          for (const f of rawFields) {
            if (typeof f === 'string') {
              fields.push(f.replace(/`/g, ''));
            } else if (f && typeof f === 'object') {
              const key = (f as any).key;
              if (Array.isArray(key) && key.length > 0 && typeof key[0] === 'string') {
                fields.push((key[0] as string).replace(/`/g, ''));
              }
            }
          }
        }
        const dotIdx = id.indexOf('.');
        const displayName = dotIdx >= 0 ? id.slice(dotIdx + 1) : id;
        const idx: DittoIndex = { id, collection, fields, displayName };
        const existing = indexesByCollection.get(collection);
        if (existing) { existing.push(idx); }
        else { indexesByCollection.set(collection, [idx]); }
      }
      for (const c of collections) {
        c.indexes = indexesByCollection.get(c.name) ?? [];
      }

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
}
