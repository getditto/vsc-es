import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err } from './tool-result.js';
import { requireActiveConfig } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';

/** Attachment blobs never enter the LLM context — downloads go straight
 *  to disk via the SDK's native copy (no heap double). Attachment ADD
 *  works through execute_dql using newAttachment… which the MCP surface
 *  intentionally doesn't expose as a standalone upload tool today. */
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;

interface FetchArgs {
  token: { id: string; len: number | string; metadata?: Record<string, string> };
  save_to_path: string;
  overwrite: boolean;
}

async function fetchAttachment(ctx: McpToolContext, args: FetchArgs): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  const len = typeof args.token.len === 'string' ? Number.parseInt(args.token.len, 10) : args.token.len;
  if (!Number.isSafeInteger(len) || len <= 0) {
    return err('token.len must be a positive integer (copied from the row).');
  }
  if (len > MAX_ATTACHMENT_BYTES) {
    return err(`Attachment is ${Math.round(len / (1024 * 1024))} MB — above the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB MCP cap.`);
  }
  if (!path.isAbsolute(args.save_to_path)) {
    return err('save_to_path must be absolute.');
  }
  try {
    const stat = await fs.stat(args.save_to_path);
    if (stat && !args.overwrite) {
      return err(`File already exists: ${args.save_to_path}. Pass overwrite: true to replace it.`);
    }
  } catch { /* ENOENT is the expected path */ }

  const fetcher = ctx.manager.fetchAttachment(
    { id: args.token.id, len, metadata: args.token.metadata ?? {} },
  );
  if (!fetcher) { return err('No active session.'); }
  const attachment = await fetcher;
  if (!attachment) { return err('The attachment could not be fetched (deleted or unavailable).'); }
  // Native store→disk copy: no JS-side byte materialization (same path the
  // Inspector's Download action uses).
  await ctx.manager.saveAttachmentToPath(attachment, args.save_to_path);
  const written = await fs.stat(args.save_to_path).catch(() => null);
  return ok({
    savedTo: args.save_to_path,
    bytes: written?.size ?? len,
    attachmentId: args.token.id,
  });
}

export const attachmentTools: ToolDef[] = [
  tool({
    name: 'fetch_attachment',
    description:
      'Download a document attachment (token copied from an execute_dql row: the object with ' +
      'id/len/metadata) straight to a local file path. Refuses to overwrite existing files ' +
      'unless overwrite is true. Bytes never enter the conversation.',
    schema: {
      token: z.object({
        id: z.string().min(1),
        len: z.union([z.number(), z.string()]).describe('Byte length from the token (bigint may arrive as a string in JSON).'),
        metadata: z.record(z.string()).optional(),
      }),
      save_to_path: z.string().min(1).describe('Absolute destination path.'),
      overwrite: z.boolean().default(false),
    },
    handler: (ctx, args: FetchArgs) => fetchAttachment(ctx, args),
  }),
];
