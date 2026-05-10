import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce } from './webview-utils.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { PeerIn, PeerOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import { detectPlatform, transportSupportFor } from '../util/platform.js';
import { readLocalNetworkInterfaces } from '../util/local-network.js';

export class PeerListingPanel {
  private static current: PeerListingPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    databaseId: string,
    tracker: OpenPanelsTracker,
    inspector: InspectorController,
    logger: Logger,
  ) {
    if (PeerListingPanel.current) {
      if (PeerListingPanel.current.databaseId === databaseId) {
        PeerListingPanel.current.panel.reveal();
        PeerListingPanel.current.pushState();
        return;
      }
      // Different DB requested — should not normally happen because the
      // lifecycle disposes us before connecting elsewhere. Fall through and replace.
      logger.warn('PeerListingPanel.show called for a different DB than current; disposing.', {
        currentDb: PeerListingPanel.current.databaseId, requestedDb: databaseId,
      });
      PeerListingPanel.current.dispose();
    }
    PeerListingPanel.current = new PeerListingPanel(context, manager, configs, databaseId, tracker, inspector, logger);
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    PeerListingPanel.current?.dispose();
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
    inspector: InspectorController,
    private readonly logger: Logger,
  ) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoPeerListing',
      `Presence — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark:  vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
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

    void tracker.setPeers(databaseId, true);
    this.disposables.push({ dispose: () => { void tracker.setPeers(databaseId, false); } });

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          inspector.setActiveFeature({ kind: 'peers', databaseId: this.databaseId });
        }
      })
    );

    setTimeout(() => {
      this.pushState();
      this.postPlatformInit();
      this.postLocalNetwork();
    }, 50);
  }

  /** One-shot snapshot of the host's local network interfaces. Pushed
   *  on resolve and again whenever the webview asks for a refresh
   *  (`peer.refreshLocalNetwork`). Cheap — `os.networkInterfaces()`
   *  is in-process. */
  private postLocalNetwork() {
    this.post({ type: 'peer.localNetwork', interfaces: readLocalNetworkInterfaces() });
  }

  private pushState() {
    const active = this.manager.getActiveConfigId() === this.databaseId;
    this.post({
      type: 'peer.state',
      snapshot: active ? this.manager.getLatestSnapshot() : { local: null, remote: [] },
      sync: active ? this.manager.getSyncState() : 'idle'
    });
  }

  /** Post the platform support matrix + the active config's current
   *  transport prefs to the webview. Sent on resolve and again after each
   *  successful applyTransportConfig so the popover baseline stays in sync. */
  private postPlatformInit() {
    const platform = detectPlatform();
    const support = transportSupportFor(platform);
    const cfg = this.configs.get(this.databaseId);
    const current = {
      isLanEnabled: cfg?.isLanEnabled ?? true,
      isBluetoothLeEnabled: cfg?.isBluetoothLeEnabled ?? support.bluetoothLE,
      isAwdlEnabled: cfg?.isAwdlEnabled ?? support.awdl,
    };
    this.post({
      type: 'peer.platformInit',
      platform,
      support: { lan: support.lan, bluetoothLE: support.bluetoothLE, awdl: support.awdl },
      current,
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
      return;
    }
    if (msg.type === 'peer.refreshLocalNetwork') {
      this.postLocalNetwork();
      return;
    }
    if (msg.type === 'peer.applyTransportConfig') {
      this.post({ type: 'peer.transportApplyStatus', step: 'stoppingSync' });
      try {
        await this.manager.applyTransportConfig({
          isLanEnabled: msg.isLanEnabled,
          isBluetoothLeEnabled: msg.isBluetoothLeEnabled,
          isAwdlEnabled: msg.isAwdlEnabled,
        });
        this.post({ type: 'peer.transportApplyStatus', step: 'complete' });
        // Re-push the platform init so the webview's baseline matches the
        // newly-persisted config.
        this.postPlatformInit();
      } catch (err) {
        this.post({
          type: 'peer.transportApplyError',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
  }

  private dispose() {
    PeerListingPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
