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

  constructor(private readonly state: vscode.Memento) {}

  list(databaseId: string): QueryHistoryEntry[] {
    return this.state.get<QueryHistoryEntry[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async add(databaseId: string, query: string): Promise<QueryHistoryEntry> {
    const entry: QueryHistoryEntry = { id: crypto.randomUUID(), query, executedAt: Date.now() };
    const cur = this.list(databaseId);
    const next = [entry, ...cur].slice(0, MAX_ENTRIES);
    await this.state.update(KEY_PREFIX + databaseId, next);
    this._onChange.fire({ databaseId });
    return entry;
  }

  async delete(databaseId: string, entryId: string): Promise<void> {
    const cur = this.list(databaseId);
    await this.state.update(KEY_PREFIX + databaseId, cur.filter(e => e.id !== entryId));
    this._onChange.fire({ databaseId });
  }

  async deleteAll(databaseId: string): Promise<void> {
    await this.state.update(KEY_PREFIX + databaseId, undefined);
    this._onChange.fire({ databaseId });
  }
}
