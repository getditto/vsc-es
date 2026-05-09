import * as vscode from 'vscode';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { SubscriptionStore } from './storage/SubscriptionStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
import { PeerListingPanel } from './panels/PeerListingPanel.js';
import { QueryEditorPanel } from './panels/QueryEditorPanel.js';
import { SubscriptionEditorPanel } from './panels/SubscriptionEditorPanel.js';
import { DittoManager } from './ditto/DittoManager.js';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);
  const subscriptionStore = new SubscriptionStore(context.globalState);
  const manager = new DittoManager(context, output);

  const treeProvider = new DatabaseTreeProvider(configStore, id => manager.getStatus(id), subscriptionStore);
  context.subscriptions.push(manager.onStatusChange(() => treeProvider.refresh()));
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
      DatabaseEditorPanel.show(context, configStore, secretStore);
    }),
    vscode.commands.registerCommand('dittoVsce.editDatabase', (node) => {
      if (node?.kind !== 'database') { return; }
      DatabaseEditorPanel.show(context, configStore, secretStore, node.config);
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
      PeerListingPanel.show(context, manager, configStore, databaseId);
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', (node) => {
      const databaseId = node?.kind === 'subscriptionsParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Connect to a database first.');
        return;
      }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, databaseId);
    }),
    vscode.commands.registerCommand('dittoVsce.editSubscription', (node) => {
      if (node?.kind !== 'subscription') { return; }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, node.databaseId, node.sub);
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
      if (!databaseId) { return; }
      QueryEditorPanel.show(context, manager, configStore, databaseId);
    })
  );

  context.subscriptions.push({ dispose: () => manager.disconnect() });
  output.appendLine('Ditto Edge Studio extension activated.');

  process.on('uncaughtException', (err) => {
    output.appendLine(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    output.appendLine(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
