import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { PeerIn, PeerOut } from '../ipc/messages.js';

export class PeerListingPanel {
  private static current: PeerListingPanel | undefined;

  static show(context: vscode.ExtensionContext, manager: DittoManager, configs: ConfigStore, databaseId: string) {
    if (PeerListingPanel.current) {
      PeerListingPanel.current.panel.reveal();
      PeerListingPanel.current.refreshTitle(databaseId, configs);
      PeerListingPanel.current.pushState();
      return;
    }
    PeerListingPanel.current = new PeerListingPanel(context, manager, configs, databaseId);
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
      'dittoPeerListing',
      `Peers — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'peers.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Peer Listing',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });

    this.panel.webview.onDidReceiveMessage((msg: PeerIn) => this.handle(msg), undefined, this.disposables);
    this.disposables.push(this.manager.onPresence(() => this.pushState()));
    this.disposables.push(this.manager.onStatusChange(() => this.pushState()));
    this.disposables.push(this.manager.onSyncChange(() => this.pushState()));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    setTimeout(() => this.pushState(), 50);
  }

  private refreshTitle(databaseId: string, configs: ConfigStore) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel.title = `Peers — ${cfg?.name ?? 'Unknown'}`;
  }

  private pushState() {
    const active = this.manager.getActiveConfigId() === this.databaseId;
    this.post({
      type: 'peer.state',
      snapshot: active ? this.manager.getLatestSnapshot() : { local: null, remote: [] },
      sync: active ? this.manager.getSyncState() : 'idle'
    });
  }

  private post(msg: PeerOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: PeerIn) {
    if (msg.type === 'peer.toggleSync') {
      await this.manager.toggleSync();
      // pushState fires automatically via onSyncChange listener.
    }
  }

  private dispose() {
    PeerListingPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
