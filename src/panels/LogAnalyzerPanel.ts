import * as vscode from 'vscode';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import type { LogAnalyzerService, AnalyzerDiff } from '../logAnalyzer/LogAnalyzerService.js';
import type { Logger } from '../logging/types.js';
import type { AnalyzerIn, AnalyzerOut } from '../ipc/messages.js';
import type { InspectorController } from '../inspector/InspectorController.js';

/**
 * Webview wrapper for the Log Analyzer. **Singleton per databaseId** —
 * each connection gets its own panel; opening the same database's
 * analyzer again reveals the existing panel. Mirrors the
 * DatabaseMetricsPanel scoping model.
 *
 * The panel owns the LogAnalyzerService for its database, so closing
 * the panel disposes the service. extension.ts disposes the panel when
 * the database disconnects so per-connection state doesn't leak across
 * sessions.
 */
export class LogAnalyzerPanel {
  private static panels = new Map<string, LogAnalyzerPanel>();

  static show(
    context: vscode.ExtensionContext,
    databaseId: string,
    databaseName: string,
    svc: LogAnalyzerService,
    backfillProvider: () => Promise<string>,
    logger: Logger,
    inspector: InspectorController,
    /** Lines older than this are skipped during backfill so the panel
     *  shows only the current connection's logs, not weeks of history
     *  carried in the rotated log files. */
    minTimestamp?: Date,
  ): void {
    const existing = LogAnalyzerPanel.panels.get(databaseId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = new LogAnalyzerPanel(
      context, databaseId, databaseName, svc, backfillProvider, logger, inspector, minTimestamp,
    );
    LogAnalyzerPanel.panels.set(databaseId, panel);
  }

  /** Dispose the panel for one database, or all of them when no id is passed. */
  static dispose(databaseId?: string): void {
    if (databaseId === undefined) {
      for (const p of [...LogAnalyzerPanel.panels.values()]) p.dispose();
      LogAnalyzerPanel.panels.clear();
      return;
    }
    LogAnalyzerPanel.panels.get(databaseId)?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private diffSub: { dispose(): void } | null = null;
  private bootstrapped = false;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly databaseId: string,
    databaseName: string,
    private readonly svc: LogAnalyzerService,
    private readonly backfillProvider: () => Promise<string>,
    private readonly logger: Logger,
    private readonly inspector: InspectorController,
    private readonly minTimestamp?: Date,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoLogAnalyzer',
      `Log Analyzer — ${databaseName}`,
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
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'logAnalyzer.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Log Analyzer', scriptUri, styleUri, cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<AnalyzerIn>(
        this.logger, 'ext:logAnalyzer', 'Log analyzer action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // When the panel gains focus, route the Inspector to the
    // logAnalyzer help so the docs render in the secondary sidebar.
    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'logAnalyzer', databaseId: this.databaseId });
        }
      }),
    );
    // Set the active feature immediately on construction so the help
    // renders the first time the panel becomes visible too.
    this.inspector.setActiveFeature({ kind: 'logAnalyzer', databaseId: this.databaseId });

    this.diffSub = this.svc.onDiff(d => this.forwardDiff(d));

    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    const log = this.logger.withTag('ext:LogAnalyzerPanel');
    try {
      const text = await this.backfillProvider();
      this.svc.start({ backfillText: text, minTimestamp: this.minTimestamp });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Backfill failed; continuing with live-only ingestion', { err: message });
      this.post({ type: 'analyzer.error', stage: 'backfill', message });
      // Live ingestion still works even when backfill failed
      this.svc.start();
    }
  }

  private async handle(msg: AnalyzerIn): Promise<void> {
    switch (msg.type) {
      case 'analyzer.refresh':
        this.bootstrapped = false;
        await this.bootstrap();
        return;
      case 'analyzer.clear':  this.svc.clear(); return;
      case 'analyzer.pause':  this.svc.pause(); return;
      case 'analyzer.resume': this.svc.resume(); return;
      case 'analyzer.openPatternEditor':
        await vscode.commands.executeCommand('dittoVsce.openLogPatternEditor');
        return;
      case 'analyzer.revealLine':
        // Future: open log file at the recorded line. For MVP: no-op.
        return;
      case 'analyzer.queryLines': {
        const result = this.svc.queryLines({
          filter: msg.filter,
          search: msg.search,
          limit: msg.limit,
          offset: msg.offset,
        });
        this.post({
          type: 'analyzer.linesResult',
          requestId: msg.requestId,
          items: result.items,
          total: result.total,
        });
        return;
      }
      case 'analyzer.requestLineDetail': {
        const result = this.svc.getLineDetail(msg.lineId);
        this.post({
          type: 'analyzer.lineDetail',
          requestId: msg.requestId,
          line: result.line,
          before: result.before,
          after: result.after,
        });
        return;
      }
    }
  }

  private forwardDiff(d: AnalyzerDiff): void {
    // Map AnalyzerDiff (service-side) to AnalyzerOut (webview-side) by
    // prefixing the type with 'analyzer.'.
    this.post({ ...d, type: ('analyzer.' + d.type) as AnalyzerOut['type'] } as AnalyzerOut);
  }

  private post(msg: AnalyzerOut): void { void this.panel.webview.postMessage(msg); }

  private dispose() {
    LogAnalyzerPanel.panels.delete(this.databaseId);
    this.diffSub?.dispose();
    this.svc.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
