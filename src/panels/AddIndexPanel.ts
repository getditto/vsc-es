import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce, webviewMessageHandler } from './webview-utils.js';
import type { DittoCollection, IndexField } from '../models/DittoCollection.js';
import type { AddIndexIn, AddIndexOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';

/** Structural shim — the panel just needs these three methods, so we avoid
 *  coupling to the concrete `CollectionsRepository` symbol (makes tests
 *  trivially fakeable). */
export interface AddIndexCollectionsShim {
  current(): DittoCollection[];
  createIndex(collection: string, fields: readonly IndexField[]): Promise<void>;
  refresh(): Promise<void>;
}

export class AddIndexPanel {
  private static _current: AddIndexPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    collections: AddIndexCollectionsShim,
    logger: Logger,
    preselectedCollection?: string,
  ): void {
    if (AddIndexPanel._current) {
      AddIndexPanel._current.panel.reveal();
      AddIndexPanel._current.init(preselectedCollection);
      return;
    }
    AddIndexPanel._current = new AddIndexPanel(context, collections, logger, preselectedCollection);
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    AddIndexPanel._current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    private readonly collections: AddIndexCollectionsShim,
    private readonly logger: Logger,
    preselectedCollection?: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoAddIndex',
      'Add Index',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark:  vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'addIndex.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Add Index',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
      styleUri,
    });

    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<AddIndexIn | LogIn>(
        this.logger, 'ext:addIndex', 'Add index failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Push initial channel level to webview.
    this.panel.webview.postMessage({ type: 'log.levelChanged', level: logger.getChannelLevel() } satisfies LogOut);

    // Subscribe to level changes; track disposable so we can clean up.
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    // Defer the initial init message slightly so the webview script has
    // mounted its message listener before we post.
    setTimeout(() => this.init(preselectedCollection), 50);
  }

  private init(preselectedCollection?: string): void {
    const names = this.collections.current().map(c => c.name);
    const payload: AddIndexOut = {
      type: 'addIndex.init',
      collections: names,
      preselected: preselectedCollection,
    };
    this.panel.webview.postMessage(payload);
  }

  private post(msg: AddIndexOut): void { this.panel.webview.postMessage(msg); }

  private async handle(msg: AddIndexIn | LogIn): Promise<void> {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoAddIndex');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'addIndex.cancel') {
      this.dispose();
      return;
    }
    if (msg.type === 'addIndex.create') {
      try {
        await this.collections.createIndex(msg.collection, msg.fields);
        await this.collections.refresh();
        this.post({ type: 'addIndex.created' });
        this.dispose();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.post({ type: 'addIndex.error', message });
      }
    }
  }

  private dispose(): void {
    if (AddIndexPanel._current === this) {
      AddIndexPanel._current = undefined;
    }
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
