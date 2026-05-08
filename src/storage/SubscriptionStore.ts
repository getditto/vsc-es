import type { StoredSubscription } from '../models/DittoConfig.js';

const KEY_PREFIX = 'dittoSubscriptions.v1.';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = (databaseId: string) => void;

export class SubscriptionStore {
  private listeners = new Set<Listener>();
  constructor(private readonly memento: MementoLike) {}

  list(databaseId: string): StoredSubscription[] {
    return this.memento.get<StoredSubscription[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async save(databaseId: string, sub: StoredSubscription): Promise<void> {
    const list = this.list(databaseId);
    const idx = list.findIndex(s => s.id === sub.id);
    if (idx >= 0) { list[idx] = sub; } else { list.push(sub); }
    await this.memento.update(KEY_PREFIX + databaseId, list);
    this.fire(databaseId);
  }

  async delete(databaseId: string, id: string): Promise<void> {
    const list = this.list(databaseId).filter(s => s.id !== id);
    await this.memento.update(KEY_PREFIX + databaseId, list);
    this.fire(databaseId);
  }

  async deleteAll(databaseId: string): Promise<void> {
    await this.memento.update(KEY_PREFIX + databaseId, []);
    this.fire(databaseId);
  }

  onDidChange(l: Listener): { dispose: () => void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }

  private fire(databaseId: string) { for (const l of this.listeners) { l(databaseId); } }
}
