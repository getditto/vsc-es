import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Success payload: pretty-printed JSON text. The SwiftUI server returns
 *  the same shape (result.content[0].text), so agent skills written
 *  against it parse unchanged. */
export function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/** Tool-level failure. Mirrors the SwiftUI server convention: tool
 *  failures are successful JSON-RPC responses carrying `isError: true`
 *  with a human-readable message — the model reads and recovers from it.
 *  JSON-RPC errors are reserved for protocol failures by the SDK. */
export function err(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

export function errFrom(e: unknown): CallToolResult {
  return err(e instanceof Error ? e.message : String(e));
}
