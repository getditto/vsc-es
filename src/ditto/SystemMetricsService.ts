import * as vscode from 'vscode';
import type { Logger } from '../logging/types.js';
import type {
  SystemMetricSample,
  SystemMetricsSnapshot,
  SystemMetricsStatus,
} from '../ipc/messages.js';

/**
 * system:metrics (SDK 5.1) — polling accumulator behind the System
 * Metrics panel.
 *
 * Two host-side facts drive the whole design (verified against
 * `crates/ditto-metrics-exporter-virtual-collection/src/lib.rs` and its
 * dtest fixtures in the Ditto repo):
 *
 *  1. The exporter is STARTUP-GATED: `metrics_exporter_virtual_collection_enabled`
 *     defaults to false and runtime `ALTER SYSTEM` changes are ignored —
 *     it's read once at install time. System params read `DITTO_<UPPER_SNAKE>`
 *     env vars (`crates/ditto-configuration/src/layer.rs`), so
 *     {@link withSystemMetricsEnv} flips
 *     `DITTO_METRICS_EXPORTER_VIRTUAL_COLLECTION_ENABLED` around `Ditto.open`.
 *     When the exporter wasn't installed, `SELECT * FROM system:metrics`
 *     still succeeds but returns a single placeholder row
 *     `{ status: "disabled", description: "…" }` with no `key` — that's the
 *     detectable {@link SystemMetricsStatus} 'exporterDisabled' case.
 *
 *  2. Every scan FLUSHES the registry: counter rows carry a per-read
 *     `delta`, histogram rows `dcount`/`dsum`/`dabs_max`. Anything showing
 *     "current" numbers must therefore accumulate the deltas itself — a
 *     last-read rendering would collapse to near-zero after the first poll.
 *     {@link accumulateMetricRows} does exactly that, keyed by metric name +
 *     sorted labels, so label combinations that GC out server-side simply
 *     stop getting fresh deltas while our accumulated totals stay.
 */

/** Process env var the SDK reads for the startup-gated exporter parameter. */
export const SYSTEM_METRICS_ENV_VAR = 'DITTO_METRICS_EXPORTER_VIRTUAL_COLLECTION_ENABLED';

const SYSTEM_METRICS_QUERY = 'SELECT * FROM system:metrics';

/** Default poll cadence while a System Metrics panel is visible. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Workspace setting reader — mirrors `readCollectProfiling`/`readCollectMetrics`
 *  in QueryEditorPanel. Default true: this is a developer tool, Info-level
 *  metrics are cheap, and the other two collection settings share the
 *  default-on UX. */
export function readCollectSystemMetrics(): boolean {
  return vscode.workspace.getConfiguration('dittoVsce').get<boolean>('collectSystemMetrics', true);
}

/** Run `fn` with the metrics-exporter env var flipped on, restoring the
 *  caller's value afterwards.
 *
 *  The env var must be set BEFORE `Ditto.open` — the parameter is read at
 *  startup and runtime changes are ignored. Caveats accepted by design:
 *
 *   - `process.env` is process-wide: a second Ditto SDK living in the same
 *     extension host would also observe the flip (vanishingly unlikely —
 *     this extension is the only SDK host in its process, and the window is
 *     the duration of one open call).
 *   - The exporter singleton behind it is a process-wide `OnceLock`: once
 *     one Ditto instance in this process installed it, later opens honour it
 *     regardless of the env var. That's the documented SDK behaviour, not
 *     something we can (or want to) undo.
 *
 *  Disabled callers pass through untouched — we never WRITE a false value
 *  over an operator-set `DITTO_…` env var from an outer shell. */
export async function withSystemMetricsEnv<T>(
  enabled: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) { return fn(); }
  const previous = process.env[SYSTEM_METRICS_ENV_VAR];
  process.env[SYSTEM_METRICS_ENV_VAR] = 'true';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[SYSTEM_METRICS_ENV_VAR];
    } else {
      process.env[SYSTEM_METRICS_ENV_VAR] = previous;
    }
  }
}

