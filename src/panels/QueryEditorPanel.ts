import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
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
import type { QueryMetricsStore } from '../storage/QueryMetricsStore.js';
import { executeRemoteQuery } from '../ditto/HttpQueryService.js';
import { extractCollectionName } from '../ditto/import-subscription-parser.js';
import { detectAttachments } from '../inspector/inspector-state.js';

/** Attachment soft / hard size limits (mirrors SwiftUI's 10 MB / 20 MB).
 *  Soft = warn-and-continue; hard = refuse. The SDK's local
 *  `ditto.store.newAttachment` doesn't enforce a server-side limit so
 *  these are policy choices for the extension. */
const ATTACHMENT_SOFT_LIMIT = 10 * 1024 * 1024;
const ATTACHMENT_HARD_LIMIT = 20 * 1024 * 1024;

/**
 * File-type allowlist for attachments. Maps a friendly category label
 * (shown in the VS Code `showOpenDialog` filter dropdown) to the
 * extensions accepted in that category. Excludes executable formats
 * (.exe, .bat, .cmd, .msi, .app, .dmg, .pkg, …) by design — see the
 * docs in `docs/Developer.md` for the security rationale.
 */
const ATTACHMENT_FILE_FILTERS: Record<string, string[]> = {
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'svg'],
  Audio: ['mp3', 'wav', 'aiff', 'm4a', 'ogg', 'flac'],
  Video: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  PDF: ['pdf'],
  Text: ['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'log', 'rtf'],
  Archives: ['zip'],
};

/** Best-effort MIME guess from a file extension. Used to populate the
 *  attachment's `contentType` metadata so the inline viewer in the
 *  Inspector knows how to render it. Falls back to
 *  `application/octet-stream` for anything unrecognised. */
function guessContentType(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    bmp: 'image/bmp', tiff: 'image/tiff', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', aiff: 'audio/aiff',
    m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mkv: 'video/x-matroska', avi: 'video/x-msvideo',
    pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
    csv: 'text/csv', tsv: 'text/tab-separated-values',
    xml: 'application/xml', log: 'text/plain', rtf: 'application/rtf',
    zip: 'application/zip',
  };
  return map[ext] ?? 'application/octet-stream';
}

