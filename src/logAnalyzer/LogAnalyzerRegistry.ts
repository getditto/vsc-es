/** Start contract the registry drives; LogAnalyzerService satisfies it
 *  structurally (kept as a minimal interface so unit tests can use plain
 *  fakes). */
export interface StartableAnalyzer {
  start(p: { backfillLines?: readonly string[]; minTimestamp?: Date | undefined }): void;
  dispose(): void;
}

/**
 * Per-connection registry of MCP-owned LogAnalyzerService instances.
 *
 * Single-flight: two concurrent `open()` calls for the same connection
 * share ONE in-flight promise. The naive get→await→set shape let a second
 * caller pass the `get` miss while the first was still awaiting its
 * backfill read; both services `start()`ed (each attaching a live
 * `sink.onLine` subscription), and the second `set` orphaned the first
 * service where disconnect teardown — which only reaches the map's
 * contents — could never dispose it. Each orphan pattern-matched every
 * extension log line for the rest of the host's life.
 *
 * Stale-open guard: a disconnect (`disposeAll()`) landing while an open is
 * awaiting its backfill invalidates the open (generation bump). The
 * resumed open disposes the never-started service and rejects instead of
 * resurrecting an analyzer into the freshly-cleared map, where it would
 * serve lines from the previous session with no connect-time backfill
 * floor.
 */
export class LogAnalyzerRegistry<S extends StartableAnalyzer> {
  private readonly services = new Map<string, Promise<S>>();
  private generation = 0;

  constructor(
    private readonly make: () => S,
    private readonly readBackfill: () => Promise<readonly string[]>,
    private readonly connectTimestamp: (configId: string) => Date | undefined,
    private readonly isConnected: (configId: string) => boolean,
  ) {}

  /** Returns the live (or in-flight) analyzer for the connection; creates
   *  it on first use. Rejects when the connection dropped mid-open. */
  open(configId: string): Promise<S> {
    const existing = this.services.get(configId);
    if (existing) { return existing; }
    const generation = this.generation;
    const pending = (async (): Promise<S> => {
      const service = this.make();
      const backfill = await this.readBackfill();
      if (generation !== this.generation || !this.isConnected(configId)) {
        // Discard BEFORE start(): starting is what takes the sink
        // subscription that would otherwise leak past teardown.
        service.dispose();
        throw new Error('The database disconnected while the Log Analyzer was opening.');
      }
      service.start({ backfillLines: backfill, minTimestamp: this.connectTimestamp(configId) });
      return service;
    })();
    this.services.set(configId, pending);
    // A failed open must not poison the cache — the next caller retries
    // with a fresh service.
    pending.catch(() => {
      if (this.services.get(configId) === pending) { this.services.delete(configId); }
    });
    return pending;
  }

  /** Dispose every analyzer and invalidate any open still in flight. */
  disposeAll(): void {
    this.generation++;
    const entries = [...this.services.values()];
    this.services.clear();
    for (const p of entries) {
      void p.then(
        (service) => service.dispose(),
        () => { /* a failed/stale open holds no resources */ },
      );
    }
  }
}
