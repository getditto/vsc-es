import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, errFrom } from './tool-result.js';
import { NO_ACTIVE_CONNECTION_MESSAGE } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';

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

export const metricsTools: ToolDef[] = [
  tool({
    name: 'get_query_metrics',
    description:
      'Query performance history for the active connection: duration, row counts, EXPLAIN ' +
      'plans, and PROFILE trees for the last 200 queries run from the Query Editor.',
    schema: {},
    handler: (ctx) => getQueryMetrics(ctx),
  }),
];