function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
    metrics: QueryMetricsStore,
    logger: Logger,
  ): QueryEditorPanel {
    const inst = new QueryEditorPanel(
      context, manager, configs, secrets, databaseId, tracker, inspector, history, favorites, metrics, logger,
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
    private readonly metrics: QueryMetricsStore,
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
    if (msg.type === 'query.addAttachment') {
      await this.handleAttachmentAction(msg.rowJson, 'add');
      return;
    }
    if (msg.type === 'query.deleteAttachment') {
      await this.handleAttachmentAction(msg.rowJson, 'delete');
      return;
    }
    if (msg.type === 'query.exportRows') {
      await this.handleExport(msg.json, msg.rowCount);
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
      this.post({
        type: 'query.result',
        rows,
        columns,
        durationMs,
        metadata,
        profile: metadata.profile,
      });
      this.lastMetadata = metadata;
      this.lastSelectedRowJson = null;
      this.inspector.setLastResultMetadata(metadata);
      this.inspector.setSelectedRowJson(null);
      void this.history.add(this.databaseId, msg.query);
      // Capture into the Query Metrics ring buffer so the Query
      // Metrics panel can replay any past query's EXPLAIN. The
      // metadata already carries the location, dql, durationMs,
      // resultCount, explain, and timestamp the panel needs.
      this.metrics.capture(this.databaseId, metadata);
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

  /**
   * Persist the webview-serialised JSON array to disk. The webview has
   * already stringified the ENTIRE result set (not the visible page),
   * so this handler is just: pick a path, write the bytes, ack.
   *
   * Why we don't re-validate the JSON: the webview built it from the
   * in-memory rows that the same panel just produced. A round-trip
   * through `JSON.parse` here would double the memory footprint on a
   * 21k-row export for zero gain.
   *
   * Suggests a filename derived from the current query so a sequence of
   * exports doesn't all land as `query_results.json`: `users.json` for
   * `SELECT * FROM users`, `query_results.json` as the fallback when the
   * collection can't be parsed out (joins, system queries, etc).
   */
  private async handleExport(json: string, rowCount: number): Promise<void> {
    const log = this.logger.withTag('ext:QueryEditor');
    const suggested = this.suggestedExportFilename();
    const defaultPath = vscode.workspace.workspaceFolders?.[0]?.uri
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
      : vscode.Uri.file(suggested);
    const target = await vscode.window.showSaveDialog({
      defaultUri: defaultPath,
      filters: { 'JSON files': ['json'] },
      saveLabel: 'Export',
    });
    if (!target) {
      this.post({ type: 'query.exportCancelled' });
      return;
    }
    try {
      await fs.writeFile(target.fsPath, json);
      log.info('Query results exported', {
        path: target.fsPath,
        rowCount,
        bytes: json.length,
      });
      this.post({ type: 'query.exportDone', rowCount, path: target.fsPath });
      const fileName = target.fsPath.split(/[\\/]/).pop() ?? target.fsPath;
      vscode.window.showInformationMessage(
        `Exported ${rowCount.toLocaleString()} row${rowCount === 1 ? '' : 's'} to ${fileName}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Query export failed', {
        path: target.fsPath,
        err: err instanceof Error ? err.stack ?? message : message,
      });
      this.post({ type: 'query.exportError', message });
    }
  }

  /** Pull the collection from the last-run DQL (we already extract it
   *  for attachment actions) and use it as the default filename. Falls
   *  back to `query_results.json` when the query touches multiple
   *  collections or none. Sanitises so the result is a portable
   *  filename across platforms. */
  private suggestedExportFilename(): string {
    const collection = extractCollectionName(this.lastMetadata?.dql ?? '');
    const base = collection && /^[A-Za-z0-9_\-]+$/.test(collection)
      ? collection
      : 'query_results';
    return `${base}.json`;
  }

  /**
   * Shared entry point for the right-click attachment actions.
   * Validates preconditions (active connection, parseable row,
   * single-collection query) and dispatches. Errors are surfaced as
   * toasts because the right-click flow has no inline error surface.
   */
  private async handleAttachmentAction(rowJson: string, action: 'add' | 'delete'): Promise<void> {
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      vscode.window.showWarningMessage('Connect to this database first.');
      return;
    }
    const lastDql = this.lastMetadata?.dql;
    if (!lastDql) {
      vscode.window.showWarningMessage('Run a query first so we know which collection to target.');
      return;
    }
    const collection = extractCollectionName(lastDql);
    if (!collection || collection.startsWith('__')) {
      vscode.window.showWarningMessage(
        `Attachment actions need a single user collection in the last query (got "${collection ?? 'no FROM clause'}").`,
      );
      return;
    }

    let row: Record<string, unknown>;
    try { row = JSON.parse(rowJson) as Record<string, unknown>; }
    catch {
      vscode.window.showErrorMessage('Could not parse the selected row.');
      return;
    }
    const documentId = typeof row._id === 'string' ? row._id : undefined;
    if (!documentId) {
      vscode.window.showWarningMessage('The selected row has no string `_id` — cannot target it.');
      return;
    }

    if (action === 'add') {
      await this.runAddAttachment(collection, documentId);
    } else {
      await this.runDeleteAttachment(collection, documentId, row);
    }
  }

  /**
   * Detect existing attachment fields on the row, let the user
   * multi-select which to remove, then DQL UPDATE setting them to
   * NULL. The token detection logic is shared with the Inspector
   * viewer (`detectAttachments`) so anything the inspector can show
   * can also be deleted from here.
   */
  private async runDeleteAttachment(
    collection: string,
    documentId: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const log = this.logger.withTag('ext:QueryEditor');

    const attachments = detectAttachments(row);
    if (attachments.length === 0) {
      vscode.window.showInformationMessage('This document has no attachments to delete.');
      return;
    }

    type AttachmentPick = vscode.QuickPickItem & { fieldName: string };
    const items: AttachmentPick[] = attachments.map(a => {
      // `path` from detectAttachments is the dotted path to the token.
      // For simple top-level attachments it's just the field name. For
      // nested or array entries it could be `field.sub` or `field[0]` —
      // we only support clearing top-level fields for now (reflected
      // in the disabled state below).
      const fieldName = a.path.split(/[.[]/, 1)[0] ?? a.path;
      const sizeStr = a.metadata.length ? formatBytes(a.metadata.length) : '';
      const filenameStr = a.metadata.filename ?? '(unnamed)';
      const detail = [filenameStr, sizeStr, a.metadata.contentType]
        .filter(Boolean).join(' · ');
      return { label: a.path, description: detail, fieldName };
    });
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Delete attachments on ${collection}/${documentId}`,
      placeHolder: 'Select fields to clear',
    });
    if (!picked || picked.length === 0) { return; }

    // Confirm — destructive op, modal so the user can't dismiss
    // accidentally.
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${picked.length} attachment${picked.length === 1 ? '' : 's'} from ${collection}/${documentId}? This sets the field${picked.length === 1 ? '' : 's'} to NULL on the document.`,
      { modal: true },
      'Delete',
    );
    if (confirm !== 'Delete') { return; }

    // Build the SET clause. Field names came out of detectAttachments —
    // they are dotted paths from the document root. We split on the
    // first dot/[ and clear that top-level field, which removes the
    // attachment whether it's a direct token or a nested object.
    const fieldNames = [...new Set(picked.map(p => p.fieldName))];
    if (fieldNames.some(f => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f))) {
      vscode.window.showErrorMessage('Attachment field names must be plain identifiers; cannot delete.');
      return;
    }
    const setClause = fieldNames.map(f => `${f} = NULL`).join(', ');
    const dql = `UPDATE ${collection} SET ${setClause} WHERE _id = :docId`;

    try {
      await this.manager.executeRaw(dql, { docId: documentId });
      vscode.window.showInformationMessage(
        `Cleared ${fieldNames.length} attachment field${fieldNames.length === 1 ? '' : 's'} on ${collection}/${documentId}.`,
      );
      log.info('Attachment(s) deleted', { collection, documentId, fields: fieldNames });

      // Refresh results so the cleared fields disappear from the row.
      const lastDql = this.lastMetadata?.dql;
      if (lastDql) {
        try { await this.handle({ type: 'query.run', query: lastDql, mode: 'local' }); }
        catch { /* surfaced via the post path inside handle */ }
      }
    } catch (err) {
      log.error('Attachment delete failed', {
        err: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      vscode.window.showErrorMessage(
        `Delete attachment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Native VS Code dialog walkthrough for adding an attachment to a
   * document via DQL UPDATE. Local-mode only for now (HTTP mode is a
   * follow-up). File-type allowlist on `showOpenDialog`'s filter
   * restricts the picker to image/audio/video/pdf/text/zip — no
   * executable formats. Soft-warns at 10 MB; hard-refuses at 20 MB.
   */
  private async runAddAttachment(collection: string, documentId: string): Promise<void> {
    const log = this.logger.withTag('ext:QueryEditor');

    // 1. File picker — VS Code's `filters` give the user a friendly
    //    "Images / Audio / Video / …" dropdown AND restrict the pickable
    //    extensions. The host environment ultimately enforces the
    //    allowlist; we re-validate the chosen extension below as
    //    defense-in-depth in case a user types a path manually.
    const allowed = ATTACHMENT_FILE_FILTERS;
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: false,
      canSelectFiles: true,
      title: `Add attachment to ${collection}/${documentId}`,
      filters: allowed,
    });
    if (!picked || picked.length === 0) { return; }
    const fileUri = picked[0];
    const filePath = fileUri.fsPath;
    const filename = filePath.split(/[\\/]/).pop() ?? 'file';
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (!Object.values(allowed).some(exts => exts.includes(ext))) {
      vscode.window.showWarningMessage(
        `File type ".${ext}" is not on the attachment allowlist. Pick an image, audio, video, PDF, text, or zip file.`,
      );
      return;
    }

    // 2. Size check — soft warn at 10 MB, hard refuse at 20 MB.
    let size = 0;
    let contentType = 'application/octet-stream';
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      size = stat.size;
    } catch (err) {
      vscode.window.showErrorMessage(
        `Could not read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (size > ATTACHMENT_HARD_LIMIT) {
      vscode.window.showErrorMessage(
        `${filename} is ${formatBytes(size)} — over the ${formatBytes(ATTACHMENT_HARD_LIMIT)} limit. Cannot upload.`,
      );
      return;
    }
    if (size > ATTACHMENT_SOFT_LIMIT) {
      const proceed = await vscode.window.showWarningMessage(
        `${filename} is ${formatBytes(size)}. Files over ${formatBytes(ATTACHMENT_SOFT_LIMIT)} can be slow to sync over peer-to-peer. Continue?`,
        { modal: true }, 'Upload',
      );
      if (proceed !== 'Upload') { return; }
    }
    contentType = guessContentType(ext);

    // 3. Field name — must be a valid DQL identifier so it can be
    //    interpolated unquoted into the UPDATE statement.
    const fieldName = await vscode.window.showInputBox({
      title: 'Attachment field name',
      prompt: `Field on ${collection} that will hold the attachment token`,
      validateInput: (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())
        ? null : 'Letters, numbers, underscores only; must start with a letter or underscore.',
    });
    if (!fieldName) { return; }
    const field = fieldName.trim();

    // 4. Upload + link.
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Uploading ${filename}…`,
          cancellable: false,
        },
        async () => {
          const att = await this.manager.newAttachment(filePath, {
            filename,
            contentType,
            length: String(size),
          });
          await this.manager.executeRaw(
            `UPDATE ${collection} SET ${field} = :att WHERE _id = :docId`,
            { att, docId: documentId },
          );
        },
      );
      vscode.window.showInformationMessage(
        `Attached ${filename} to ${collection}/${documentId}.${field}.`,
      );
      log.info('Attachment added', { collection, documentId, field, filename, size });

      // Re-run the last query so the new attachment field shows up in
      // the results immediately. Best-effort — failures here just leave
      // the user looking at stale rows; they can hit Run themselves.
      const lastDql = this.lastMetadata?.dql;
      if (lastDql) {
        try {
          await this.handle({ type: 'query.run', query: lastDql, mode: 'local' });
        } catch { /* surfaced via the post path inside handle */ }
      }
    } catch (err) {
      log.error('Attachment add failed', {
        err: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      vscode.window.showErrorMessage(
        `Add attachment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
