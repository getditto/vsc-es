import * as vscode from 'vscode';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);

  const treeProvider = new DatabaseTreeProvider(configStore, () => 'idle');
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  // placeholder commands (real impls in later tasks)
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
      const ok = await vscode.window.showWarningMessage(
        `Delete database "${node.config.name}"?`, { modal: true }, 'Delete'
      );
      if (ok === 'Delete') {
        await configStore.delete(node.config.id);
        await secretStore.deleteAll(node.config.id);
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', () => {
      vscode.window.showInformationMessage('Connect — not implemented yet (Task 9).');
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', () => {
      vscode.window.showInformationMessage('Disconnect — not implemented yet (Task 9).');
    }),
    vscode.commands.registerCommand('dittoVsce.openPeerListing', () => {
      vscode.window.showInformationMessage('Peer Listing — not implemented yet (Task 11).');
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', () => {
      vscode.window.showInformationMessage('New Subscription — not implemented yet (Task 14).');
    })
  );

  output.appendLine('Ditto Edge Studio extension activated.');
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
