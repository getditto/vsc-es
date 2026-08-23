// src/inspector/InspectorViewProvider.ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from './InspectorController.js';
import type { QueryHistoryStore } from '../storage/QueryHistoryStore.js';
import type { QueryFavoritesStore } from '../storage/QueryFavoritesStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorIn, InspectorOut } from '../ipc/messages.js';
import { attachmentContentType, attachmentFilename } from './inspector-state.js';
import { webviewMessageHandler } from '../panels/webview-utils.js';
import type { MetricsPreferencesStore } from '../storage/MetricsPreferencesStore.js';
import type { AttachmentCache } from './AttachmentCache.js';

/** Inline previews base64 the whole attachment into a `data:` URI (~1.33×
 *  the bytes on top of the fetched buffer), so they get a hard cap at the
 *  same 20 MB the Query Editor hard-refuses on upload. Anything bigger
 *  still works via the Download/save-to-disk action — it writes straight
 *  to a file the user picked and never round-trips through the webview. */
export const ATTACHMENT_PREVIEW_LIMIT = 20 * 1024 * 1024;

function previewTooLargeMessage(sizeBytes: number): string {
  const mib = sizeBytes / (1024 * 1024);
  return `Attachment is ${mib.toFixed(1)} MB — too large to preview inline `
    + `(limit ${ATTACHMENT_PREVIEW_LIMIT / (1024 * 1024)} MB). Use the Download action to save it to disk.`;
}

/**
 * `WebviewViewProvider` for the auxiliary-bar Ditto Inspector.
 *
 * Owns the webview lifetime; bridges the {@link InspectorController}, history,
 * favorites, and (for query rows) attachment fetching to the embedded webview.
 */
