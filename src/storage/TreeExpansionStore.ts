/**
 * Per-database persisted set of "currently expanded" tree node IDs.
 *
 * VS Code's TreeView API exposes `onDidExpandElement`/`onDidCollapseElement`
 * events but no way to ask "is this element expanded?", so we track our
 * own model. On lifecycle-active for a DB the consumer reads the list
 * and reveals each node; reveals on now-missing nodes are silent no-ops.
 *
 * Stored per-DB so connections can re-grow their UI back to exactly the
 * shape the user left them in, and so that deleting a connection wipes
 * its expansion preferences with the rest of its state.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY_PREFIX = 'dittoTreeExpansion.v1.';

export class TreeExpansionStore {
  /** Serializes read-modify-write ops — see {@link enqueue}. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly memento: MementoLike) {}

  /** All currently-tracked expanded node IDs for this database. */
  list(databaseId: string): string[] {
    return this.memento.get<string[]>(KEY_PREFIX + databaseId) ?? [];
  }

  /** Mark a node id as expanded. Idempotent. */
  add(databaseId: string, nodeId: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = this.list(databaseId);
      if (cur.includes(nodeId)) { return; }
      const next = [...cur, nodeId];
      await this.memento.update(KEY_PREFIX + databaseId, next);
    });
  }

  /** Remove a node id from the expanded set. Idempotent. */
  remove(databaseId: string, nodeId: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = this.list(databaseId);
      if (!cur.includes(nodeId)) { return; }
      const next = cur.filter(id => id !== nodeId);
      await this.memento.update(KEY_PREFIX + databaseId, next);
    });
  }

  /** Drop every expansion record for this database. Used by the
   *  delete-connection handler so deleted DBs don't leave orphan keys. */
  clearAll(databaseId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.memento.update(KEY_PREFIX + databaseId, undefined);
    });
  }

  /**
   * Run `op` after every previously-queued write. The expand/collapse
   * event handlers fire-and-forget (`void store.add(...)`), so without
   * serialization a rapid expand/collapse burst — including the
   * programmatic reveal loop in the restore path — can interleave two
   * read-modify-write cycles whose later update loses the earlier one's
   * node. Same contract and shape as the sibling stores
   * (ConfigStore/SubscriptionStore/ObserverStore/QueryHistoryStore).
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
