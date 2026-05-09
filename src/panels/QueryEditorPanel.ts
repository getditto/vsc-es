import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { QueryIn, QueryOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { QueryHistoryStore } from '../storage/QueryHistoryStore.js';
import type { QueryFavoritesStore } from '../storage/QueryFavoritesStore.js';

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
  private static _current: QueryEditorPanel | undefined;

  static get current(): QueryEditorPanel | undefined { return QueryEditorPanel._current; }

  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    databaseId: string,
    tracker: OpenPanelsTracker,
    inspector: InspectorController,
    history: QueryHistoryStore,
    favorites: QueryFavoritesStore,
    logger: Logger,
  ) {
    if (QueryEditorPanel._current) {
      if (QueryEditorPanel._current.databaseId === databaseId) {
        QueryEditorPanel._current.panel.reveal();
        return;
      }
      // Different DB requested — should not normally happen because the
      // lifecycle disposes us before connecting elsewhere. Fall through and replace.
      logger.warn('QueryEditorPanel.show called for a different DB than current; disposing.', {
        currentDb: QueryEditorPanel._current.databaseId, requestedDb: databaseId,
      });
      QueryEditorPanel._current.dispose();
    }
    QueryEditorPanel._current = new QueryEditorPanel(context, manager, configs, databaseId, tracker, inspector, history, favorites, logger);
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    QueryEditorPanel._current?.dispose();
  }

  loadQuery(query: string): void {
    this.panel.webview.postMessage({ type: 'query.setText', text: query });
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly configs: ConfigStore,
    databaseId: string,
    private readonly tracker: OpenPanelsTracker,
    private readonly inspector: InspectorController,
    private readonly history: QueryHistoryStore,
    private readonly favorites: QueryFavoritesStore,
    private readonly logger: Logger,
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

    this.panel.webview.onDidReceiveMessage((msg: QueryIn | LogIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Push initial channel level to webview.
    this.panel.webview.postMessage({ type: 'log.levelChanged', level: logger.getChannelLevel() } satisfies LogOut);

    // Subscribe to level changes; track disposable so we can clean up.
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    void tracker.add(databaseId, 'query');
    this.disposables.push({ dispose: () => { void tracker.remove(databaseId, 'query'); } });

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'query', databaseId: this.databaseId });
        }
      })
    );
  }

  private post(msg: QueryOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: QueryIn | LogIn) {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoQueryEditor');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'query.rowSelected') {
      this.inspector.setSelectedRowJson(msg.rowJson);
      return;
    }
    if (msg.type === 'query.starCurrent') {
      void this.favorites.add(this.databaseId, msg.query);
      return;
    }
    if (msg.type !== 'query.run') { return; }
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      this.post({ type: 'query.error', message: 'No active database. Connect first.' });
      return;
    }
    try {
      const { rows, durationMs, metadata } = await this.manager.executeQuery(msg.query);
      const columns = computeColumns(rows);
      this.post({ type: 'query.result', rows, columns, durationMs, metadata });
      this.inspector.setLastResultMetadata(metadata);
      void this.history.add(this.databaseId, msg.query);
    } catch (err) {
      this.post({ type: 'query.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private dispose() {
    QueryEditorPanel._current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
