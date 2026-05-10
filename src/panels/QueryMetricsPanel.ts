import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { QueryMetricsStore, QueryMetricRecord } from '../storage/QueryMetricsStore.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { MetricsIn, MetricsOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';

/**
 * Replay panel for every query that's been run against the active DB,
 * with EXPLAIN output. Ports the SwiftUI Edge Studio's
 * QueryMetricsDetailView one-to-one (left list + right detail split)
 * with one addition: a Location badge per record so a user looking at
 * the history can tell Local Database from HTTP runs at a glance —
 * SwiftUI doesn't track that, but we do, and the location frequently
 * explains a latency outlier.
 *
 * Singleton per DB: opening Query Metrics on the same connection just
 * reveals the existing panel; opening for a different DB disposes the
 * previous one. Matches PeerListingPanel's pattern.
 */
export class QueryMetricsPanel {
  private static current: QueryMetricsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    metricsStore: QueryMetricsStore,
    databaseId: string,
    inspector: InspectorController,
    logger: Logger,
  ): void {
    if (QueryMetricsPanel.current) {
      if (QueryMetricsPanel.current.databaseId === databaseId) {
        QueryMetricsPanel.current.panel.reveal();
        QueryMetricsPanel.current.pushState();
        return;
      }
      logger.warn('QueryMetricsPanel.show called for a different DB; disposing.', {
        currentDb: QueryMetricsPanel.current.databaseId, requestedDb: databaseId,
      });
      QueryMetricsPanel.current.dispose();
    }
    QueryMetricsPanel.current = new QueryMetricsPanel(
      context, configs, metricsStore, databaseId, inspector, logger,
    );
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    QueryMetricsPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configs: ConfigStore,
    private readonly metricsStore: QueryMetricsStore,
    private readonly databaseId: string,
    private readonly inspector: InspectorController,
    private readonly logger: Logger,
  ) {
    const cfg = configs.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoQueryMetrics',
      `Query Metrics — ${cfg?.name ?? 'Unknown'}`,
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
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'queryMetrics.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Query Metrics',
      scriptUri,
      styleUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      (m: MetricsIn | LogIn) => { void this.handle(m); },
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Live-update the panel as new queries run elsewhere in the
    // extension. Filter on databaseId so we don't churn when someone
    // queries a different DB.
    this.disposables.push(metricsStore.onChange(({ databaseId: dbId }) => {
      if (dbId === this.databaseId) { this.pushState(); }
    }));

    // Mirror channel level for webview-side log filtering.
    this.panel.webview.postMessage({
      type: 'log.levelChanged', level: logger.getChannelLevel(),
    } satisfies LogOut);
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    // Drive the Inspector's help into "metrics" mode when the panel
    // has focus so clicking around always shows the right doc.
    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'metrics', databaseId: this.databaseId });
        }
      }),
    );

    // Defer the first push by one tick so the webview's message
    // listener is wired before we deliver — same defensive race-defeat
    // every other panel uses.
    setTimeout(() => this.pushState(), 50);
  }

  private post(msg: MetricsOut): void { void this.panel.webview.postMessage(msg); }

  private pushState(): void {
    const records: QueryMetricRecord[] = this.metricsStore.list(this.databaseId);
    this.post({ type: 'metrics.state', records });
  }

  private async handle(msg: MetricsIn | LogIn): Promise<void> {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoQueryMetrics');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'metrics.clear') {
      const ok = await vscode.window.showWarningMessage(
        'Clear all Query Metrics for this connection? This drops every recorded EXPLAIN history record.',
        { modal: true },
        'Clear',
      );
      if (ok !== 'Clear') { return; }
      this.metricsStore.clear(this.databaseId);
      // The store's onChange listener above re-pushes for us.
      return;
    }
  }

  private dispose() {
    QueryMetricsPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