/** Minimal store seam — DittoManager satisfies this via executeRaw. */
export interface SystemMetricsStore {
  executeRaw(query: string): Promise<Record<string, unknown>[]>;
}

export interface SystemMetricsServiceOptions {
  /** Poll cadence. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Setting reader; overridable in tests. Default {@link readCollectSystemMetrics}. */
  readEnabled?: () => boolean;
  /** Mid-switch guard (same shape as `CollectionsRepository.createIndex` /
   *  `ImportService.checkActive`): `executeRaw` resolves against the CURRENT
   *  session, so a poll that spans a database switch would fold the NEW
   *  database's deltas into this database's totals. Checked before and after
   *  every read; a mismatch discards the rows and reports `noConnection`. */
  isExpectedActive?: () => boolean;
  /** Receives the status after every poll (and immediately when polling is
   *  refused because the setting is off). */
  onStatus: (status: SystemMetricsStatus) => void;
}

/** Stable per-series signature: the metric key plus its sorted label map.
 *  Label iteration order in the source is unspecified, so sort. */
function seriesSignature(key: string, labels: Record<string, string>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`)
    .join(',');
  return `${key}{${sorted}}`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Rows without a `key` are the exporter's "disabled" placeholder. */
function parseMetricRow(row: Record<string, unknown>): {
  key: string;
  labels: Record<string, string>;
  description: string;
  unit: string;
  kind: 'counter' | 'histogram';
  delta: number;
  deltaSum: number;
  absMax?: number;
} | null {
  if (typeof row.key !== 'string' || row.key.length === 0) { return null; }
  const labels: Record<string, string> = {};
  const rawLabels = row.labels;
  if (rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
    for (const [k, v] of Object.entries(rawLabels as Record<string, unknown>)) {
      if (typeof v === 'string') { labels[k] = v; }
    }
  }
  // Histograms carry count/dcount; counters and gauges share the
  // current/updates/delta shape and read as 'counter' here.
  const isHistogram = num(row.count) !== undefined || num(row.dcount) !== undefined;
  const absMax = num(row.abs_max);
  return {
    key: row.key,
    labels,
    description: typeof row.description === 'string' ? row.description : '',
    unit: typeof row.unit === 'string' ? row.unit : '',
    kind: isHistogram ? 'histogram' : 'counter',
    delta: num(isHistogram ? row.dcount : row.delta) ?? 0,
    deltaSum: num(row.dsum) ?? 0,
    ...(absMax !== undefined ? { absMax } : {}),
  };
}

/** Fold one flush of `system:metrics` rows into `samples` (mutated).
 *  Ignores placeholder/garbage rows. Call `buildSnapshot` afterwards. */
export function accumulateMetricRows(
  samples: Map<string, SystemMetricSample>,
  rows: Record<string, unknown>[],
): void {
  for (const row of rows) {
    const parsed = parseMetricRow(row);
    if (!parsed) { continue; }
    const sig = seriesSignature(parsed.key, parsed.labels);
    const existing = samples.get(sig);
    if (existing) {
      existing.sinceConnect += parsed.delta;
      existing.periodDelta = parsed.delta;
      if (parsed.kind === 'histogram') {
        existing.sumSinceConnect = (existing.sumSinceConnect ?? 0) + parsed.deltaSum;
        if (parsed.absMax !== undefined) { existing.absMax = parsed.absMax; }
      }
      // Descriptions are static per metric; no need to re-copy.
    } else {
      const sample: SystemMetricSample = {
        key: parsed.key,
        labels: parsed.labels,
        description: parsed.description,
        unit: parsed.unit,
        kind: parsed.kind,
        sinceConnect: parsed.delta,
        periodDelta: parsed.delta,
        ...(parsed.kind === 'histogram'
          ? {
              sumSinceConnect: parsed.deltaSum,
              ...(parsed.absMax !== undefined ? { absMax: parsed.absMax } : {}),
            }
          : {}),
      };
      samples.set(sig, sample);
    }
  }
}

/** True when a SELECT answered but the exporter isn't installed — the row
 *  set is exactly the placeholder `{ status: "disabled", … }` shape. */
export function isExporterDisabledRows(rows: Record<string, unknown>[]): boolean {
  return rows.length > 0
    && rows.every(r => typeof r.key !== 'string')
    && rows.some(r => r.status === 'disabled');
}

export class SystemMetricsService {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private readonly samples = new Map<string, SystemMetricSample>();
  private sinceMs: number | undefined;
  private readonly intervalMs: number;
  private readonly readEnabled: () => boolean;
  private readonly onStatus: (status: SystemMetricsStatus) => void;
  private readonly log: Logger;

  constructor(
    private readonly store: SystemMetricsStore,
    logger: Logger,
    options: SystemMetricsServiceOptions,
  ) {
    this.log = logger.withTag('ext:SystemMetrics');
    this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readEnabled = options.readEnabled ?? readCollectSystemMetrics;
    this.isExpectedActive = options.isExpectedActive;
    this.onStatus = options.onStatus;
  }

  private readonly isExpectedActive: (() => boolean) | undefined;

  get isPolling(): boolean { return this.timer !== undefined; }

  /** Begin polling. Idempotent. When the setting is off, reports
   *  `settingDisabled` once instead of starting the timer — the SDK-side
   *  enable happens at the NEXT connect, so there's nothing to poll now. */
  start(): void {
    if (this.timer) { return; }
    if (!this.readEnabled()) {
      this.onStatus({ kind: 'settingDisabled' });
      return;
    }
    // unref so a leaked timer can never hold the (test) process open; the
    // panel's dispose stops us in normal operation.
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref?.();
    // Immediate first poll so the section doesn't sit empty for a full
    // interval after the panel opens.
    void this.tick();
  }

  /** Stop polling. Accumulated samples are kept: resume continues the
   *  since-connect totals (missed intervals fold into the next delta). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One immediate poll, publishing the status. Exposed so callers can
   *  force a fresh read outside the cadence. No-op when the setting is
   *  off beyond reporting the state. */
  async refreshNow(): Promise<void> {
    this.onStatus(await this.pollOnce());
  }

  private async tick(): Promise<void> {
    if (this.inFlight) { return; } // a slow store must not stack polls
    this.inFlight = true;
    try {
      this.onStatus(await this.pollOnce());
    } finally {
      this.inFlight = false;
    }
  }

  /** One read of `system:metrics`: query, accumulate deltas, classify the
   *  status. Exposed so tests can drive polls without timers. */
  async pollOnce(): Promise<SystemMetricsStatus> {
    if (!this.readEnabled()) { return { kind: 'settingDisabled' }; }
    if (this.isExpectedActive && !this.isExpectedActive()) { return { kind: 'noConnection' }; }
    let rows: Record<string, unknown>[];
    try {
      rows = await this.store.executeRaw(SYSTEM_METRICS_QUERY);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no active database/i.test(message)) {
        return { kind: 'noConnection' };
      }
      this.log.warn('system:metrics read failed', { err: message });
      return { kind: 'unavailable', message };
    }
    // The read spanned a connection switch — the rows belong to the OTHER
    // database. Discard rather than pollute this panel's totals.
    if (this.isExpectedActive && !this.isExpectedActive()) { return { kind: 'noConnection' }; }
    if (isExporterDisabledRows(rows)) { return { kind: 'exporterDisabled' }; }
    if (this.sinceMs === undefined) { this.sinceMs = Date.now(); }
    accumulateMetricRows(this.samples, rows);
    return { kind: 'working', snapshot: this.buildSnapshot() };
  }

  private buildSnapshot(): SystemMetricsSnapshot {
    return {
      samples: [...this.samples.values()],
      sinceMs: this.sinceMs ?? Date.now(),
      polledAtMs: Date.now(),
      pollIntervalMs: this.intervalMs,
    };
  }
}
