import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { StoredSubscription } from '../models/DittoConfig.js';
import type { SubIn, SubOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';

export class SubscriptionEditorPanel {
  private static current: SubscriptionEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionStore,
    manager: DittoManager,
    databaseId: string,
    logger: Logger,
    existing?: StoredSubscription,
  ) {
    if (SubscriptionEditorPanel.current) {
      SubscriptionEditorPanel.current.panel.reveal();
      SubscriptionEditorPanel.current.init(databaseId, existing);
      return;
    }
    SubscriptionEditorPanel.current = new SubscriptionEditorPanel(context, subs, manager, databaseId, logger, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly subs: SubscriptionStore,
    private readonly manager: DittoManager,
    databaseId: string,
    private readonly logger: Logger,
    existing?: StoredSubscription,
  ) {
    this.databaseId = databaseId;
    this.panel = vscode.window.createWebviewPanel(
      'dittoSubscriptionEditor',
      existing ? `Edit Subscription — ${existing.name}` : 'New Subscription',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'subscription.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Subscription',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });
    this.panel.webview.onDidReceiveMessage((msg: SubIn | LogIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Push initial channel level to webview.
    this.panel.webview.postMessage({ type: 'log.levelChanged', level: logger.getChannelLevel() } satisfies LogOut);

    // Subscribe to level changes; track disposable so we can clean up.
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    setTimeout(() => this.init(databaseId, existing), 50);
  }

  private init(databaseId: string, existing?: StoredSubscription) {
    this.databaseId = databaseId;
    const payload: SubOut = {
      type: 'sub.init',
      id: existing?.id,
      name: existing?.name ?? '',
      query: existing?.query ?? ''
    };
    this.panel.webview.postMessage(payload);
  }

  private async handle(msg: SubIn | LogIn) {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoSubscriptionEditor');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'sub.cancel') { this.panel.dispose(); return; }
    if (msg.type === 'sub.save') {
      if (!msg.name.trim() || !msg.query.trim()) {
        vscode.window.showErrorMessage('Name and query are required.');
        return;
      }
      const sub: StoredSubscription = {
        id: msg.id ?? cryptoRandomId(),
        name: msg.name.trim(),
        query: msg.query.trim()
      };
      await this.subs.save(this.databaseId, sub);

      // If active, register/replace with the SDK (Task 16 wires retrofit).
      if (this.manager.getActiveConfigId() === this.databaseId) {
        this.manager.cancelSubscription(sub.id);
        this.manager.registerSubscription(sub.id, sub.query);
      }
      vscode.window.showInformationMessage(`Saved subscription "${sub.name}".`);
      this.panel.dispose();
    }
  }

  private dispose() {
    SubscriptionEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
