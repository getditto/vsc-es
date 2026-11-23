// src/ditto/SupportBundleService.ts

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { DittoManager } from './DittoManager.js';
import type { Logger } from '../logging/types.js';
import { withSdkResource } from './sdk-resources.js';

const gzip = promisify(zlib.gzip);

/** Minimum seconds of query execution to accumulate before capturing the
 *  dial9 trace. Matches benchy's `MIN_QUERY_SECONDS = 70` — dial9's ring
 *  buffer needs roughly 60s of activity for a useful profile; 70s gives
 *  margin. */
export const MIN_QUERY_SECONDS = 70;

/** Timeout for the attachment fetch (milliseconds). Matches benchy's
 *  180-second cap. */
const FETCH_TIMEOUT_MS = 180_000;

/** Result of a successful support-bundle collection. */
export interface SupportBundleResult {
  /** Absolute path of the saved `.tar.gz` file. */
  savedPath: string;
  /** Size of the compressed file in bytes. */
  compressedBytes: number;
  /** Size of the original `.tar` in bytes. */
  originalBytes: number;
  /** Number of query executions completed during the trace window. */
  queryExecutions: number;
  /** Actual seconds of query execution accumulated. */
  querySeconds: number;
}

/** The collected bundle as in-memory bytes, before any save dialog — the
 *  shape callers need when the bundle becomes part of a larger artifact
 *  (the bug-report zip) rather than a file of its own. */
export interface SupportBundleBytes {
  /** The gzipped bundle, ready to write or pack. */
  gzBytes: Buffer;
  /** Size of the original `.tar` in bytes. */
  originalBytes: number;
  /** Number of query executions completed during the trace window. */
  queryExecutions: number;
  /** Actual seconds of query execution accumulated. */
  querySeconds: number;
}

/** Progress reporter passed to the collection flow so the caller decides
 *  how to surface status (VS Code progress notification, MCP log, test
 *  harness, …). */
export interface SupportBundleProgress {
  report(message: string, increment?: number): void;
}

/**
 * Collects a dial9 diagnostic support bundle from the active Ditto
 * connection. The flow mirrors benchy's `collect-support-bundle.py`:
 *
 *  1. **Load generation** — if a query is provided, executes it in a loop
 *     until ≥ {@link MIN_QUERY_SECONDS} of cumulative execution time has
 *     elapsed. This ensures the dial9 ring buffer captures a meaningful
 *     profile of the query's Tokio task behaviour.
 *  2. **Bundle request** — issues
 *     `EXECUTE FUNCTION system_request_support_bundle()` which assembles
 *     a `.tar` archive containing `dial9/dial9.bin.gz` plus device logs
 *     and other diagnostics.
 *  3. **Retrieval** — queries `system:support_bundles` for the newest
 *     document, extracts the `file` attachment token, fetches the
 *     attachment via the SDK, and reads its bytes.
 *  4. **Compression** — gzips the `.tar` into a `.tar.gz` for delivery.
 *  5. **Save** — shows a VS Code save dialog and writes the file.
 *
 * Dial9 recording itself is NOT started/stopped here — it's controlled
 * by the `DITTO_DIAL9_OBSERVABILITY_LEVEL` env var at SDK open time
 * (default: Lite). This service only captures what's already in the
 * ring buffer.
 */
export class SupportBundleService {
  constructor(
    private readonly manager: DittoManager,
    private readonly logger: Logger,
  ) {}

  /**
   * Run the collection flow and return the bundle as in-memory bytes —
   * phases 1–4 (load generation, bundle request, attachment fetch,
   * compression) with no save dialog. {@link collect} adds the dialog;
   * callers embedding the bundle in a larger artifact (the bug-report
   * zip) use this directly.
   */
  async collectBytes(
    query?: string,
    progress?: SupportBundleProgress,
    minQuerySeconds?: number,
  ): Promise<SupportBundleBytes> {
    const log = this.logger.withTag('ext:SupportBundle');
    const targetSeconds = minQuerySeconds ?? MIN_QUERY_SECONDS;

    // ── Phase 1: Load generation (optional) ──────────────────────
    let queryExecutions = 0;
    let querySeconds = 0;
    if (query) {
      progress?.report('Running query to collect trace data…');
      log.info('Starting dial9 trace collection', { minSeconds: targetSeconds });
      const result = await this.runQueryLoop(query, targetSeconds, progress);
      queryExecutions = result.executions;
      querySeconds = result.seconds;
      log.info('Trace collection complete', { executions: queryExecutions, seconds: querySeconds });
    }

    // ── Phase 2: Request the bundle ──────────────────────────────
    progress?.report('Requesting support bundle…');
    log.info('Requesting support bundle');
    const bundleDoc = await this.requestBundle();
    log.info('Support bundle generated', { id: JSON.stringify(bundleDoc._id) });

    // ── Phase 3: Fetch the attachment ────────────────────────────
    progress?.report('Downloading support bundle…');
    const tarBytes = await this.fetchBundleAttachment(bundleDoc, log);
    log.info('Bundle downloaded', { bytes: tarBytes.length });

    // ── Phase 4: Compress ────────────────────────────────────────
    progress?.report('Compressing…');
    const gzBytes = await gzip(tarBytes);
    log.info('Bundle compressed', { original: tarBytes.length, compressed: gzBytes.length });

    return {
      gzBytes,
      originalBytes: tarBytes.length,
      queryExecutions,
      querySeconds,
    };
  }