export class InspectorViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dittoVsce.inspector';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: InspectorController,
    private readonly history: QueryHistoryStore,
    private readonly favorites: QueryFavoritesStore,
    private readonly manager: DittoManager,
    private readonly logger: Logger,
    private readonly metricsPrefs: MetricsPreferencesStore,
    private readonly attachmentCache: AttachmentCache,
  ) {}

  /** Re-push the current preferences to the webview. Public so the
   *  "Reset Query Metrics Tips" command can ask us to refresh after
   *  flipping the flag back. */
  pushPreferences(): void {
    const p = this.metricsPrefs.get();
    this.post({ type: 'inspector.preferences', hideLimitHint: p.hideLimitHint });
  }

  /** Re-push the workspace settings the Inspector cares about
   *  (currently just `collectMetrics`). Called on resolve and from the
   *  extension's `onDidChangeConfiguration` listener so the Inspector
   *  reactively hides / shows the Metrics tab. */
  pushSettings(): void {
    const collectMetrics = vscode.workspace
      .getConfiguration('dittoVsce')
      .get<boolean>('collectMetrics', true);
    this.post({ type: 'inspector.settings', collectMetrics });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
      ],
    };
    view.webview.html = this.html(view.webview);

    // Pre-compute the help URIs (extension-relative; the same URIs are valid
    // for the lifetime of the webview) so we can re-push them on every
    // resolve AND every content switch. Posting once at resolve was racy —
    // if VS Code dropped the message before the webview script registered
    // its `message` listener, the help tabs were stuck on "Loading help…".
    const helpDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui', 'help');
    const subscriptionHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'subscription.html')).toString();
    const queryHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'query.html')).toString();
    const presenceHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'presence.html')).toString();
    const metricsHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'metrics.html')).toString();
    const databaseMetricsHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'databaseMetrics.html')).toString();
    const observeHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'observe.html')).toString();
    const logAnalyzerHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'logAnalyzer.html')).toString();
    const patternEditorHelpUri = view.webview.asWebviewUri(vscode.Uri.joinPath(helpDir, 'patternEditor.html')).toString();
    const pushHelpUris = () => {
      this.post({ type: 'inspector.helpHtml', kind: 'subscription',     uri: subscriptionHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'query',            uri: queryHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'presence',         uri: presenceHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'metrics',          uri: metricsHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'databaseMetrics',  uri: databaseMetricsHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'observers',        uri: observeHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'logAnalyzer',      uri: logAnalyzerHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'patternEditor',    uri: patternEditorHelpUri });
    };

    this.disposables.push(
      view.webview.onDidReceiveMessage(webviewMessageHandler<InspectorIn>(
        this.logger, 'ext:inspector', 'Inspector action failed', (m) => this.handle(m),
      )),
    );
    this.disposables.push(
      this.controller.onContentChange((c) => {
        // Re-push help URIs first — cheap, idempotent, and guarantees the
        // help-content-element has a non-empty `uri` by the time the new
        // content lands. Defends against VS Code's message-queue race.
        pushHelpUris();
        this.post({ type: 'inspector.contentChanged', content: c });
        // When content switches to a DB-bound kind, re-push the lists so the
        // History / Favorites tabs reflect that DB's stored entries even if
        // no add/delete event has fired since the webview opened.
        if (c.kind === 'query' || c.kind === 'subscriptions' || c.kind === 'peers') {
          const dbId = c.databaseId;
          this.post({ type: 'inspector.historyChanged',  databaseId: dbId, entries: this.history.list(dbId) });
          this.post({ type: 'inspector.favoritesChanged', databaseId: dbId, entries: this.favorites.list(dbId) });
        }
      }),
    );
    this.disposables.push(
      this.history.onChange(({ databaseId }) => this.post({
        type: 'inspector.historyChanged', databaseId, entries: this.history.list(databaseId),
      })),
    );
    this.disposables.push(
      this.favorites.onChange(({ databaseId }) => this.post({
        type: 'inspector.favoritesChanged', databaseId, entries: this.favorites.list(databaseId),
      })),
    );

    // Push help URIs FIRST so they're sitting in the webview's message queue
    // by the time the script registers its listener — same reason the
    // onContentChange handler above re-posts them on every content switch.
    pushHelpUris();

    // Push the (sticky) Inspector preferences — same defensive path
    // as the help URIs, since the webview's first render needs to
    // know whether to suppress the LIMIT tip.
    this.pushPreferences();

    // Push the workspace settings (collectMetrics gate) so the webview
    // knows whether to render the Metrics tab on first paint.
    this.pushSettings();

    // Push initial state.
    this.post({ type: 'inspector.contentChanged', content: this.controller.getContent() });

    // Push existing history + favorites for the current DB so the lists show
    // immediately on first reveal — without this, the user had to run a query
    // (or a different change event) before any prior-session entries appeared.
    const cur = this.controller.getContent();
    if (cur.kind === 'query' || cur.kind === 'subscriptions' || cur.kind === 'peers') {
      const dbId = cur.databaseId;
      this.post({ type: 'inspector.historyChanged',  databaseId: dbId, entries: this.history.list(dbId) });
      this.post({ type: 'inspector.favoritesChanged', databaseId: dbId, entries: this.favorites.list(dbId) });
    }

    view.onDidDispose(() => {
      for (const d of this.disposables) { try { d.dispose(); } catch { /* ignore */ } }
      this.disposables.length = 0;
      this.view = undefined;
    });
  }

  private post(msg: InspectorOut): void {
    void this.view?.webview.postMessage(msg);
  }

  private async handle(msg: InspectorIn): Promise<void> {
    const log = this.logger.withTag('ext:Inspector');
    const cur = this.controller.getContent();
    switch (msg.type) {
      case 'inspector.tabSelected':
        if (cur.kind === 'query') { void this.controller.setQueryTab(msg.tab); }
        else if (cur.kind === 'observers' && (msg.tab === 'json' || msg.tab === 'help')) {
          void this.controller.setObserverTab(msg.tab);
        }
        return;
      case 'inspector.loadQueryInEditor':
        try {
          await vscode.commands.executeCommand('dittoVsce.openQueryEditorWithText', msg.query);
        } catch (err) {
          log.warn('openQueryEditorWithText command failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      case 'inspector.deleteHistoryEntry':
        if (cur.kind === 'query') { void this.history.delete(cur.databaseId, msg.id); }
        return;
      case 'inspector.addFavorite':
        if (cur.kind === 'query') { void this.favorites.add(cur.databaseId, msg.query); }
        return;
      case 'inspector.removeFavorite':
        if (cur.kind === 'query') { void this.favorites.delete(cur.databaseId, msg.id); }
        return;
      case 'inspector.dismissLimitHint':
        await this.metricsPrefs.dismissLimitHint();
        this.pushPreferences();
        return;
      case 'inspector.fetchAttachment':
        await this.fetchAttachment(msg.token, msg.tokenId, /* save */ false);
        return;
      case 'inspector.saveAttachment':
        await this.fetchAttachment(msg.token, msg.tokenId, /* save */ true);
        return;
    }
  }

  private async fetchAttachment(token: unknown, tokenId: string, save: boolean): Promise<void> {
    const log = this.logger.withTag('ext:Inspector');
    // The webview sends the raw `_meta`-shaped object. Cast to the SDK's expected shape.
    const tokenAny = token as { id: string; len: number | bigint; metadata: { [k: string]: string } };

    // Pre-fetch cap on the DECLARED size: a token that claims > 20 MB is
    // never going to yield an inline preview, so refuse before spending a
    // byte on the SDK fetch. The download/save path is unaffected — it
    // writes to disk, not into the webview.
    const declared = Number(tokenAny.len);
    if (!save && Number.isFinite(declared) && declared > ATTACHMENT_PREVIEW_LIMIT) {
      log.info('Refusing inline preview of oversized attachment', {
        id: tokenAny.id, declaredBytes: declared,
      });
      this.post({ type: 'inspector.attachmentError', tokenId, message: previewTooLargeMessage(declared) });
      return;
    }

    // Cache lookup. Key is (activeDatabaseId, attachmentId) — the same
    // attachment referenced from two different query rows shares an
    // entry. On hit we skip the SDK round-trip entirely; the user gets
    // the preview/save back immediately instead of waiting for another
    // download when they switch tabs and come back. Cache is cleared on
    // disconnect (see extension.ts), so a stale entry can't outlive
    // its database.
    const activeDbId = this.manager.getActiveConfigId();
    if (activeDbId) {
      const cached = this.attachmentCache.get(activeDbId, tokenAny.id);
      if (cached) {
        await this.deliverAttachment(tokenId, save, cached.bytes, cached.mimeType, cached.filename);
        return;
      }
    }

    const fetcher = this.manager.fetchAttachment(tokenAny, (ev) => {
      if (ev.type === 'Progress') {
        const total = Number(ev.totalBytes);
        const downloaded = Number(ev.downloadedBytes);
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((downloaded / total) * 100))) : 0;
        this.post({ type: 'inspector.attachmentProgress', tokenId, pct });
      } else if (ev.type === 'Deleted') {
        this.post({ type: 'inspector.attachmentError', tokenId, message: 'Attachment deleted on remote' });
      }
    });
    if (!fetcher) {
      this.post({ type: 'inspector.attachmentError', tokenId, message: 'No active database' });
      return;
    }
    try {
      const att = await fetcher;
      if (!att) {
        this.post({ type: 'inspector.attachmentError', tokenId, message: 'Fetch returned null' });
        return;
      }
      const buf = await att.data();
      const meta = (att.metadata ?? {}) as Record<string, unknown>;
      // Real-world tokens come from a few different writers — SwiftUI
      // uses `mimeType`/`name`, the Node SDK examples use `contentType`/
      // `filename`. Accept either via the shared helpers so the inline
      // viewer doesn't fall back to "application/octet-stream" for a
      // perfectly-valid image.
      const filename = attachmentFilename(meta);
      const contentType = attachmentContentType(meta) ?? 'application/octet-stream';

      // Populate cache before delivery — a later switch-back will hit.
      // Re-read activeDbId at insertion time in case the user
      // disconnected during the fetch; nothing to cache without a DB.
      const dbIdAtInsert = this.manager.getActiveConfigId();
      if (dbIdAtInsert) {
        this.attachmentCache.set(dbIdAtInsert, tokenAny.id, {
          bytes: buf,
          mimeType: contentType,
          filename,
          sizeBytes: buf.length,
        });
      }

      await this.deliverAttachment(tokenId, save, buf, contentType, filename);
    } catch (err) {
      log.error('Attachment fetch failed', {
        tokenId,
        err: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      this.post({
        type: 'inspector.attachmentError',
        tokenId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Shared "we have the bytes, now hand them to the user" path. Split
   * out so cache hits and fresh fetches converge on identical delivery
   * semantics — the webview can't tell which one happened.
   *
   * `save = true` opens the OS save dialog; cancelling is a silent
   * no-op (matches the prior behaviour). `save = false` posts a
   * `data:` URI to the inline viewer; see the comment block below for
   * why we use data URIs instead of webview resource URIs.
   */
  private async deliverAttachment(
    tokenId: string,
    save: boolean,
    buf: Buffer,
    contentType: string,
    filename: string | undefined,
  ): Promise<void> {
    if (save) {
      const ext = filename?.split('.').pop() ?? 'bin';
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(filename ?? `attachment.${ext}`),
      });
      if (!uri) { return; }
      await fs.writeFile(uri.fsPath, buf);
      this.post({ type: 'inspector.attachmentSaved', tokenId, path: uri.fsPath });
      return;
    }

    // Defense in depth by ACTUAL byte count: the fetch path already
    // refused over-cap tokens by their declared `len`, but a token can
    // lie, and the cache-hit path re-enters here without re-checking the
    // token.
    if (buf.length > ATTACHMENT_PREVIEW_LIMIT) {
      this.post({
        type: 'inspector.attachmentError',
        tokenId,
        message: previewTooLargeMessage(buf.length),
      });
      return;
    }

    // Inline preview path. We send a base64 `data:` URI rather
    // than writing to globalStorageUri + handing back a webview
    // resource URI. The data-URI route is policy-free (img-src
    // already includes `data:` in the inspector's CSP) and
    // sidesteps two failure modes the file-write path was
    // hitting in practice:
    //   1. VS Code's per-webview resource roots for the
    //      auxiliary-bar `WebviewView` quietly rejected requests
    //      against the globalStorageUri subtree on some hosts,
    //      yielding a broken-image icon with no console error.
    //   2. Tokens with `_`/`-` in their id produced filenames
    //      that some platforms URL-encoded inconsistently
    //      between fs.writeFile and asWebviewUri.
    // Trade-off: a 1.6 MB image becomes a ~2.2 MB string sent
    // through postMessage. That's still well within
    // structured-clone's budget; the ATTACHMENT_PREVIEW_LIMIT gate
    // above keeps anything genuinely large off this path entirely.
    const dataUri = `data:${contentType};base64,${buf.toString('base64')}`;
    this.post({
      type: 'inspector.attachmentLoaded',
      tokenId,
      mimeType: contentType,
      webviewUri: dataUri,
    });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui', 'inspector.js'),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<link rel="stylesheet" href="${codiconUri.toString()}">
</head><body>
<ditto-inspector></ditto-inspector>
<script src="${scriptUri.toString()}"></script>
</body></html>`;
  }
}
