// src/inspector/InspectorViewProvider.ts
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from './InspectorController.js';
import type { QueryHistoryStore } from '../storage/QueryHistoryStore.js';
import type { QueryFavoritesStore } from '../storage/QueryFavoritesStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorIn, InspectorOut } from '../ipc/messages.js';
import { attachmentContentType, attachmentFilename } from './inspector-state.js';

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
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-ui'),
        vscode.Uri.joinPath(this.context.globalStorageUri, 'inspector-attachments'),
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
    const pushHelpUris = () => {
      this.post({ type: 'inspector.helpHtml', kind: 'subscription', uri: subscriptionHelpUri });
      this.post({ type: 'inspector.helpHtml', kind: 'query',        uri: queryHelpUri });
    };

    this.disposables.push(
      view.webview.onDidReceiveMessage((m: InspectorIn) => { void this.handle(m); }),
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
      const ext = filename?.split('.').pop() ?? 'bin';

      if (save) {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(filename ?? `attachment.${ext}`),
        });
        if (!uri) { return; }
        await fs.writeFile(uri.fsPath, buf);
        this.post({ type: 'inspector.attachmentSaved', tokenId, path: uri.fsPath });
      } else {
        const tmpDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'inspector-attachments');
        await fs.mkdir(tmpDir.fsPath, { recursive: true });
        const tmpFile = path.join(tmpDir.fsPath, `${tokenId}.${ext}`);
        await fs.writeFile(tmpFile, buf);
        const view = this.view;
        if (!view) { return; }
        const webviewUri = view.webview.asWebviewUri(vscode.Uri.file(tmpFile)).toString();
        this.post({
          type: 'inspector.attachmentLoaded',
          tokenId,
          mimeType: contentType,
          webviewUri,
        });
      }
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
    ].join('; ');
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<link rel="stylesheet" href="${codiconUri}">
</head><body>
<ditto-inspector></ditto-inspector>
<script src="${scriptUri}"></script>
</body></html>`;
  }
}