  /**
   * Run the full collection flow. Returns the result on success, or
   * `null` if the user cancelled the save dialog.
   *
   * @param query  The DQL SELECT to loop for trace collection. When
   *               omitted, skips the load-generation phase (the bundle
   *               still contains whatever dial9 has already captured).
   * @param progress  Optional progress reporter.
   * @param minQuerySeconds  Override the minimum query-execution window
   *                         (default {@link MIN_QUERY_SECONDS}). Used by
   *                         tests to avoid a real 70-second wait.
   */
  async collect(
    query?: string,
    progress?: SupportBundleProgress,
    minQuerySeconds?: number,
  ): Promise<SupportBundleResult | null> {
    const log = this.logger.withTag('ext:SupportBundle');
    const bytes = await this.collectBytes(query, progress, minQuerySeconds);

    // ── Phase 5: Save dialog ─────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suggested = `ditto-support-bundle-${timestamp}.tar.gz`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
        : vscode.Uri.file(suggested),
      filters: { 'Compressed archives': ['tar.gz', 'tgz'] },
      saveLabel: 'Save Support Bundle',
    });
    if (!target) {
      log.info('Save cancelled by user');
      return null;
    }

    await fs.writeFile(target.fsPath, bytes.gzBytes);
    log.info('Support bundle saved', { path: target.fsPath, bytes: bytes.gzBytes.length });

    return {
      savedPath: target.fsPath,
      compressedBytes: bytes.gzBytes.length,
      originalBytes: bytes.originalBytes,
      queryExecutions: bytes.queryExecutions,
      querySeconds: bytes.querySeconds,
    };
  }

  /**
   * Execute `query` in a loop until cumulative execution time reaches
   * {@link MIN_QUERY_SECONDS}. Each iteration is timed independently —
   * only the query's own execution time counts (not overhead between
   * calls), matching benchy's approach.
   *
   * Returns the number of executions and total seconds accumulated.
   */
  private async runQueryLoop(
    query: string,
    targetSeconds: number,
    progress?: SupportBundleProgress,
  ): Promise<{ executions: number; seconds: number }> {
    let executions = 0;
    let totalNs = 0;
    const targetNs = targetSeconds * 1e9;

    while (totalNs < targetNs) {
      const start = performance.now();
      await this.manager.executeRaw(query);
      const elapsed = performance.now() - start;
      totalNs += elapsed * 1e6; // ms → ns
      executions++;

      const secondsSoFar = totalNs / 1e9;
      const pct = Math.min(99, Math.round((secondsSoFar / targetSeconds) * 100));
      progress?.report(
        `Collecting trace data… ${secondsSoFar.toFixed(0)}s / ${targetSeconds}s`,
        pct,
      );
    }

    return { executions, seconds: totalNs / 1e9 };
  }

  /**
   * Issue `EXECUTE FUNCTION system_request_support_bundle()` and return
   * the bundle document `{ _id, reason, file }`.
   */
  private async requestBundle(): Promise<Record<string, unknown>> {
    const rows = await this.manager.executeRaw(
      'EXECUTE FUNCTION system_request_support_bundle()',
    );
    if (rows.length === 0) {
      throw new Error('Support bundle request returned no result');
    }
    return rows[0]!;
  }

  /**
   * Extract the `file` attachment token from a support-bundle document
   * and fetch its bytes via the SDK's attachment API.
   */
  private async fetchBundleAttachment(
    bundleDoc: Record<string, unknown>,
    log: Logger,
  ): Promise<Buffer> {
    const fileToken = bundleDoc.file;
    if (!fileToken || typeof fileToken !== 'object') {
      throw new Error('Support bundle document has no file attachment');
    }

    const token = fileToken as { id: string; len: number | bigint; metadata: Record<string, string> };
    const fetcher = this.manager.fetchAttachment(token);
    if (!fetcher) {
      throw new Error('No active database connection for attachment fetch');
    }

    // Await the fetcher (PromiseLike) with a timeout. Clear the timer
    // as soon as either side settles so a fast fetch doesn't leave a
    // dangling setTimeout keeping the process alive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attachment;
    try {
      attachment = await Promise.race([
        fetcher,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Attachment fetch timed out')), FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) { clearTimeout(timer); }
    }

    if (!attachment) { throw new Error('Support bundle attachment is unavailable'); }
    return withSdkResource(attachment, log, async attachment => {
      // Export through the same path as regular attachments, including
      // support for bundles stored in an encrypted database.
      const tmpDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'ditto-bundle-'));
      const tmpPath = path.join(tmpDir, 'bundle.tar');
      try {
        await this.manager.saveAttachmentToPath(attachment, tmpPath);
        const bytes = await fs.readFile(tmpPath);
        log.info('Bundle attachment saved to temp file', { bytes: bytes.length });
        return bytes;
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
}
