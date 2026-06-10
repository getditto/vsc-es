import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { LogAnalyzerService, AnalyzerDiff } from '../logAnalyzer/LogAnalyzerService.js';
import type { Logger } from '../logging/types.js';
import type { AnalyzerIn, AnalyzerOut } from '../ipc/messages.js';

/**
 * Webview wrapper for the Log Analyzer. Singleton — opening it again
 * just reveals the existing panel.
 *
 * The panel does NOT own the LogAnalyzerService. The service lives for
 * the lifetime of the extension so it can keep accumulating state while
 * the panel is closed. The panel subscribes to service diffs on open
 * and unsubscribes on dispose.
 */
export class LogAnalyzerPanel {
  private static current: LogAnalyzerPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    svc: LogAnalyzerService,
    backfillProvider: () => Promise<string>,
    logger: Logger,
  ): void {
    if (LogAnalyzerPanel.current) {
      LogAnalyzerPanel.current.panel.reveal();
      return;
    }
    LogAnalyzerPanel.current = new LogAnalyzerPanel(context, svc, backfillProvider, logger);
  }

  static dispose(): void {
    LogAnalyzerPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private diffSub: { dispose(): void } | null = null;
  private bootstrapped = false;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly svc: LogAnalyzerService,
    private readonly backfillProvider: () => Promise<string>,
    private readonly logger: Logger,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoLogAnalyzer',
      'Log Analyzer',
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
      (m: AnalyzerIn) => { void this.handle(m); }, undefined, this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.diffSub = this.svc.onDiff(d => this.forwardDiff(d));

    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    const log = this.logger.withTag('ext:LogAnalyzerPanel');
    try {
      const text = await this.backfillProvider();
      this.svc.start({ backfillText: text });
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
    LogAnalyzerPanel.current = undefined;
    this.diffSub?.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
