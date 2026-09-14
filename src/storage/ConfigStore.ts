import type { StoredDittoConfig } from '../models/DittoConfig.js';

const STORAGE_KEY = 'dittoConfigs.v1';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = () => void;

export class ConfigStore {
  private listeners = new Set<Listener>();
  /** Serializes read-modify-write ops — see {@link enqueue}. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly memento: MementoLike) {}

  list(): StoredDittoConfig[] {
    // A corrupted blob (extension crash mid-update, hand-edited state)
    // must degrade to "no configs" rather than throw out of every caller.
    // That promise has to hold at the MEMBER level too: with `[null]` stored,
    // get()/save()/delete() would throw TypeErrors on `c.id`/`c.databaseId`
    // forever, bricking the tree and making the damage unrepairable from the
    // extension itself. Malformed members are filtered out; the next write
    // persists the sanitized list.
    const raw = this.memento.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(raw)) { return []; }
    return raw.filter(
      (c): c is StoredDittoConfig =>
        typeof c === 'object' && c !== null &&
        typeof (c as StoredDittoConfig).id === 'string' &&
        typeof (c as StoredDittoConfig).databaseId === 'string',
    );
  }

  get(id: string): StoredDittoConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  save(config: StoredDittoConfig): Promise<void> {
    return this.enqueue(async () => {
      const list = this.list();
      // Reject duplicate databaseIds. Two configs pointing at the same Ditto
      // database can race for the working-directory lock and confuse users
      // about which local store is which. Mirrors how SwiftUI Edge Studio
      // treats each (name, databaseId) pair as unique. Empty databaseIds slip
      // through here — `DatabaseEditorPanel.validate()` blocks them earlier.
      const trimmed = config.databaseId.trim();
      if (trimmed) {
        const conflict = list.find(c => c.id !== config.id && c.databaseId.trim() === trimmed);
        if (conflict) {
          throw new Error(
            `A connection with Database ID "${trimmed}" already exists ("${conflict.name}"). ` +
            `Each connection must use a unique Database ID.`,
          );
        }
      }
      const idx = list.findIndex(c => c.id === config.id);
      if (idx >= 0) { list[idx] = config; } else { list.push(config); }
      await this.memento.update(STORAGE_KEY, list);
      this.fire();
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const list = this.list().filter(c => c.id !== id);
      await this.memento.update(STORAGE_KEY, list);
      this.fire();
    });
  }

  onDidChange(listener: Listener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
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

  private fire() {
    // Listener failure isolation — same idiom as AnalyzerSink.write: a
    // throwing observer must not break the walk or propagate out of
    // save/delete. This store has no logger, so swallow.
    for (const l of this.listeners) {
      try { l(); } catch { /* isolate listener failures */ }
    }
  }
}
