let tail: Promise<void> = Promise.resolve();
let pending = 0;

export function isConnectionPersistenceBusy(): boolean { return pending > 0; }

export async function waitForConnectionPersistence(): Promise<void> { await tail; }

/** Serialize operations that mutate a connection and its associated stores.
 * Operations must not call this function recursively; the lock is non-reentrant. */
export async function withConnectionPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
  pending++;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    pending--;
    release();
  }
}
