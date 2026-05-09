import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { PeerIn, PeerOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';

export class PeerListingPanel {
  private static current: PeerListingPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    databaseId: string,
    tracker: OpenPanelsTracker,
    logger: Logger,
  ) {
    if (PeerListingPanel.current) {
      PeerListingPanel.current.panel.reveal();
      PeerListingPanel.current.refreshTitle(databaseId, configs);
      PeerListingPanel.current.pushState();
      return;
    }
    PeerListingPanel.current = new PeerListingPanel(context, manager, configs, databaseId, tracker, logger);
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
    private readonly logger: Logger,
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
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css')
    );
    this.panel.webview.html = panelHtml({
      title: 'Peer Listing',
      scriptUri,
      styleUri,
      cspSource: this.panel.webview.cspSource
    });

    this.panel.webview.onDidReceiveMessage((msg: PeerIn | LogIn) => this.handle(msg), undefined, this.disposables);
    this.disposables.push(this.manager.onPresence(() => this.pushState()));
    this.disposables.push(this.manager.onStatusChange(() => this.pushState()));
    this.disposables.push(this.manager.onSyncChange(() => this.pushState()));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Push initial channel level to webview.
    this.panel.webview.postMessage({ type: 'log.levelChanged', level: logger.getChannelLevel() } satisfies LogOut);

    // Subscribe to level changes; track disposable so we can clean up.
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    void tracker.add(databaseId, 'peers');
    this.disposables.push({ dispose: () => { void tracker.remove(databaseId, 'peers'); } });

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

  private async handle(msg: PeerIn | LogIn) {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoPeerListing');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
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
