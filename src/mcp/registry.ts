import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './context.js';
import { err as toolErr } from './tool-result.js';
import type { ToolDef } from './define-tool.js';
import { connectionTools } from './tools-connections.js';
import { queryTools } from './tools-query.js';
import { debugSocketTools } from './tools-debug-socket.js';
import { collectionTools } from './tools-collections.js';
import { syncTools } from './tools-sync.js';
import { subscriptionTools } from './tools-subscriptions.js';
import { observerTools } from './tools-observers.js';
import { metricsTools } from './tools-metrics.js';
import { logTools } from './tools-logs.js';
import { attachmentTools } from './tools-attachments.js';

export type { ToolDef } from './define-tool.js';

/**
 * The full tool manifest, in display groups. Kept data-shaped (no
 * registerTool calls inside the tool modules): the `tools/list` shape
 * test counts + inspects this table without needing to stand a server
 * up, mirroring the SwiftUI suite's manifest assertions.
 */
export function allTools(): ToolDef[] {
  return [
    ...connectionTools,   // incl. connect/disconnect (headless automation)
    ...queryTools,        // incl. explain_query / profile_query
    ...debugSocketTools,
    ...collectionTools,
    ...syncTools,
    ...subscriptionTools,
    ...observerTools,
    ...metricsTools,      // incl. system + database metrics
    ...logTools,          // incl. query_log_analyzer
    ...attachmentTools,
  ];
}

/** Register every tool on one (per-session) McpServer. Handlers never
 *  throw — define-tool's tool() wrapper converts throws to `isError`
 *  results; the guard here is belt-and-suspenders. */
export function registerAllTools(server: McpServer, ctx: McpToolContext): void {
  for (const def of allTools()) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      async (args) => {
        try {
          return await def.handler(ctx, args);
        } catch (e) {
          return toolErr(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }
}
