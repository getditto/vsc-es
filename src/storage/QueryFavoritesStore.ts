import * as vscode from 'vscode';
import * as crypto from 'node:crypto';

export interface QueryFavoriteEntry {
  id: string;
  query: string;
  savedAt: number;
}

const KEY_PREFIX = 'dittoQueryFavorites.v1.';

export class QueryFavoritesStore {
  private readonly _onChange = new vscode.EventEmitter<{ databaseId: string }>();
  readonly onChange = this._onChange.event;

  constructor(private readonly state: vscode.Memento) {}

  list(databaseId: string): QueryFavoriteEntry[] {
    return this.state.get<QueryFavoriteEntry[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async add(databaseId: string, query: string): Promise<QueryFavoriteEntry> {
    const cur = this.list(databaseId);
    const existing = cur.find(e => e.query === query);
    if (existing) return existing;
    const entry: QueryFavoriteEntry = { id: crypto.randomUUID(), query, savedAt: Date.now() };
    await this.state.update(KEY_PREFIX + databaseId, [entry, ...cur]);
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
