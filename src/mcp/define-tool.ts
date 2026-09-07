import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolContext } from './context.js';
import { err as toolErr } from './tool-result.js';

/** The slice of the SDK's RequestHandlerExtra a tool may rely on.
 *  `signal` fires on the client's notifications/cancelled and when the
 *  session closes mid-call — long-running tools (watch_query) must honor
 *  it; absent when unit tests invoke the handler directly. */
export interface ToolCallExtra {
  signal: AbortSignal;
}

/**
 * One MCP tool as a data record. Handlers receive the SHARED extension
 * service graph — the same seams webview panels use — so a tool body is
 * usually three lines and a unit test drives it with fakes.
 *
 * Split out of registry.ts on purpose: the tool modules import THIS file,
 * and registry.ts imports the tool modules, so keeping `tool()` in the
 * registry would be a module cycle.
 */
export interface ToolDef {
  name: string;
  description: string;
  /** Zod raw shape; `{}` for no-arg tools. */
  schema: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: McpToolContext, args: any, extra?: ToolCallExtra) => Promise<CallToolResult>;
}

/** Define a tool such that handler throws become `isError` results
 *  (SwiftUI convention: tool failures are RESULTS, not protocol errors).
 *  Wrapping here — rather than only at registerTool time — means unit
 *  tests that call `def.handler` directly assert the shipped contract. */
export function tool(def: ToolDef): ToolDef {
  return {
    ...def,
    handler: async (ctx, args, extra) => {
      try {
        return await def.handler(ctx, args, extra);
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
