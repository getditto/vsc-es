import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

export interface QueryHistoryEntry {
  id: string;
  query: string;
  executedAt: number;
}

const KEY_PREFIX = 'dittoQueryHistory.v1.';
const MAX_ENTRIES = 50;

export class QueryHistoryStore {
  private readonly _onChange = new vscode.EventEmitter<{ databaseId: string }>();
  readonly onChange = this._onChange.event;
  /** Serializes read-modify-write ops — see {@link enqueue}. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {}

  list(databaseId: string): QueryHistoryEntry[] {
    return this.state.get<QueryHistoryEntry[]>(KEY_PREFIX + databaseId) ?? [];
  }

  /**
   * Adds a query to history. Mirrors the SwiftUI `HistoryRepository` dedup rule:
   * if the same query string already exists, drop the older row and insert the
   * fresh one with a new id + timestamp at the top. Same query never appears
   * twice; re-running an old query bubbles it back to position 0.
   */
  add(databaseId: string, query: string): Promise<QueryHistoryEntry> {
    return this.enqueue(async () => {
      const entry: QueryHistoryEntry = { id: crypto.randomUUID(), query, executedAt: Date.now() };
      const cur = this.list(databaseId).filter(e => e.query !== query);
      const next = [entry, ...cur].slice(0, MAX_ENTRIES);
      await this.state.update(KEY_PREFIX + databaseId, next);
      this._onChange.fire({ databaseId });
      return entry;
    });
  }

  delete(databaseId: string, entryId: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = this.list(databaseId);
      await this.state.update(KEY_PREFIX + databaseId, cur.filter(e => e.id !== entryId));
      this._onChange.fire({ databaseId });
    });
  }

  deleteAll(databaseId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.state.update(KEY_PREFIX + databaseId, undefined);
      this._onChange.fire({ databaseId });
    });
  }

  /**
   * Run `op` after every previously-queued write. Callers routinely
   * fire-and-forget (`void store.add(...)`), so without serialization two
   * overlapping read-modify-write cycles can each read the pre-state and
   * the later update loses the earlier one's write.
   *
   * The stored tail swallows rejections: the caller still sees its op's
   * error on the returned promise, but one failed op must not wedge every
   * op queued after it.
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
