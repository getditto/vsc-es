import type { StoredSubscription } from '../models/DittoConfig.js';

const KEY_PREFIX = 'dittoSubscriptions.v1.';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = (databaseId: string) => void;

export class SubscriptionStore {
  private listeners = new Set<Listener>();
  /** Serializes read-modify-write ops — see {@link enqueue}. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly memento: MementoLike) {}

  list(databaseId: string): StoredSubscription[] {
    return this.memento.get<StoredSubscription[]>(KEY_PREFIX + databaseId) ?? [];
  }

  save(databaseId: string, sub: StoredSubscription): Promise<void> {
    return this.enqueue(async () => {
      const list = this.list(databaseId);
      const idx = list.findIndex(s => s.id === sub.id);
      if (idx >= 0) { list[idx] = sub; } else { list.push(sub); }
      await this.memento.update(KEY_PREFIX + databaseId, list);
      this.fire(databaseId);
    });
  }

  delete(databaseId: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      const list = this.list(databaseId).filter(s => s.id !== id);
      await this.memento.update(KEY_PREFIX + databaseId, list);
      this.fire(databaseId);
    });
  }

  deleteAll(databaseId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.memento.update(KEY_PREFIX + databaseId, []);
      this.fire(databaseId);
    });
  }

  onDidChange(l: Listener): { dispose: () => void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }

  /**
   * Run `op` after every previously-queued write. Callers routinely
   * fire-and-forget (`void store.save(...)`), so without serialization two
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

  private fire(databaseId: string) {
    // Listener failure isolation — same idiom as AnalyzerSink.write: a
    // throwing observer must not break the walk or propagate out of
    // save/delete. This store has no logger, so swallow.
    for (const l of this.listeners) {
      try { l(databaseId); } catch { /* isolate listener failures */ }
    }
  }
}
