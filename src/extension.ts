import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Logger as DittoLogger } from '@dittolive/ditto';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { SubscriptionStore } from './storage/SubscriptionStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import { LoggingTreeProvider } from './tree/LoggingTreeProvider.js';
import { HelpTreeProvider } from './tree/HelpTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
import { PeerListingPanel } from './panels/PeerListingPanel.js';
import { QueryEditorPanel } from './panels/QueryEditorPanel.js';
import { SubscriptionEditorPanel } from './panels/SubscriptionEditorPanel.js';
import { DittoManager } from './ditto/DittoManager.js';
import { createLogger } from './logging/Logger.js';
import type { Logger, LogLevel } from './logging/types.js';

let logger: Logger;

const sdkLevelMap: Record<LogLevel, string> = {
  error: 'Error', warn: 'Warning', info: 'Info', debug: 'Debug', trace: 'Verbose',
};

async function pickLogLevel(current: LogLevel, title: string): Promise<LogLevel | undefined> {
  const items = (['error', 'warn', 'info', 'debug', 'trace'] as LogLevel[]).map(l => ({
    label: l,
    description: l === current ? '(current)' : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, { title });
  return picked?.label as LogLevel | undefined;
}

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

  const loggingProvider = new LoggingTreeProvider(logger);
  context.subscriptions.push(vscode.window.createTreeView('dittoLogging', { treeDataProvider: loggingProvider }));

  const helpProvider = new HelpTreeProvider();
  context.subscriptions.push(vscode.window.createTreeView('dittoHelp', { treeDataProvider: helpProvider }));

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
        `Delete connection "${node.config.name}"?`, { modal: true }, 'Delete'
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
        vscode.window.showWarningMessage('Open a connection first.');
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
    }),
    vscode.commands.registerCommand('dittoVsce.setApplicationLogLevel', async () => {
      const picked = await pickLogLevel(logger.getChannelLevel(), 'Set Application Log Level');
      if (picked) { logger.setChannelLevel(picked); }
    }),
    vscode.commands.registerCommand('dittoVsce.setDittoSdkLogLevel', async () => {
      const picked = await pickLogLevel(logger.getSdkLevel(), 'Set Ditto SDK Log Level');
      if (picked) {
        logger.setSdkLevel(picked);
        (DittoLogger as any).minimumLogLevel = sdkLevelMap[picked];
      }
    }),
    vscode.commands.registerCommand('dittoVsce.openOutputChannel', () => {
      channel.show();
    }),
    vscode.commands.registerCommand('dittoVsce.exportLogs', async () => {
      const ok = await vscode.window.showWarningMessage(
        'The exported log may contain document data from your databases. Review before sharing.',
        { modal: true },
        'Open in Editor',
      );
      if (ok !== 'Open in Editor') { return; }
      const combined = await logger.readAllLogs();
      const doc = await vscode.workspace.openTextDocument({ language: 'log', content: combined });
      await vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('dittoVsce.showLogFile', () => {
      vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.joinPath(context.globalStorageUri, 'logs', 'ditto-edge-studio.log'),
      );
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
