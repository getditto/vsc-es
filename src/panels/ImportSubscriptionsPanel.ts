import * as vscode from 'vscode';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { ImportSubsIn, ImportSubsOut } from '../ipc/messages.js';
import type { StoredSubscription } from '../models/DittoConfig.js';
import { executeRemoteQuery } from '../ditto/HttpQueryService.js';
import {
  toImportableSubscriptions,
  extractCollectionName,
  type SmallPeerInfo,
} from '../ditto/import-subscription-parser.js';
import { randomId } from '../util/id.js';

/**
 * Webview panel that fetches subscriptions known to the Ditto Server
 * (`SELECT * FROM __small_peer_info` over the REST API), presents them
 * as a checklist, and bulk-creates {@link StoredSubscription}s for any
 * the user selects. Only ever opened by the
 * `dittoVsce.importSubscriptionsFromServer` command after the host has
 * confirmed the connection has both an `httpApiUrl` and an `httpApiKey`
 * secret — the panel itself trusts those preconditions.
 *
 * Singleton per running extension; calling `show()` while a panel is
 * already open reuses it (matches the SubscriptionEditorPanel pattern).
 */
export class ImportSubscriptionsPanel {
  private static current: ImportSubscriptionsPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    secretStore: SecretStore,
    subs: SubscriptionStore,
    manager: DittoManager,
    databaseId: string,
    logger: Logger,
  ) {
    if (ImportSubscriptionsPanel.current) {
      if (ImportSubscriptionsPanel.current.databaseId === databaseId) {
        ImportSubscriptionsPanel.current.panel.reveal();
        return;
      }
      ImportSubscriptionsPanel.current.dispose();
    }
    ImportSubscriptionsPanel.current = new ImportSubscriptionsPanel(
      context, configStore, secretStore, subs, manager, databaseId, logger,
    );
  }

  /** Dispose the open panel, if any. Called on database
   *  switch/disconnect/delete — the panel's server-side subscription list
   *  and target databaseId belong to the connection it was opened against,
   *  so leaving it open would write subscriptions into the wrong store. */
  static dispose(): void {
    ImportSubscriptionsPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore,
    private readonly secretStore: SecretStore,
    private readonly subs: SubscriptionStore,
    private readonly manager: DittoManager,
    private readonly databaseId: string,
    private readonly logger: Logger,
  ) {
    const cfg = configStore.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoImportSubscriptions',
      `Import Subscriptions — ${cfg?.name ?? 'Unknown'}`,
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
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'importSubscriptions.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Import Subscriptions',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<ImportSubsIn>(
        this.logger, 'ext:importSubs', 'Import subscriptions failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Kick off the fetch once the webview has had a tick to register
    // its `message` listener — same defensive delay the other panels
    // use to defeat VS Code's message-queue race.
    setTimeout(() => { void this.fetchAndPost(); }, 50);
  }

  private post(msg: ImportSubsOut): void { void this.panel.webview.postMessage(msg); }

  private async fetchAndPost(): Promise<void> {
    const log = this.logger.withTag('ext:ImportSubscriptions');
    this.post({ type: 'importSubs.loading' });

    const cfg = this.configStore.get(this.databaseId);
    if (!cfg) {
      this.post({ type: 'importSubs.error', message: 'Connection no longer exists.' });
      return;
    }

    let secrets;
    try {
      secrets = await this.secretStore.read(this.databaseId);
    } catch (err) {
      this.post({
        type: 'importSubs.error',
        message: `Could not read secrets: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (!cfg.httpApiUrl || !secrets.httpApiKey) {
      this.post({
        type: 'importSubs.error',
        message: 'This connection does not have an HTTP API URL and key configured.',
      });
      return;
    }

    try {
      const response = await executeRemoteQuery({
        httpApiUrl: cfg.httpApiUrl,
        httpApiKey: secrets.httpApiKey,
        allowUntrustedCerts: cfg.allowUntrustedCerts,
        query: 'SELECT * FROM __small_peer_info',
      }, this.logger);

      const peers = response.items.filter(isSmallPeerInfo);
      const existing = this.subs.list(this.databaseId);
      const importable = toImportableSubscriptions(peers, existing);
      log.info('Fetched subscriptions from server', {
        peerCount: peers.length,
        importableCount: importable.length,
      });
      this.post({ type: 'importSubs.loaded', subscriptions: importable });
    } catch (err) {
      log.error('Import fetch failed', {
        err: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      this.post({
        type: 'importSubs.error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handle(msg: ImportSubsIn): Promise<void> {
    if (msg.type === 'importSubs.cancel') { this.panel.dispose(); return; }
    if (msg.type === 'importSubs.importSelected') {
      await this.importSelected(msg.queries);
    }
  }

  private async importSelected(queries: string[]): Promise<void> {
    const log = this.logger.withTag('ext:ImportSubscriptions');
    let imported = 0;
    for (const [idx, query] of queries.entries()) {
      const collection = extractCollectionName(query) ?? 'unknown';
      this.post({
        type: 'importSubs.importing',
        status: `Importing ${idx + 1} of ${queries.length}: ${collection}…`,
      });

      const sub: StoredSubscription = {
        id: randomId(16),
        name: `Imported: ${collection}`,
        query,
      };
      try {
        await this.subs.save(this.databaseId, sub);
        // Register the subscription with the running SDK if this is the
        // active connection — keeps imported subscriptions live without
        // requiring a reconnect, matching the new-subscription flow.
        if (this.manager.getActiveConfigId() === this.databaseId) {
          this.manager.registerSubscription(sub.id, sub.query);
        }
        imported += 1;
      } catch (err) {
        log.warn('Failed to save imported subscription', {
          query,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // The CollectionsRepository's live __collections observer picks
    // up any new collections automatically as data syncs in — no
    // post-import polling needed.
    this.post({ type: 'importSubs.imported', count: imported });
    vscode.window.showInformationMessage(
      `Imported ${imported} subscription${imported === 1 ? '' : 's'}.`,
    );
    this.panel.dispose();
  }

  private dispose() {
    ImportSubscriptionsPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

/**
 * Conservative runtime check — the server *should* return
 * `__small_peer_info`-shaped objects, but we guard against schema
 * surprises rather than letting `as` casts paper over a malformed row
 * and crash the parser.
 */
function isSmallPeerInfo(value: unknown): value is SmallPeerInfo {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { _id?: unknown })._id === 'string';
}
