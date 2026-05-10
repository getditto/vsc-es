import * as vscode from 'vscode';
import * as path from 'node:path';
import { panelHtml, autoRevealInspectorOnce } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { DbMetricsIn, DbMetricsOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import { snapshot } from '../storage/DatabaseMetricsService.js';

/**
 * Webview panel surfacing the SwiftUI Edge Studio's Storage view as
 * "Database Metrics" — on-demand only. The panel is empty until the
 * user clicks Refresh (the very first auto-fetch counts as that).
 * Per-DB scope: singleton, opening on a different DB disposes the
 * previous panel (matches PeerListingPanel / QueryMetricsPanel).
 *
 * Computation is expensive (filesystem walk + N collection scans).
 * Nothing here polls — the user picks when fresh numbers matter.
 */
export class DatabaseMetricsPanel {
  private static current: DatabaseMetricsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    manager: DittoManager,
    databaseId: string,
    inspector: InspectorController,
    logger: Logger,
  ): void {
    if (DatabaseMetricsPanel.current) {
      if (DatabaseMetricsPanel.current.databaseId === databaseId) {
        DatabaseMetricsPanel.current.panel.reveal();
        return;
      }
      logger.warn('DatabaseMetricsPanel.show called for a different DB; disposing.', {
        currentDb: DatabaseMetricsPanel.current.databaseId, requestedDb: databaseId,
      });
      DatabaseMetricsPanel.current.dispose();
    }
    DatabaseMetricsPanel.current = new DatabaseMetricsPanel(
      context, configs, manager, databaseId, inspector, logger,
    );
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    DatabaseMetricsPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly dataDir: string;
  private inFlight = false;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configs: ConfigStore,
    private readonly manager: DittoManager,
    private readonly databaseId: string,
    private readonly inspector: InspectorController,
    private readonly logger: Logger,
  ) {
    const cfg = configs.get(databaseId);
    // Mirrors the directory layout DittoManager.connect creates:
    //   <globalStorageUri>/dittoData/<configId>
    // The snapshot service walks this tree directly since the Node
    // SDK doesn't expose a diskUsage API like SwiftUI does.
    this.dataDir = path.join(context.globalStorageUri.fsPath, 'dittoData', databaseId);

    this.panel = vscode.window.createWebviewPanel(
      'dittoDatabaseMetrics',
      `Database Metrics — ${cfg?.name ?? 'Unknown'}`,
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
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'databaseMetrics.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Database Metrics',
      scriptUri,
      styleUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      (m: DbMetricsIn | LogIn) => { void this.handle(m); },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.panel.webview.postMessage({
      type: 'log.levelChanged', level: logger.getChannelLevel(),
    } satisfies LogOut);
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'databaseMetrics', databaseId: this.databaseId });
        }
      }),
    );

    // Auto-fetch the first snapshot on open so the user doesn't see a
    // blank panel. Subsequent refreshes are explicit (Refresh button).
    setTimeout(() => { void this.refresh(); }, 50);
  }

  private post(msg: DbMetricsOut): void { void this.panel.webview.postMessage(msg); }

  private async handle(msg: DbMetricsIn | LogIn): Promise<void> {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoDatabaseMetrics');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'dbMetrics.refresh') {
      await this.refresh();
      return;
    }
  }

  /**
   * Compute a fresh snapshot. Guarded against concurrent refreshes
   * (the button is disabled in the UI while in-flight, but a
   * misbehaving keybinding or test could race it).
   */
  private async refresh(): Promise<void> {
    if (this.inFlight) { return; }
    this.inFlight = true;
    const log = this.logger.withTag('ext:DatabaseMetrics');
    this.post({ type: 'dbMetrics.loading' });
    try {
      const snap = await snapshot(this.manager, this.dataDir);
      this.post({
        type: 'dbMetrics.snapshot',
        snapshot: { ...snap, computedAt: Date.now() },
      });
      log.info('Snapshot computed', {
        totalDiskBytes: snap.totalDiskBytes,
        collectionCount: snap.collectionBreakdown.length,
      });
    } catch (err) {
      log.error('Snapshot failed', {
        err: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      this.post({
        type: 'dbMetrics.error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private dispose() {
    DatabaseMetricsPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
