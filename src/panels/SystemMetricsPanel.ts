import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce, webviewMessageHandler } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { SysMetricsIn, SysMetricsOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { SystemMetricsService } from '../ditto/SystemMetricsService.js';
import type { SystemMetricsHub, SystemMetricsHandle } from '../ditto/SystemMetricsHub.js';
import { readPins, writePins } from '../storage/system-metrics-pins.js';

/**
 * Webview panel for the "System Metrics" screen (SDK 5.1 `system:metrics`),
 * split out of the Database Metrics panel so the always-on polling
 * dashboard no longer shares a screen with the on-demand storage walk.
 *
 * `system:metrics` reads FLUSH the SDK's registry and return per-read
 * deltas, so the value is in a continuous time series, not a point
 * snapshot. SystemMetricsService polls every {@link DEFAULT_POLL_INTERVAL_MS}
 * while the panel is visible and accumulates since-connect totals.
 * Because reads flush, polling is tied strictly to panel visibility — an
 * invisible panel poll would still flush counters while producing numbers
 * nobody sees.
 *
 * Per-DB scope: singleton, opening on a different DB disposes the
 * previous panel (matches DatabaseMetricsPanel / PeerListingPanel /
 * QueryMetricsPanel).
 */
export class SystemMetricsPanel {
  private static current: SystemMetricsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    manager: DittoManager,
    databaseId: string,
    inspector: InspectorController,
    logger: Logger,
    metricsHub: SystemMetricsHub,
  ): void {
    if (SystemMetricsPanel.current) {
      if (SystemMetricsPanel.current.databaseId === databaseId) {
        SystemMetricsPanel.current.panel.reveal();
        return;
      }
      logger.warn('SystemMetricsPanel.show called for a different DB; disposing.', {
        currentDb: SystemMetricsPanel.current.databaseId, requestedDb: databaseId,
      });
      SystemMetricsPanel.current.dispose();
    }
    SystemMetricsPanel.current = new SystemMetricsPanel(
      context, configs, manager, databaseId, inspector, logger, metricsHub,
    );
    autoRevealInspectorOnce(context);
  }

  static dispose(): void {
    SystemMetricsPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly systemMetrics: SystemMetricsService;
  private readonly metricsHandle: SystemMetricsHandle;
  private readonly globalState: vscode.Memento;

  private constructor(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    _manager: DittoManager,
    private readonly databaseId: string,
    private readonly inspector: InspectorController,
    private readonly logger: Logger,
    metricsHub: SystemMetricsHub,
  ) {
    this.globalState = context.globalState;
    const cfg = configs.get(databaseId);

    this.panel = vscode.window.createWebviewPanel(
      'dittoSystemMetrics',
      `System Metrics — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'systemMetrics.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'System Metrics',
      scriptUri,
      styleUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<SysMetricsIn>(
        this.logger, 'ext:sysMetrics', 'System metrics action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // The hub owns the shared per-connection accumulator: the panel is one
    // (pauseable) consumer; the MCP get_system_metrics tool reads the SAME
    // since-connect totals instead of running a competing accumulator that
    // would race the panel for the registry's per-read deltas. The handle
    // starts unpaused; the view-state listener ties ticking to visibility
    // (an invisible panel poll would still flush counters while producing
    // numbers nobody sees).
    this.metricsHandle = metricsHub.acquire(
      this.databaseId,
      (status) => this.post({ type: 'sysMetrics.status', status }),
    );
    this.systemMetrics = this.metricsHandle.service;

    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        const p = e.webviewPanel;
        if (p.visible) {
          this.metricsHandle.resume();
        } else {
          this.metricsHandle.pause();
        }
        if (p.active) {
          this.inspector.setActiveFeature({ kind: 'systemMetrics', databaseId: this.databaseId });
        }
      }),
    );

    // The panel opens visible (creation doesn't fire onDidChangeViewState).
    if (this.panel.visible) {
      this.metricsHandle.resume();
    } else {
      this.metricsHandle.pause();
    }

    // Push the persisted pinned-series list. Deferred by one tick so the
    // webview's message listener is wired before we deliver — same
    // defensive race-defeat every other panel uses.
    setTimeout(() => {
      this.post({ type: 'sysMetrics.pins', pins: readPins(context.globalState, this.databaseId) });
    }, 50);
  }

  private post(msg: SysMetricsOut): void { void this.panel.webview.postMessage(msg); }

  private async handle(msg: SysMetricsIn): Promise<void> {
    if (msg.type === 'sysMetrics.refresh') {
      // Publish happens via the service's onStatus; the promise only
      // needs observing so a rejected poll can't escape unhandled.
      await this.systemMetrics.refreshNow();
      return;
    }
    if (msg.type === 'sysMetrics.setPins') {
      // The webview sends the complete list on every edit and holds the
      // rendered truth, so we only persist — no echo back.
      await writePins(this.globalState, this.databaseId, msg.pins);
      return;
    }
  }

  private dispose() {
    SystemMetricsPanel.current = undefined;
    this.metricsHandle.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
