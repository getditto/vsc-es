import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce, webviewMessageHandler } from './webview-utils.js';
import type { ObserverStore } from '../storage/ObserverStore.js';
import type { StoredObserver } from '../models/StoredObserver.js';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { SubIn, SubOut } from '../ipc/messages.js';
import { ObserverPanel } from './ObserverPanel.js';
import { randomId } from '../util/id.js';

/** Editor for creating/renaming an observer. Reuses the existing
 *  subscription-form webview bundle (`subscription.js`) because the
 *  form fields are identical — name + DQL query. The IPC contract
 *  also reuses `SubIn`/`SubOut`; we just save to `ObserverStore`
 *  on `sub.save` instead of `SubscriptionStore`. */
export class ObserverEditorPanel {
  private static current: ObserverEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    observers: ObserverStore,
    databaseId: string,
    inspector: InspectorController,
    logger: Logger,
    existing?: StoredObserver,
  ): void {
    if (ObserverEditorPanel.current) {
      if (ObserverEditorPanel.current.databaseId === databaseId) {
        ObserverEditorPanel.current.panel.reveal();
        ObserverEditorPanel.current.init(databaseId, existing);
        return;
      }
      ObserverEditorPanel.current.dispose();
    }
    ObserverEditorPanel.current = new ObserverEditorPanel(context, observers, databaseId, inspector, logger, existing);
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    ObserverEditorPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly observers: ObserverStore,
    databaseId: string,
    inspector: InspectorController,
    private readonly logger: Logger,
    existing?: StoredObserver,
  ) {
    this.databaseId = databaseId;
    this.panel = vscode.window.createWebviewPanel(
      'dittoObserverEditor',
      existing ? `Edit Observer — ${existing.name}` : 'New Observer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'subscription.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Observer',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<SubIn>(
        this.logger, 'ext:observerEditor', 'Save observer failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          // Observer editor tab → inspector shows the same Subscriptions
          // help today (a future task can add an observers-specific tab).
          inspector.setActiveFeature({ kind: 'subscriptions', databaseId: this.databaseId });
        }
      }),
    );

    setTimeout(() => this.init(databaseId, existing), 50);
  }

  private init(databaseId: string, existing?: StoredObserver): void {
    this.databaseId = databaseId;
    const payload: SubOut = {
      type: 'sub.init',
      id: existing?.id,
      name: existing?.name ?? '',
      query: existing?.query ?? '',
    };
    this.panel.webview.postMessage(payload);
  }

  private async handle(msg: SubIn): Promise<void> {
    if (msg.type === 'sub.cancel') { this.panel.dispose(); return; }
    if (msg.type === 'sub.save') {
      if (!msg.name.trim() || !msg.query.trim()) {
        vscode.window.showErrorMessage('Name and query are required.');
        return;
      }
      // Light validation — observers only support SELECT statements.
      if (!/^\s*SELECT\b/i.test(msg.query)) {
        vscode.window.showErrorMessage('Observer queries must be SELECT statements.');
        return;
      }
      const observer: StoredObserver = {
        id: msg.id ?? randomId(16),
        name: msg.name.trim(),
        query: msg.query.trim(),
      };
      await this.observers.save(this.databaseId, observer);
      // Sync any already-open ObserverPanel for this observer so a
      // rename / query rewrite is reflected immediately (title +
      // toolbar + restart of the SDK observer against the new query).
      ObserverPanel.refreshIfOpen(this.databaseId, observer);
      vscode.window.showInformationMessage(`Saved observer "${observer.name}".`);
      this.panel.dispose();
    }
  }

  private dispose(): void {
    ObserverEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
