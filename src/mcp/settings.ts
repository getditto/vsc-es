import * as vscode from 'vscode';

/** Default loopback port. The SwiftUI Edge Studio app owns 65269, so the
 *  extension takes the next one — both apps can serve agents at once
 *  (against their own active database) without a bind conflict. */
export const MCP_DEFAULT_PORT = 65270;

/**
 * Read the MCP listener port, normalising junk (out-of-range/non-finite)
 * back to the default rather than trapping — mirrors the SwiftUI app's
 * UserDefaults clamp. Machine-scoped so an untrusted workspace cannot move
 * the listener. The on/off decision itself is per-connection
 * (`advancedConfig.mcpServerEnabled` on the active StoredDittoConfig).
 */
export function readMcpPort(): number {
  const raw = vscode.workspace.getConfiguration('dittoVsce.mcpServer').get<number>('port', MCP_DEFAULT_PORT);
  // 0 = OS-assigned ephemeral port (tests; harmless in settings.json since
  // the Copy MCP Client Config snippet then points at a wrong placeholder).
  return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : MCP_DEFAULT_PORT;
}

/** Client-config snippets for the "Copy MCP Client Config" command and
 *  docs. Two shapes because clients differ: Claude Code project config
 *  (.mcp.json) and the generic streamable-HTTP URL most other tools take. */
export function mcpClientConfigSnippet(port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        'ditto-edge-studio-vscode': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
        },
      },
    },
    null,
    2,
  );
}
