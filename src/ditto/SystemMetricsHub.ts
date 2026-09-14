import type { DittoManager } from './DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { SystemMetricsStatus } from '../ipc/messages.js';
import { SystemMetricsService } from './SystemMetricsService.js';

/**
 * Per-connection ownership of SystemMetricsService instances.
 *
 * system:metrics reads FLUSH the SDK registry (delta semantics), so two
 * independent accumulators race: whichever reader polls second misses the
 * window the first consumed. Before this hub the System Metrics panel was
 * the only reader; the MCP get_system_metrics tool needs the SAME numbers
 * without perturbing the panel's totals, which only a shared accumulator
 * gives. Panels and the MCP layer therefore ask the hub for the per-
 * connection service instead of constructing their own.
 *
 * Consumers poll at their own cadence:
 *  - The panel wants a 5 s timer while visible (hub handle: paused off).
 *  - The MCP tool wants NO timer — each tool call does an on-demand
 *    pollOnce and the shared accumulator folds the deltas into the
 *    since-connect totals correctly regardless of who reads when.
 *
 * The hub owns the aggregate timer decision: ticking while ANY consumer
 * is unpaused. Accumulated samples live until disposeFor(configId)
 * (called on lifecycle teardown) so hiding the panel keeps totals.
 */
export interface SystemMetricsHandle {
  readonly service: SystemMetricsService;
  /** Timer off, samples kept (panel hidden). */
  pause(): void;
  /** Timer on (panel visible). Starts unpaused. */
  resume(): void;
  /** Consumer gone. Samples persist while other consumers remain. */
  dispose(): void;
}

interface HubEntry {
  service: SystemMetricsService;
  consumers: Set<ConsumerRecord>;
}

interface ConsumerRecord {
  onStatus?: ((s: SystemMetricsStatus) => void) | undefined;
  paused: boolean;
}

export class SystemMetricsHub {
  private readonly entries = new Map<string, HubEntry>();

  constructor(
    private readonly manager: DittoManager,
    private readonly logger: Logger,
  ) {}

  /** Number of live entries (test introspection). */
  get size(): number { return this.entries.size; }

  /** The shared service for a connection — for one-off pollOnce callers
   *  that don't need callbacks (MCP tool). Starts no timer. */
  serviceFor(configId: string): SystemMetricsService | undefined {
    return this.entries.get(configId)?.service;
  }

  /**
   * MCP-side hold: ensure a shared service exists WITHOUT starting its
   * timer. The tool polls on demand per call. Idempotent.
   */
  acquireForToolCalls(configId: string): SystemMetricsService {
    return this.ensureEntry(configId).service;
  }

  /** Panel-side acquisition: fan-out status callback + ref-counted,
   *  pauseable timer participation. Starts UNPAUSED (matching the
   *  historical "opening visible panel starts polling" behaviour). */
  acquire(configId: string, onStatus: (s: SystemMetricsStatus) => void): SystemMetricsHandle {
    const entry = this.ensureEntry(configId);
    const consumer: ConsumerRecord = { onStatus, paused: false };
    entry.consumers.add(consumer);
    this.updateTimer(entry);
    const service = entry.service;
    let disposed = false;
    return {
      service,
      pause: () => {
        if (disposed) { return; }
        consumer.paused = true;
        this.updateTimer(entry);
      },
      resume: () => {
        if (disposed) { return; }
        consumer.paused = false;
        this.updateTimer(entry);
      },
      dispose: () => {
        if (disposed) { return; }
        disposed = true;
        entry.consumers.delete(consumer);
        // The ENTRY (and its accumulator) survives until lifecycle teardown
        // — closing/reopening the panel must not reset since-connect totals.
        this.updateTimer(entry);
      },
    };
  }

  /** Teardown for one connection (lifecycle leaving 'active'). */
  disposeFor(configId: string): void {
    const entry = this.entries.get(configId);
    if (!entry) { return; }
    entry.service.stop();
    this.entries.delete(configId);
  }

  dispose(): void {
    for (const key of [...this.entries.keys()]) { this.disposeFor(key); }
  }

  private ensureEntry(configId: string): HubEntry {
    const existing = this.entries.get(configId);
    if (existing) { return existing; }
    const consumers = new Set<ConsumerRecord>();
    const service = new SystemMetricsService(this.manager, this.logger, {
      isExpectedActive: () => this.manager.getActiveConfigId() === configId,
      onStatus: (status) => {
        for (const c of consumers) {
          try { c.onStatus?.(status); } catch { /* one consumer must not break others */ }
        }
      },
    });
    const entry: HubEntry = { service, consumers };
    this.entries.set(configId, entry);
    return entry;
  }

  private updateTimer(entry: HubEntry): void {
    const anyActive = [...entry.consumers].some(c => !c.paused);
    if (anyActive) { entry.service.start(); }
    else { entry.service.stop(); }
  }
}
