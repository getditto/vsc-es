import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err, errFrom } from './tool-result.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import { DebugSocketClient } from '../ditto/DebugSocketClient.js';

/**
 * Client side of the SDK 5.1 debug_socket subsystem (same client the
 * Debug Console panel drives): connect to a RUNNING APP's Unix socket,
 * run one DQL statement, disconnect. No extension-side connection is
 * required — that's what makes it useful for automating the app under
 * development from an agent in VS Code.
 */
const MCP_DEBUG_SOCKET_ROW_CAP = 10_000;

async function debugSocketQuery(
  ctx: McpToolContext,
  args: { socket_path: string; statement: string },
): Promise<CallToolResult> {
  const client = new DebugSocketClient(ctx.log, {
    // Agents fire one-shot statements; fail faster than the UI's 30 s so a
    // wedged app doesn't hold an agent turn open forever.
    requestTimeoutMs: 15_000,
  });
  try {
    await client.connect(args.socket_path);
  } catch (e) {
    return errFrom(e);
  }
  try {
    const result = await client.query(args.statement);
    if (!result.ok) { return err(result.error); }
    const items = result.items;
    const truncated = items.length > MCP_DEBUG_SOCKET_ROW_CAP;
    return ok({
      rows: truncated ? items.slice(0, MCP_DEBUG_SOCKET_ROW_CAP) : items,
      rowCount: truncated ? MCP_DEBUG_SOCKET_ROW_CAP : items.length,
      ...(truncated ? { truncated: true, totalRowCount: items.length } : {}),
    });
  } finally {
    client.disconnect();
  }
}

export const debugSocketTools: ToolDef[] = [
  tool({
    name: 'debug_socket_query',
    description:
      "Run one DQL statement (reads AND mutations) against a RUNNING app's debug socket — " +
      "the app's SDK must have `ALTER SYSTEM SET debug_socket = '/path/to.sock'` applied. " +
      'Independent of any connection in this extension; ideal for automating the app under ' +
      'development. One statement per line; 15 s timeout.',
    schema: {
      socket_path: z.string().min(1).describe('Absolute path to the target app\'s debug socket.'),
      statement: z.string().min(1).describe('One DQL statement (no newlines).'),
    },
    handler: (ctx, args: { socket_path: string; statement: string }) => debugSocketQuery(ctx, args),
  }),
];
