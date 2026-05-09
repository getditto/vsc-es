import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Logger as DittoLogger } from '@dittolive/ditto';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { SubscriptionStore } from './storage/SubscriptionStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
import { PeerListingPanel } from './panels/PeerListingPanel.js';
import { QueryEditorPanel } from './panels/QueryEditorPanel.js';
import { SubscriptionEditorPanel } from './panels/SubscriptionEditorPanel.js';
import { DittoManager } from './ditto/DittoManager.js';
import { createLogger } from './logging/Logger.js';
import type { Logger } from './logging/types.js';

let logger: Logger;

export function activate(context: vscode.ExtensionContext) {
  const channel = vscode.window.createOutputChannel('Ditto Edge Studio', { log: true });
  context.subscriptions.push(channel);
  const sessionId = crypto.randomUUID();
  const fileDir = path.join(context.globalStorageUri.fsPath, 'logs');
  logger = createLogger({
    channel,
    fileDir,
    sessionId,
    mode: context.extensionMode === vscode.ExtensionMode.Development
      || context.extensionMode === vscode.ExtensionMode.Test
        ? 'development' : 'production',
  });
  context.subscriptions.push({ dispose: () => { void logger.dispose(); } });

  // SDK bridge: pipe Ditto SDK logs into our Logger under the 'sdk' tag.
  const sdkLog = logger.withTag('sdk');
  const sdkMap: Record<string, 'error'|'warn'|'info'|'debug'|'trace'> = {
    Error: 'error', Warning: 'warn', Info: 'info', Debug: 'debug', Verbose: 'trace',
  };
  (DittoLogger as any).customLogCallback = (sdkLevel: string, message: string) => {
    const level = sdkMap[sdkLevel] ?? 'info';
    sdkLog[level](message);
  };

  const log = logger.withTag('ext');

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);
  const subscriptionStore = new SubscriptionStore(context.globalState);
  const manager = new DittoManager(context, logger);

  const treeProvider = new DatabaseTreeProvider(configStore, id => manager.getStatus(id), subscriptionStore);
  context.subscriptions.push(manager.onStatusChange(() => treeProvider.refresh()));
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
      DatabaseEditorPanel.show(context, configStore, secretStore, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.editDatabase', (node) => {
      if (node?.kind !== 'database') { return; }
      DatabaseEditorPanel.show(context, configStore, secretStore, logger, node.config);
    }),
    vscode.commands.registerCommand('dittoVsce.deleteDatabase', async (node) => {
      if (node?.kind !== 'database') { return; }
      if (manager.getActiveConfigId() === node.config.id) { await manager.disconnect(); }
      const ok = await vscode.window.showWarningMessage(
        `Delete database "${node.config.name}"?`, { modal: true }, 'Delete'
      );
      if (ok === 'Delete') {
        await configStore.delete(node.config.id);
        await secretStore.deleteAll(node.config.id);
        await subscriptionStore.deleteAll(node.config.id);
        const dir = vscode.Uri.joinPath(context.globalStorageUri, 'dittoData', node.config.id);
        try { await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }); } catch { /* fine if missing */ }
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', async (node) => {
      if (node?.kind !== 'database') { return; }
      const secrets = await secretStore.read(node.config.id);
      const initialSubs = subscriptionStore.list(node.config.id);
      try {
        await manager.connect(node.config, secrets, initialSubs);
      } catch (err) {
        vscode.window.showErrorMessage(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', async () => {
      await manager.disconnect();
    }),
    vscode.commands.registerCommand('dittoVsce.deleteSubscription', async (node) => {
      if (node?.kind !== 'subscription') { return; }
      const ok = await vscode.window.showWarningMessage(
        `Delete subscription "${node.sub.name}"?`, { modal: true }, 'Delete'
      );
      if (ok === 'Delete') {
        await subscriptionStore.delete(node.databaseId, node.sub.id);
        if (manager.getActiveConfigId() === node.databaseId) {
          manager.cancelSubscription(node.sub.id);
        }
      }
    }),
    vscode.commands.registerCommand('dittoVsce.openPeerListing', (databaseIdOrNode) => {
      const databaseId = typeof databaseIdOrNode === 'string'
        ? databaseIdOrNode
        : databaseIdOrNode?.databaseId;
      if (!databaseId) { return; }
      PeerListingPanel.show(context, manager, configStore, databaseId, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', (node) => {
      const databaseId = node?.kind === 'subscriptionsParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Connect to a database first.');
        return;
      }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, databaseId, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.editSubscription', (node) => {
      if (node?.kind !== 'subscription') { return; }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, node.databaseId, logger, node.sub);
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
      if (!databaseId) { return; }
      QueryEditorPanel.show(context, manager, configStore, databaseId, logger);
    })
  );

  context.subscriptions.push({ dispose: () => manager.disconnect() });
  log.info('Ditto Edge Studio extension activated.');

  process.on('uncaughtException', (err) => {
    log.error('UNCAUGHT EXCEPTION', { stack: err.stack ?? err.message });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('UNHANDLED REJECTION', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });
}

export function deactivate() {
  // logger.dispose() runs via context.subscriptions
}
