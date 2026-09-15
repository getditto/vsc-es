import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
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

/**
 * Attachment bytes come from the Ditto store — and Ditto syncs data from
 * OTHER peers, so the tool's arguments can be steered by untrusted synced
 * content (prompt injection writes over ~/.zshrc, VS Code settings, etc.).
 * The download therefore stays inside roots the user already owns as work
 * areas: open workspace folders, the extension's global storage, and the
 * OS temp directory. Roots are canonicalised so a symlinked workspace root
 * still matches its real path.
 */
async function canonicalPath(candidate: string): Promise<string> {
  try { return await fs.realpath(candidate); } catch { return path.resolve(candidate); }
}

async function allowedRoots(ctx: McpToolContext): Promise<string[]> {
  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.push(folder.uri.fsPath);
  }
  roots.push(ctx.globalStorageFsPath, os.tmpdir());
  return await Promise.all(roots.map(canonicalPath));
}

/** Both the canonical candidate and canonical root must agree. Comparing via
 * `relative()` avoids prefix collisions (`C:\\temp2` is not inside `C:\\temp`),
 * and normalizing case covers Windows' case-insensitive filesystem. */
function isInsideRoot(candidate: string, root: string): boolean {
  const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve `saveToPath` to a canonical destination inside an allowed root
 *  or explain the refusal. The nearest EXISTING ancestor is realpath'd so
 *  a symlink component anywhere in the chain cannot escape the root
 *  (e.g. `workspaceDir/evil -> /etc` makes `evil/passwd` resolve outside). */
async function resolveDestination(
  ctx: McpToolContext,
  saveToPath: string,
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const resolved = path.resolve(saveToPath);
  let ancestor = path.dirname(resolved);
  const missing: string[] = [];
  for (;;) {
    try {
      // Unlike allowed roots, this must throw for a missing segment so we
      // walk upward to the nearest existing ancestor and resolve symlinks.
      ancestor = await fs.realpath(ancestor);
      break;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return { ok: false, reason: `No existing directory on the path: ${saveToPath}` };
      }
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const canonical = path.join(ancestor, ...missing, path.basename(resolved));
  const roots = await allowedRoots(ctx);
  if (!roots.some((r) => isInsideRoot(canonical, r))) {
    return {
      ok: false,
      reason:
        'save_to_path must be inside an open workspace folder, the extension storage ' +
        `directory, or the OS temp directory: ${saveToPath}`,
    };
  }
  return { ok: true, path: canonical };
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
  const dest = await resolveDestination(ctx, args.save_to_path);
  if (!dest.ok) { return err(dest.reason); }

  // overwrite:false claims the destination ATOMICALLY (exclusive create).
  // The old stat-then-copy gap let a second caller pass the existence
  // check while the first was still fetching, and the loser's file got
  // clobbered — and it turns "exists?" into the answer at claim time, not
  // at some earlier read.
  const claimed = !args.overwrite;
  if (claimed) {
    try {
      await fs.writeFile(dest.path, '', { flag: 'wx' });
    } catch {
      return err(`File already exists: ${dest.path}. Pass overwrite: true to replace it.`);
    }
  }

  const dropClaim = async (): Promise<void> => {
    // Our own exclusively-created placeholder — safe to remove, and a
    // stranded 0-byte file would read as a successful 0-byte download.
    if (claimed) { await fs.unlink(dest.path).catch(() => { /* best effort */ }); }
  };

  try {
    const fetcher = ctx.manager.fetchAttachment(
      { id: args.token.id, len, metadata: args.token.metadata ?? {} },
    );
    if (!fetcher) { await dropClaim(); return err('No active session.'); }
    const attachment = await fetcher;
    if (!attachment) {
      await dropClaim();
      return err('The attachment could not be fetched (deleted or unavailable).');
    }
    // Native store→disk copy: no JS-side byte materialization (same path the
    // Inspector's Download action uses).
    await ctx.manager.saveAttachmentToPath(attachment, dest.path);
    const written = await fs.stat(dest.path).catch(() => null);
    return ok({
      // Report the path as requested — the canonical destination resolves
      // to the same file, and callers think in their own paths.
      savedTo: args.save_to_path,
      bytes: written?.size ?? len,
      attachmentId: args.token.id,
    });
  } catch (e) {
    await dropClaim();
    throw (e instanceof Error ? e : new Error(String(e)));
  }
}

export const attachmentTools: ToolDef[] = [
  tool({
    name: 'fetch_attachment',
    description:
      'Download a document attachment (token copied from an execute_dql row: the object with ' +
      'id/len/metadata) straight to a local file. save_to_path must be absolute and inside an ' +
      'open workspace folder, the extension storage directory, or the OS temp directory. ' +
      'Refuses to overwrite existing files unless overwrite is true. Bytes never enter the conversation.',
    schema: {
      token: z.object({
        id: z.string().min(1),
        len: z.union([z.number(), z.string()]).describe('Byte length from the token (bigint may arrive as a string in JSON).'),
        metadata: z.record(z.string()).optional(),
      }),
      save_to_path: z.string().min(1)
        .describe('Absolute destination path (must be inside an open workspace folder, extension storage, or the OS temp dir).'),
      overwrite: z.boolean().default(false),
    },
    handler: (ctx, args: FetchArgs) => fetchAttachment(ctx, args),
  }),
];
