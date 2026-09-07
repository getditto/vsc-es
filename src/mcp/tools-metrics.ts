import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, errFrom } from './tool-result.js';
import { NO_ACTIVE_CONNECTION_MESSAGE, requireActiveConfig } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import type { SystemMetricsStatus } from '../ipc/messages.js';
import { snapshot as databaseStorageSnapshot } from '../storage/DatabaseMetricsService.js';

async function getQueryMetrics(ctx: McpToolContext): Promise<CallToolResult> {
  const id = ctx.manager.getActiveConfigId();
  if (!id) { return errFrom(new Error(NO_ACTIVE_CONNECTION_MESSAGE)); }
  const records = ctx.queryMetrics.list(id).map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    dql: r.dql,
    durationMs: r.durationMs,
    resultCount: r.resultCount,
    truncated: r.truncated === true ? true : undefined,
    location: r.location,
    explain: r.explain || undefined,
    profile: r.profile,
  }));
  return ok({
    note: 'In-memory ring of the last 200 queries run from this extension (per connection). ' +
      'Only queries run through the Query Editor are captured — execute_dql calls do not record.',
    records,
  });
}

/** Guidance text per non-working status — the equivalent of the panel's
 *  empty-state messaging, so an agent knows how to remediate. */
function statusGuidance(status: SystemMetricsStatus): string | undefined {
  switch (status.kind) {
    case 'working': return undefined;
    case 'settingDisabled':
      return 'dittoVsce.collectSystemMetrics is off. Enable it, then reconnect (the exporter is startup-gated).';
    case 'exporterDisabled':
      return 'The metrics exporter was not installed when this connection opened (startup-gated). Reconnect with dittoVsce.collectSystemMetrics on.';
    case 'noConnection': return 'No active connection for this accumulator.';
    case 'unavailable': return `system:metrics read failed: ${status.message}`;
  }
}

async function getSystemMetrics(ctx: McpToolContext): Promise<CallToolResult> {
  const cfg = requireActiveConfig(ctx);
  // Reads flush the SDK registry — go through the SHARED per-connection
  // accumulator (SystemMetricsHub) so this call never perturbs the System
  // Metrics panel's totals.
  const service = ctx.systemMetricsHub.acquireForToolCalls(cfg.id);
  const status = await service.pollOnce();
  return ok({
    status,
    description: describeStatus(status),
    ...(statusGuidance(status) !== undefined ? { guidance: statusGuidance(status) } : {}),
  });
}

function describeStatus(status: SystemMetricsStatus): string {
  if (status.kind !== 'working') { return status.kind; }
  const s = status.snapshot;
  return `${s.samples.length} series, accumulated since ${new Date(s.sinceMs).toISOString()}`;
}

async function getDatabaseMetrics(ctx: McpToolContext): Promise<CallToolResult> {
  const cfg = requireActiveConfig(ctx);
  const dataDir = path.join(ctx.globalStorageFsPath, 'dittoData', cfg.id);
  const snap = await databaseStorageSnapshot(
    ctx.manager,
    dataDir,
    () => ctx.manager.getActiveConfigId() === cfg.id,
  );
  return ok({
    note: 'Disk usage is the live per-connection working directory; cborPayloadBytes sums ' +
      'materialize every document — expensive on large collections, matches the panel semantics.',
    ...snap,
  });
}

export const metricsTools: ToolDef[] = [
  tool({
    name: 'get_query_metrics',
    description:
      'Query performance history for the active connection: duration, row counts, EXPLAIN ' +
      'plans, and PROFILE trees for the last 200 queries run from the Query Editor.',
    schema: {},
    handler: (ctx) => getQueryMetrics(ctx),
  }),
  tool({
    name: 'get_system_metrics',
    description:
      'Accumulated Ditto system metrics (SDK 5.1 system:metrics): per-series counters and ' +
      'histograms as since-connect totals with the latest poll-window delta. Each call reads ' +
      'live deltas and folds them into the shared accumulator — report sinceConnect values and ' +
      'the sinceMs zero point, and expect periodDelta to shrink right after any read.',
    schema: {},
    handler: (ctx) => getSystemMetrics(ctx),
  }),
  tool({
    name: 'get_database_metrics',
    description:
      'Storage snapshot of the active database: categorized disk usage of the working ' +
      'directory (store/wal/attachments/logs/…) plus per-collection document counts and CBOR ' +
      'payload bytes. Expensive on large collections (materializes every document); call ' +
      'sparingly.',
    schema: {},
    handler: (ctx) => getDatabaseMetrics(ctx),
  }),
];

