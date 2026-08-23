import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { CollectionsRepository } from '../ditto/CollectionsRepository.js';
import type { Logger } from '../logging/types.js';
import type { ImportDataIn, ImportDataOut, LogIn, LogOut } from '../ipc/messages.js';
import {
  ImportValidationError,
  importDocuments,
  validateJsonDocuments,
} from '../ditto/ImportService.js';

/**
 * Webview panel that walks the user through importing a JSON file into
 * a Ditto collection. Mirrors the SwiftUI `ImportDataView` + `ImportService`
 * UX:
 *
 *   1. User picks a JSON file (host-side dialog — webview can't reach the
 *      OS picker reliably and we need a `fs` path anyway).
 *   2. Host parses + validates the file, echoes back doc count.
 *   3. User chooses existing/new collection + regular/initial insert type.
 *   4. Host streams batch-progress events back as the import runs.
 *   5. Host posts a `done` with success/failure counts and any errors.
 *
 * Singleton per running extension: re-`show()` with the same database
 * just reveals the existing panel, re-init'ing it with a fresh preselect.
 */
export class ImportDataPanel {
  private static current: ImportDataPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    manager: DittoManager,
    collectionsRepo: CollectionsRepository,
    databaseId: string,
    logger: Logger,
    preselectedCollection?: string,
  ): void {
    if (ImportDataPanel.current && ImportDataPanel.current.databaseId === databaseId) {
      ImportDataPanel.current.panel.reveal();
      // Re-init so a right-click → Import on a different collection
      // updates the preselect without a panel teardown.
      ImportDataPanel.current.postInit(preselectedCollection);
      return;
    }
    if (ImportDataPanel.current) {
      ImportDataPanel.current.dispose();
    }
    ImportDataPanel.current = new ImportDataPanel(
      context, configStore, manager, collectionsRepo, databaseId, logger, preselectedCollection,
    );
  }

  /** Called by the switch-orchestrator to tear down the panel before
   *  the active connection changes — preserves the established pattern
   *  for every other singleton webview in the extension. */
  static dispose(): void {
    ImportDataPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Buffered parsed documents from the most recent file pick. Held
   *  here so a Cancel-and-pick-another flow doesn't leak the previous
   *  file's data, and so the actual import doesn't have to re-read +
   *  re-parse. Cleared on successful import. */
  private bufferedDocuments: Record<string, unknown>[] | undefined;
  private bufferedFileName: string | undefined;
  private isImporting = false;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore,
    private readonly manager: DittoManager,
    private readonly collectionsRepo: CollectionsRepository,
    private readonly databaseId: string,
    private readonly logger: Logger,
    preselectedCollection: string | undefined,
  ) {
    const cfg = configStore.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoImportData',
      `Import Data — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'importData.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Import Data',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<ImportDataIn | LogIn>(
        this.logger, 'ext:importData', 'Import data failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Mirror channel level for webview-side log filtering (same pattern
    // every other panel uses).
    void this.panel.webview.postMessage({
      type: 'log.levelChanged', level: logger.getChannelLevel(),
    } satisfies LogOut);
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      void this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    // Defensive setTimeout so the webview has a tick to register its
    // `message` listener before the init payload lands — matches the
    // ImportSubscriptions panel's race fix.
    setTimeout(() => { this.postInit(preselectedCollection); }, 50);
  }

  private post(msg: ImportDataOut): void { void this.panel.webview.postMessage(msg); }

  /** Send (or re-send) the initial payload — connection name +
   *  existing collections snapshot + optional preselected name. */
  private postInit(preselectedCollection?: string): void {
    const cfg = this.configStore.get(this.databaseId);
    const collections = this.collectionsRepo.current().map(c => c.name).sort();
    this.post({
      type: 'importData.init',
      databaseName: cfg?.name ?? 'Unknown',
      existingCollections: collections,
      preselectedCollection,
    });
  }

  private async handle(msg: ImportDataIn | LogIn): Promise<void> {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoImportData');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    switch (msg.type) {
      case 'importData.chooseFile':
        await this.chooseFile();
        return;
      case 'importData.refreshCollections': {
        const collections = this.collectionsRepo.current().map(c => c.name).sort();
        this.post({ type: 'importData.collectionsRefreshed', existingCollections: collections });
        return;
      }
      case 'importData.start':
        await this.runImport(msg.collection, msg.insertType);
        return;
      case 'importData.cancel':
        this.panel.dispose();
        return;
    }
  }

  private async chooseFile(): Promise<void> {
    const log = this.logger.withTag('ext:ImportData');
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { 'JSON files': ['json'] },
      openLabel: 'Choose JSON File',
    });
    if (!picked || picked.length === 0) { return; }
    const file = picked[0];
    log.info('User selected import file', { path: file.fsPath });

    let raw: string;
    try {
      raw = await fs.readFile(file.fsPath, 'utf8');
    } catch (err) {
      const message = `Could not read file: ${err instanceof Error ? err.message : String(err)}`;
      log.warn('File read failed', { path: file.fsPath, err: message });
      this.post({ type: 'importData.error', message });
      return;
    }

    try {
      const docs = validateJsonDocuments(raw);
      this.bufferedDocuments = docs;
      this.bufferedFileName = file.fsPath.split(/[\\/]/).pop() ?? 'file.json';
      log.info('JSON file validated', { documentCount: docs.length });
      this.post({
        type: 'importData.fileSelected',
        fileName: this.bufferedFileName,
        documentCount: docs.length,
      });
    } catch (err) {
      const message = err instanceof ImportValidationError
        ? err.message
        : err instanceof Error ? err.message : String(err);
      log.warn('JSON validation failed', { err: message });
      // Clear any prior buffer so a stale "OK" file doesn't get imported
      // after a failed re-pick.
      this.bufferedDocuments = undefined;
      this.bufferedFileName = undefined;
      this.post({ type: 'importData.error', message });
    }
  }

  private async runImport(
    collection: string,
    insertType: 'regular' | 'initial',
  ): Promise<void> {
    const log = this.logger.withTag('ext:ImportData');

    if (this.isImporting) {
      this.post({ type: 'importData.error', message: 'Import already in progress.' });
      return;
    }
    if (!this.bufferedDocuments) {
      this.post({ type: 'importData.error', message: 'No file selected.' });
      return;
    }
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      this.post({ type: 'importData.error', message: 'This connection is no longer active.' });
      return;
    }

    this.isImporting = true;
    log.info('Import started', {
      collection,
      insertType,
      documentCount: this.bufferedDocuments.length,
    });

    try {
      const result = await importDocuments({
        documents: this.bufferedDocuments,
        collection,
        insertType,
        execute: (query, args) => this.manager.executeRaw(query, args),
        onProgress: (p) => {
          this.post({
            type: 'importData.progress',
            current: p.current,
            total: p.total,
            currentDocumentId: p.currentDocumentId,
          });
        },
      });
      log.info('Import completed', {
        collection,
        successCount: result.successCount,
        failureCount: result.failureCount,
      });
      if (result.failureCount > 0) {
        // Log the first error for debuggability — the full list is on
        // the panel; the channel just needs one breadcrumb.
        log.warn('Import had row failures', {
          firstError: result.errors[0],
          failureCount: result.failureCount,
        });
      }
      this.post({
        type: 'importData.done',
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors: result.errors.slice(0, 5),
        collection,
      });
      // Successful import — drop the buffered docs so a stale array
      // can't be re-imported by accident. Refresh collections so a
      // newly-created collection appears in the dropdown immediately
      // if the user wants to import into another one without reopening.
      if (result.failureCount === 0) {
        this.bufferedDocuments = undefined;
        this.bufferedFileName = undefined;
        await this.collectionsRepo.load();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Import failed', {
        collection,
        err: err instanceof Error ? err.stack ?? err.message : message,
      });
      this.post({ type: 'importData.error', message });
    } finally {
      this.isImporting = false;
    }
  }

  private dispose(): void {
    if (ImportDataPanel.current === this) {
      ImportDataPanel.current = undefined;
    }
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
