import type { StoredObserver } from '../models/StoredObserver.js';
import type { MementoLike } from './SubscriptionStore.js';

const KEY_PREFIX = 'dittoObservers.v1.';

type Listener = (databaseId: string) => void;

/** Per-database persistence for observer metadata. Mirrors
 *  `SubscriptionStore` exactly — same memento shape, same firing
 *  semantics — so the tree provider's listener pattern carries over
 *  unchanged. Live SDK observers are NOT stored here; see
 *  `StoredObserver`'s doc comment. */
export class ObserverStore {
  private listeners = new Set<Listener>();
  constructor(private readonly memento: MementoLike) {}

  list(databaseId: string): StoredObserver[] {
    return this.memento.get<StoredObserver[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async save(databaseId: string, observer: StoredObserver): Promise<void> {
    const list = this.list(databaseId);
    const idx = list.findIndex(o => o.id === observer.id);
    if (idx >= 0) { list[idx] = observer; } else { list.push(observer); }
    await this.memento.update(KEY_PREFIX + databaseId, list);
    this.fire(databaseId);
  }

  async delete(databaseId: string, id: string): Promise<void> {
    const list = this.list(databaseId).filter(o => o.id !== id);
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

  private fire(databaseId: string): void {
    for (const l of this.listeners) { l(databaseId); }
  }
}
