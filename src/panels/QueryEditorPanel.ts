import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { QueryIn, QueryOut, LogIn, LogOut, QueryMode } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';
import type { QueryHistoryStore } from '../storage/QueryHistoryStore.js';
import type { QueryFavoritesStore } from '../storage/QueryFavoritesStore.js';
import { executeRemoteQuery } from '../ditto/HttpQueryService.js';

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
  private static readonly _instances = new Set<QueryEditorPanel>();

  /** Open a NEW Query Editor tab. Multiple instances may coexist. Returns the
   *  newly-created panel so callers can drive it (e.g. loadQuery). */
  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    secrets: SecretStore,
    databaseId: string,
    tracker: OpenPanelsTracker,
    inspector: InspectorController,
    history: QueryHistoryStore,
    favorites: QueryFavoritesStore,
    logger: Logger,
  ): QueryEditorPanel {
    const inst = new QueryEditorPanel(
      context, manager, configs, secrets, databaseId, tracker, inspector, history, favorites, logger,
    );
    QueryEditorPanel._instances.add(inst);
    autoRevealInspectorOnce(context);
    return inst;
  }

  /** Dispose every open Query Editor tab. Used by the lifecycle orchestrator
   *  when switching databases — all editors for the previous DB close before
   *  the new DB activates. */
  static dispose(): void {
    for (const inst of [...QueryEditorPanel._instances]) {
      inst.dispose();
    }
  }

  loadQuery(query: string): void {
    this.panel.webview.postMessage({ type: 'query.setText', text: query });
    this.updateTabTitle(query);
  }

  /** Set the editor-tab title to the current query text — collapsing
   *  whitespace/newlines and truncating to keep the tab readable.
   *  Empty input falls back to "Query". */
  private updateTabTitle(text: string): void {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    const MAX = 60;
    if (collapsed.length === 0) {
      this.panel.title = 'Query';
    } else if (collapsed.length <= MAX) {
      this.panel.title = collapsed;
    } else {
      this.panel.title = collapsed.slice(0, MAX - 1) + '…';
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;
  /** Stable id for THIS query tab's slot in OpenPanelsTracker. Generated
   *  fresh on construction; survives until dispose. The tracker uses this
   *  to upsert the tab's text in place, so emitting many text-change
   *  updates doesn't shuffle the array's order. */
  private readonly tabId: string = randomTabId();
  // Per-panel "last run" snapshot. The InspectorController is a singleton
  // shared across all Query Editor instances, so when this panel takes
  // focus it has to re-push these so the Inspector reflects ITS latest
  // results — otherwise switching tabs away and back would erase metrics.
  private lastMetadata: QueryResultMetadata | undefined;
  private lastSelectedRowJson: string | null | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly configs: ConfigStore,
    private readonly secrets: SecretStore,
    databaseId: string,
    private readonly tracker: OpenPanelsTracker,
    private readonly inspector: InspectorController,
    private readonly history: QueryHistoryStore,
    private readonly favorites: QueryFavoritesStore,
    private readonly logger: Logger,
  ) {
    this.databaseId = databaseId;
    this.panel = vscode.window.createWebviewPanel(
      'dittoQueryEditor',
      'Query',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      }
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark:  vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
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

    // Register this tab in the per-DB panel state so it gets restored
    // when the connection reopens. Initial text is whatever loadQuery
    // pushed (if any) before the listener registered; the textChanged
    // handler keeps it in sync from there.
    void tracker.upsertQueryTab(databaseId, { id: this.tabId, text: '' });

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'query', databaseId: this.databaseId });
          // setActiveFeature replaces the inspector's content with a fresh
          // 'query' object, which clears lastResultMetadata + selectedRowJson.
          // Re-push our cached values so the Metrics + JSON tabs keep showing
          // THIS panel's last run when the user toggles back to its tab.
          if (this.lastMetadata) { this.inspector.setLastResultMetadata(this.lastMetadata); }
          if (this.lastSelectedRowJson !== undefined) { this.inspector.setSelectedRowJson(this.lastSelectedRowJson); }
        }
      })
    );

    // Push the available run-locations to the webview so it knows
    // whether to render the Local/HTTP dropdown. Defer one tick to
    // defeat VS Code's message-queue race (same defensive pattern the
    // other panels use).
    setTimeout(() => { void this.postModeInit(); }, 50);
  }

  /** Resolve which run-locations are usable for this connection. HTTP
   *  requires both a non-empty httpApiUrl in config AND an httpApiKey
   *  secret — matches the SwiftUI `executeModes` gating in QueryViewModel. */
  private async postModeInit(): Promise<void> {
    const cfg = this.configs.get(this.databaseId);
    let httpKey: string | undefined;
    try { httpKey = (await this.secrets.read(this.databaseId)).httpApiKey; }
    catch (err) {
      this.logger.withTag('ext:QueryEditor').warn('Could not read secrets for mode init', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    const httpAvailable = !!(cfg?.httpApiUrl && httpKey);
    const availableModes: QueryMode[] = httpAvailable ? ['local', 'http'] : ['local'];
    this.post({ type: 'query.modeInit', availableModes });
  }

  private post(msg: QueryOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: QueryIn | LogIn) {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoQueryEditor');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'query.rowSelected') {
      this.lastSelectedRowJson = msg.rowJson;
      this.inspector.setSelectedRowJson(msg.rowJson);
      return;
    }
    if (msg.type === 'query.rowActivated') {
      // Double-click → flip the Inspector to JSON. setQueryTab is a
      // no-op when content.kind isn't 'query', but in practice the
      // QueryEditor sets that on every focus change so the Inspector
      // is already in 'query' mode whenever this fires.
      this.lastSelectedRowJson = msg.rowJson;
      this.inspector.setSelectedRowJson(msg.rowJson);
      void this.inspector.setQueryTab('json');
      return;
    }
    if (msg.type === 'query.starCurrent') {
      void this.favorites.add(this.databaseId, msg.query);
      return;
    }
    if (msg.type === 'query.textChanged') {
      this.updateTabTitle(msg.text);
      // Persist the text so a reconnect restores this tab with its
      // last-edited contents. upsertQueryTab is idempotent on `id` so
      // emitting on every keystroke just rewrites the same slot.
      void this.tracker.upsertQueryTab(this.databaseId, { id: this.tabId, text: msg.text });
      return;
    }
    if (msg.type !== 'query.run') { return; }
    const mode: QueryMode = msg.mode ?? 'local';
    try {
      const { rows, durationMs, metadata } = mode === 'http'
        ? await this.runViaHttp(msg.query)
        : await this.runViaLocal(msg.query);
      const columns = computeColumns(rows);
      this.post({ type: 'query.result', rows, columns, durationMs, metadata });
      this.lastMetadata = metadata;
      this.lastSelectedRowJson = null;
      this.inspector.setLastResultMetadata(metadata);
      this.inspector.setSelectedRowJson(null);
      void this.history.add(this.databaseId, msg.query);
    } catch (err) {
      this.post({ type: 'query.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Runs the query against the active SDK store. Requires the connection
   *  this panel was opened against to currently be the manager's active
   *  config — otherwise the SDK has no store to execute against. */
  private async runViaLocal(query: string): Promise<{
    rows: Record<string, unknown>[];
    durationMs: number;
    metadata: QueryResultMetadata;
  }> {
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      throw new Error('No active database. Connect first.');
    }
    const result = await this.manager.executeQuery(query);
    // Stamp the run-location here rather than threading another arg
    // through DittoManager — the manager only ever runs `local`, so
    // the stamp is correct by construction.
    return { ...result, metadata: { ...result.metadata, location: 'local' } };
  }

  /** Runs the query against the Ditto Server's REST API. Doesn't need
   *  an active SDK connection — only the connection's stored httpApiUrl
   *  + httpApiKey. After the data run we issue a second `EXPLAIN <query>`
   *  call so the Metrics tab's plan section isn't blank — mirrors the
   *  local path's runExplain in DittoManager (non-fatal, skipped when
   *  the user already prefixed EXPLAIN). */
  private async runViaHttp(query: string): Promise<{
    rows: Record<string, unknown>[];
    durationMs: number;
    metadata: QueryResultMetadata;
  }> {
    const cfg = this.configs.get(this.databaseId);
    const secrets = await this.secrets.read(this.databaseId);
    if (!cfg?.httpApiUrl || !secrets.httpApiKey) {
      throw new Error('HTTP mode requires httpApiUrl and httpApiKey on this connection.');
    }
    const httpReq = {
      httpApiUrl: cfg.httpApiUrl,
      httpApiKey: secrets.httpApiKey,
      allowUntrustedCerts: cfg.allowUntrustedCerts,
    };
    const start = performance.now();
    const response = await executeRemoteQuery({ ...httpReq, query }, this.logger);
    const durationMs = Math.round(performance.now() - start);
    const rows = response.items.filter(
      (it): it is Record<string, unknown> =>
        typeof it === 'object' && it !== null && !Array.isArray(it),
    );

    const explain = await this.fetchHttpExplain(httpReq, query);

    const metadata: QueryResultMetadata = {
      dql: query,
      durationMs,
      resultCount: rows.length,
      explain,
      timestamp: Date.now(),
      location: 'http',
    };
    return { rows, durationMs, metadata };
  }

  /** Best-effort EXPLAIN fetch over HTTP. Returns a pretty-printed JSON
   *  string, or '' on any failure (network, server error, parse error)
   *  so the Metrics tab degrades to "(plan unavailable)" rather than
   *  failing the whole query. Skips when the user already prefixed
   *  EXPLAIN, matching DittoManager.runExplain on the local path. */
  private async fetchHttpExplain(
    httpReq: { httpApiUrl: string; httpApiKey: string; allowUntrustedCerts: boolean },
    query: string,
  ): Promise<string> {
    if (query.trimStart().toUpperCase().startsWith('EXPLAIN')) { return ''; }
    try {
      const r = await executeRemoteQuery({ ...httpReq, query: `EXPLAIN ${query}` }, this.logger);
      const first = r.items[0];
      if (!first || typeof first !== 'object') { return ''; }
      return JSON.stringify(first, null, 2);
    } catch (err) {
      this.logger.withTag('ext:QueryEditor').warn('HTTP EXPLAIN failed; plan will be unavailable', {
        err: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  private dispose() {
    QueryEditorPanel._instances.delete(this);
    // Each tab owns its own slot in the panel-state store, so we always
    // remove on dispose. Multi-tab restoration replays each saved entry,
    // so leaving slots behind would inflate the tab list on reconnect.
    void this.tracker.removeQueryTab(this.databaseId, this.tabId);
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function randomTabId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
