import { z } from 'zod';
import type { BigIntStats } from 'node:fs';
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
const pendingExclusiveDownloads = new Set<string>();

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

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Relative-path comparison avoids treating a sibling with a shared prefix as inside the root. */
function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(normalizeCase(root), normalizeCase(candidate));
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

async function isSameDirectory(directory: string, expected: BigIntStats): Promise<boolean> {
  try {
    const current = await fs.lstat(directory, { bigint: true });
    return current.isDirectory() && current.dev === expected.dev && current.ino === expected.ino
      && normalizeCase(await fs.realpath(directory)) === normalizeCase(directory);
  } catch {
    return false;
  }
}

/** Check directory identity after long-running I/O and before publication.
 * The final operation still uses a path because Node has no portable
 * directory-handle-relative rename or link. */
async function assertSameDirectory(directory: string, expected: BigIntStats): Promise<void> {
  if (!await isSameDirectory(directory, expected)) {
    throw new Error('The attachment destination or staging directory changed during the download.');
  }
}

async function withStagedAttachment<T>(
  parent: string,
  use: (file: string, verifyDirectory: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(parent, '.ditto-attachment-'));
  const file = path.join(directory, 'attachment');
  const identity = await fs.lstat(directory, { bigint: true });
  const verifyDirectory = () => assertSameDirectory(directory, identity);
  try {
    await verifyDirectory();
    return await use(file, verifyDirectory);
  } finally {
    if (await isSameDirectory(directory, identity)) {
      await fs.unlink(file).catch(() => { /* best effort */ });
      await fs.rmdir(directory).catch(() => { /* best effort */ });
    }
  }
}

async function publishAttachment(
  staged: string,
  destination: string,
  overwrite: boolean,
  mode: number,
  verifyParent: () => Promise<void>,
): Promise<void> {
  if (overwrite) {
    try {
      // Replace the directory entry without opening its previous target.
      await fs.rename(staged, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') { throw error; }
      // A rename across volumes needs a complete copy on the target volume.
      // The private source may have the previous file's write-only mode.
      await fs.chmod(staged, 0o600);
      await verifyParent();
      await withStagedAttachment(path.dirname(destination), async (localStage, verifyLocalStage) => {
        await fs.copyFile(staged, localStage, fs.constants.COPYFILE_EXCL);
        await verifyLocalStage();
        await fs.chmod(localStage, mode);
        await verifyParent();
        await fs.rename(localStage, destination);
      });
    }
    return;
  }

  try {
    // Link publishes the complete file only if the destination is absent.
    await fs.link(staged, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // On Windows, exFAT may report EISDIR for an unsupported hard link.
    if (!code || !['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(code)) { throw error; }
    // Cross-volume paths and filesystems without hard links still support
    // exclusive creation. Readers may see the file before the copy finishes.
    await verifyParent();
    await fs.copyFile(staged, destination, fs.constants.COPYFILE_EXCL);
  }
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

  const existsError = () => err(`File already exists: ${dest.path}. Pass overwrite: true to replace it.`);
  const reservation = args.overwrite ? undefined : normalizeCase(dest.path);
  if (reservation !== undefined) {
    if (pendingExclusiveDownloads.has(reservation)) { return existsError(); }
    pendingExclusiveDownloads.add(reservation);
  }

  try {
    const parent = path.dirname(dest.path);
    const parentIdentity = await fs.lstat(parent, { bigint: true });
    const verifyParent = () => assertSameDirectory(parent, parentIdentity);
    await verifyParent();
    const existing = await fs.lstat(dest.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (existing && !args.overwrite) { return existsError(); }
    if (existing && !existing.isFile()) {
      return err(`Refusing to replace a destination that is not a regular file: ${dest.path}`);
    }

    const fetcher = ctx.manager.fetchAttachment(
      { id: args.token.id, len, metadata: args.token.metadata ?? {} },
    );
    if (!fetcher) { return err('No active session.'); }
    const attachment = await fetcher;
    if (!attachment) {
      return err('The attachment could not be fetched (deleted or unavailable).');
    }

    // Keep the native SDK's write in OS scratch space under a private
    // directory instead of giving it a path in the caller's workspace.
    return await withStagedAttachment(await fs.realpath(os.tmpdir()), async (staged, verifyStage) => {
      // Read the default mode from a new file without querying the
      // process-wide umask, which Node implements by rewriting it.
      await fs.writeFile(staged, '', { flag: 'wx' });
      const initialMode = (await fs.lstat(staged)).mode;
      await ctx.manager.saveAttachmentToPath(attachment, staged);
      await verifyStage();
      const written = await fs.lstat(staged);
      if (!written.isFile()) { return err('The attachment download did not produce a regular file.'); }
      const mode = (existing?.mode ?? initialMode) & 0o777;
      await fs.chmod(staged, mode);
      await verifyParent();
      try {
        await publishAttachment(staged, dest.path, args.overwrite, mode, verifyParent);
      } catch (error) {
        if (!args.overwrite && (error as NodeJS.ErrnoException).code === 'EEXIST') { return existsError(); }
        throw error;
      }
      return ok({ savedTo: args.save_to_path, bytes: written.size, attachmentId: args.token.id });
    });
  } finally {
    if (reservation !== undefined) { pendingExclusiveDownloads.delete(reservation); }
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
        // zod 4 requires both the key and value types for z.record() — the
        // one-arg zod 3 form (`z.record(z.string())`) is gone. Values were
        // strings in zod 3, so `z.string()` keeps the schema identical.
        metadata: z.record(z.string(), z.string()).optional(),
      }),
      save_to_path: z.string().min(1)
        .describe('Absolute destination path (must be inside an open workspace folder, extension storage, or the OS temp dir).'),
      overwrite: z.boolean().default(false),
    },
    handler: (ctx, args: FetchArgs) => fetchAttachment(ctx, args),
  }),
];
