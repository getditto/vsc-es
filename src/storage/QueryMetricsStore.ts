import * as vscode from 'vscode';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';

/**
 * One captured Query Metrics record. Identical shape to
 * QueryResultMetadata except for the stable `id` we mint at capture
 * time so the panel's record list can `keyBy` cleanly across
 * re-renders.
 */
export interface QueryMetricRecord extends QueryResultMetadata {
  id: string;
}

/**
 * Per-database ring buffer of executed-query metrics. Lives entirely
 * in memory — matches the SwiftUI Edge Studio's QueryMetricsRepository
 * actor (no persistence; history is lost on extension reload). 200
 * records per DB matches SwiftUI; beyond that we drop the oldest.
 *
 * Per-DB scoping (rather than global) so switching connections doesn't
 * mix histories that the user wouldn't be able to disambiguate.
 */
export class QueryMetricsStore {
  /** Cap matches SwiftUI's QueryMetricsRepository.maxRecords. Picked
   *  to balance "enough to compare a few recent runs" with "doesn't
   *  hold onto EXPLAIN JSON forever." */
  static readonly MAX_RECORDS = 200;

  private readonly byDb = new Map<string, QueryMetricRecord[]>();
  private readonly _onChange = new vscode.EventEmitter<{ databaseId: string }>();
  readonly onChange = this._onChange.event;

  /** Append a captured query's metrics to the DB's buffer. Mints the
   *  stable `id`. Oldest records are dropped past MAX_RECORDS. */
  capture(databaseId: string, metadata: QueryResultMetadata): void {
    const buf = this.byDb.get(databaseId) ?? [];
    const record: QueryMetricRecord = { id: cryptoRandomId(), ...metadata };
    // Newest goes to the front so the list is "most-recent first"
    // without an extra reverse() at read time.
    buf.unshift(record);
    if (buf.length > QueryMetricsStore.MAX_RECORDS) {
      buf.length = QueryMetricsStore.MAX_RECORDS;
    }
    this.byDb.set(databaseId, buf);
    this._onChange.fire({ databaseId });
  }

  /** Newest-first snapshot of the records for one DB. */
  list(databaseId: string): QueryMetricRecord[] {
    return this.byDb.get(databaseId) ?? [];
  }

  /** Drop every record for one DB (Clear button). */
  clear(databaseId: string): void {
    if (!this.byDb.has(databaseId)) { return; }
    this.byDb.delete(databaseId);
    this._onChange.fire({ databaseId });
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
