import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { QueryIn, QueryOut } from '../ipc/messages.js';

function computeColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) { keys.add(k); }
  }
  const all = Array.from(keys);
  const hasId = keys.has('_id');
  const sorted = all.filter(k => k !== '_id').sort();
  return hasId ? ['_id', ...sorted] : sorted;
}

export class QueryEditorPanel {
  private static current: QueryEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    databaseId: string
  ) {
    if (QueryEditorPanel.current) {
      QueryEditorPanel.current.panel.reveal();
      QueryEditorPanel.current.refreshTitle(databaseId, configs);
      return;
    }
    QueryEditorPanel.current = new QueryEditorPanel(context, manager, configs, databaseId);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly configs: ConfigStore,
    databaseId: string
  ) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoQueryEditor',
      `Query — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'query.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Query Editor',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.onDidReceiveMessage((msg: QueryIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private refreshTitle(databaseId: string, configs: ConfigStore) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel.title = `Query — ${cfg?.name ?? 'Unknown'}`;
  }

  private post(msg: QueryOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: QueryIn) {
    if (msg.type !== 'query.run') { return; }
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      this.post({ type: 'query.error', message: 'No active database. Connect first.' });
      return;
    }
    try {
      const { rows, durationMs } = await this.manager.executeQuery(msg.query);
      const columns = computeColumns(rows);
      this.post({ type: 'query.result', rows, columns, durationMs });
    } catch (err) {
      this.post({ type: 'query.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private dispose() {
    QueryEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
