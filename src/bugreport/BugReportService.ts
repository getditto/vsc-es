// src/bugreport/BugReportService.ts

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import type { DittoManager } from '../ditto/DittoManager.js';
import { SupportBundleService } from '../ditto/SupportBundleService.js';
import type { SupportBundleProgress } from '../ditto/SupportBundleService.js';
import type { Logger } from '../logging/types.js';
import { createZip } from './zip.js';
import type { ZipEntry } from './zip.js';

/** Result of a successful bug-report export. */
export interface BugReportResult {
  /** Absolute path of the saved `.zip` file. */
  savedPath: string;
  /** Size of the zip in bytes. */
  totalBytes: number;
  /** Whether the SDK support bundle made it into the archive. */
  includedSupportBundle: boolean;
  /** Why the bundle is absent (no connection / collection failed);
   *  `null` when it was included. */
  bundleNote: string | null;
}

export interface BugReportServiceDeps {
  manager: DittoManager;
  logger: Logger;
  /** Reads the extension's application log (all rotations, chronological). */
  readAllLogs: () => Promise<string>;
  extensionVersion: string;
  sdkVersion: string;
}

/**
 * Builds the one-file bug report: the extension's application log plus the
 * SDK support bundle (`EXECUTE FUNCTION system_request_support_bundle()`,
 * SDK 5.2+) packed into a single zip the user saves where they choose.
 *
 * The application log is always included. The support bundle requires an
 * active connection; when there isn't one — or when collection fails (the
 * SDK rate-limits bundle requests to ~3 per 10 minutes) — the export still
 * succeeds with the log alone and the reason is recorded in the zip's
 * README. A bug report about a connection or startup failure is exactly the
 * case where refusing to export would lose the diagnostics that matter.
 *
 * The bundle is captured as-is — no 70-second query loop. A user exporting
 * a bug report wants the current state, not a delay.
 */
export class BugReportService {
  constructor(private readonly deps: BugReportServiceDeps) {}

  /**
   * Run the export. Returns the result on success, or `null` when the user
   * cancels the save dialog (the collected data is simply discarded).
   */
  async export(progress?: SupportBundleProgress): Promise<BugReportResult | null> {
    const log = this.deps.logger.withTag('ext:BugReport');
    const created = new Date();

    // ── Application log (always) ─────────────────────────────────
    progress?.report('Reading application log…');
    const appLog = await this.deps.readAllLogs();

    // ── Support bundle (best-effort) ─────────────────────────────
    let bundleBytes: Buffer | null = null;
    let bundleNote: string | null = null;
    if (!this.deps.manager.getActiveConfigId()) {
      bundleNote = 'no active database connection — the support bundle requires one';
      log.warn('Exporting bug report without a support bundle: no active connection');
    } else {
      try {
        const bundle = await new SupportBundleService(this.deps.manager, this.deps.logger)
          .collectBytes(undefined, progress);
        bundleBytes = bundle.gzBytes;
      } catch (err) {
        bundleNote = `support bundle collection failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error('Support bundle collection failed during bug-report export', { error: bundleNote });
      }
    }

    // ── Pack the zip ─────────────────────────────────────────────
    progress?.report('Packing bug report…');
    const entries: ZipEntry[] = [
      { name: 'README.txt', data: Buffer.from(this.manifest(created, bundleBytes !== null, bundleNote), 'utf8') },
      { name: 'application.log', data: Buffer.from(appLog, 'utf8') },
    ];
    if (bundleBytes) {
      // Already gzipped — store, don't re-deflate.
      entries.push({ name: 'support-bundle.tar.gz', data: bundleBytes, compression: 'store' });
    }
    const zip = createZip(entries);

    // ── Save dialog ──────────────────────────────────────────────
    const timestamp = created.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suggested = `ditto-bug-report-${timestamp}.zip`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
        : vscode.Uri.file(suggested),
      filters: { 'Zip archives': ['zip'] },
      saveLabel: 'Save Bug Report',
    });
    if (!target) {
      log.info('Save cancelled by user');
      return null;
    }

    await fs.writeFile(target.fsPath, zip);
    log.info('Bug report saved', {
      path: target.fsPath, bytes: zip.length, supportBundle: bundleBytes !== null,
    });

    return {
      savedPath: target.fsPath,
      totalBytes: zip.length,
      includedSupportBundle: bundleBytes !== null,
      bundleNote,
    };
  }

  /** The README.txt packed at the top of every bug-report zip: what the
   *  archive is, the versions that produced it, and — when the bundle is
   *  missing — exactly why, so a support engineer isn't left guessing. */
  private manifest(created: Date, includedBundle: boolean, bundleNote: string | null): string {
    const lines = [
      'Ditto Edge Studio — bug report',
      `Created: ${created.toISOString()}`,
      `Extension version: ${this.deps.extensionVersion}`,
      `Ditto SDK version: ${this.deps.sdkVersion}`,
      `VS Code: ${vscode.version}`,
      `OS: ${process.platform} ${process.arch}`,
      '',
      'Contents:',
      '- application.log — Ditto Edge Studio application log (all rotations, chronological)',
    ];
    if (includedBundle) {
      lines.push('- support-bundle.tar.gz — Ditto SDK support bundle (dial9 trace, SDK logs, store diagnostics)');
    } else {
      lines.push('', `Support bundle: NOT INCLUDED — ${bundleNote ?? 'unknown reason'}`);
    }
    lines.push(
      '',
      'Privacy: the application log and support bundle may contain query text,',
      'collection names, and document data from your databases. Review before sharing.',
      '',
    );
    return lines.join('\n');
  }
}
