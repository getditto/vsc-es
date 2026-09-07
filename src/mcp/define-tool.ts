import type { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolContext } from './context.js';
import { err as toolErr } from './tool-result.js';

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
  handler: (ctx: McpToolContext, args: any) => Promise<CallToolResult>;
}

/** Define a tool such that handler throws become `isError` results
 *  (SwiftUI convention: tool failures are RESULTS, not protocol errors).
 *  Wrapping here — rather than only at registerTool time — means unit
 *  tests that call `def.handler` directly assert the shipped contract. */
export function tool(def: ToolDef): ToolDef {
  return {
    ...def,
    handler: async (ctx, args) => {
      try {
        return await def.handler(ctx, args);
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
