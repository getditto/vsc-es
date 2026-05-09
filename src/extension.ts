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
import { OpenPanelsTracker } from './ditto/OpenPanelsTracker.js';
import { createLogger } from './logging/Logger.js';
import type { Logger, LogLevel } from './logging/types.js';
import type { StoredDittoConfig } from './models/DittoConfig.js';

let logger: Logger;

interface PerformSwitchOpts {
  context: vscode.ExtensionContext;
  manager: DittoManager;
  configStore: ConfigStore;
  secretStore: SecretStore;
  subStore: SubscriptionStore;
  tracker: OpenPanelsTracker;
  logger: Logger;
  fromActive: { id: string; name: string } | null;
  to: StoredDittoConfig;
}

async function performSwitch(opts: PerformSwitchOpts): Promise<void> {
  const { configStore, secretStore, subStore, tracker, manager, logger, fromActive, to } = opts;
  const log = logger.withTag('ext:switch');

  // 1. Pre-switch warning if fromActive has open panels.
  if (fromActive) {
    const open = tracker.list(fromActive.id);
    if (open.length > 0) {
      const labels = open.map(k => k === 'query' ? `Query — ${fromActive.name}` : `Peers — ${fromActive.name}`);
      const ok = await vscode.window.showWarningMessage(
        `Switching to "${to.name}" will close ${open.length} open panels for "${fromActive.name}":\n` +
          `   • ${labels.join('\n   • ')}\n\n` +
          `These will reopen automatically the next time you connect to "${fromActive.name}".`,
        { modal: true },
        'Switch'
      );
      if (ok !== 'Switch') {
        log.debug('Switch cancelled by user', { fromId: fromActive.id, toId: to.id });
        return;
      }
    }
  }

  // 2. Combined progress UI.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: fromActive ? `Switching to "${to.name}"` : `Connecting to "${to.name}"`,
      cancellable: false,
    },
    async (notif) => {
      const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
      statusItem.text = `$(sync~spin) Ditto: ${fromActive ? 'switching to' : 'connecting'} ${to.name}`;
      statusItem.show();
      try {
        // 3. Tear down (dispose panels + disconnect).
        if (fromActive) {
          notif.report({ message: `Disconnecting from ${fromActive.name}…` });
          statusItem.text = `$(sync~spin) Ditto: disconnecting ${fromActive.name}`;
          notif.report({ message: 'Closing panels…' });
          QueryEditorPanel.dispose();
          PeerListingPanel.dispose();
          SubscriptionEditorPanel.dispose();
          await manager.disconnect();
        }

        // 4. Activate target.
        notif.report({ message: `Connecting to ${to.name}…` });
        statusItem.text = `$(sync~spin) Ditto: connecting ${to.name}`;
        const secrets = await secretStore.read(to.id);
        const initialSubs = subStore.list(to.id);
        try {
          await manager.connect(to, secrets, initialSubs);
        } catch (err) {
          // 5. Rollback prompt.
          log.error('Connect to target failed', { toId: to.id, err: String(err) });
          if (!fromActive) {
            // Initial connect failure: just toast.
            vscode.window.showErrorMessage(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          const reconnectLabel = `Reconnect to ${fromActive.name}`;
          const choice = await vscode.window.showWarningMessage(
            `Connect to "${to.name}" failed: ${err instanceof Error ? err.message : String(err)}.\nReconnect to "${fromActive.name}"?`,
            { modal: true },
            reconnectLabel,
            'Stay disconnected'
          );
          if (choice === reconnectLabel) {
            notif.report({ message: `Reconnecting to ${fromActive.name}…` });
            statusItem.text = `$(sync~spin) Ditto: reconnecting ${fromActive.name}`;
            const fromCfg = configStore.get(fromActive.id);
            if (!fromCfg) {
              vscode.window.showErrorMessage('Original DB config no longer available.');
              return;
            }
            const fromSecrets = await secretStore.read(fromCfg.id);
            const fromSubs = subStore.list(fromCfg.id);
            try {
              await manager.connect(fromCfg, fromSecrets, fromSubs);
            } catch (err2) {
              log.error('Rollback connect failed', { fromId: fromActive.id, err: String(err2) });
              vscode.window.showErrorMessage(
                `Reconnect to "${fromActive.name}" also failed: ${err2 instanceof Error ? err2.message : String(err2)}.\nBoth connections offline.`
              );
              return;
            }
            // Restore fromActive's panels.
            await restorePanels(fromActive.id, opts);
            return;
          }
          return; // stay disconnected
        }

        // 6. Restore target's panels.
        notif.report({ message: 'Restoring panels…' });
        statusItem.text = `$(sync~spin) Ditto: restoring panels`;
        await restorePanels(to.id, opts);
      } finally {
        statusItem.dispose();
      }
    }
  );
}

async function restorePanels(databaseId: string, opts: PerformSwitchOpts): Promise<void> {
  const { context, manager, configStore, tracker, logger } = opts;
  for (const kind of tracker.list(databaseId)) {
    if (kind === 'query') QueryEditorPanel.show(context, manager, configStore, databaseId, tracker, logger);
    if (kind === 'peers') PeerListingPanel.show(context, manager, configStore, databaseId, tracker, logger);
  }
}

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
  const tracker = new OpenPanelsTracker(context.globalState);
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
        await tracker.deleteAll(node.config.id);
        const dir = vscode.Uri.joinPath(context.globalStorageUri, 'dittoData', node.config.id);
        try { await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }); } catch { /* fine if missing */ }
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', async (node) => {
      if (node?.kind !== 'database') { return; }
      if (manager.isSwitchInProgress()) {
        vscode.window.showInformationMessage('Switch in progress — please wait.');
        return;
      }
      const cur = manager.getCurrentLifecycleState();
      const fromActive = cur.kind === 'active'
        ? { id: cur.configId, name: configStore.get(cur.configId)?.name ?? 'Unknown' }
        : null;
      if (fromActive && fromActive.id === node.config.id) {
        vscode.window.showInformationMessage(`Already connected to "${node.config.name}".`);
        return;
      }
      await performSwitch({
        context, manager, configStore, secretStore, subStore: subscriptionStore, tracker, logger,
        fromActive, to: node.config,
      });
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', async () => {
      if (manager.isSwitchInProgress()) {
        vscode.window.showInformationMessage('Switch in progress — please wait.');
        return;
      }
      const cur = manager.getCurrentLifecycleState();
      if (cur.kind !== 'active') { return; }
      const name = configStore.get(cur.configId)?.name ?? 'Unknown';
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Disconnecting from "${name}"`, cancellable: false },
        async () => {
          const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
          statusItem.text = `$(sync~spin) Ditto: disconnecting ${name}`;
          statusItem.show();
          try {
            QueryEditorPanel.dispose();
            PeerListingPanel.dispose();
            SubscriptionEditorPanel.dispose();
            await manager.disconnect();
          } finally {
            statusItem.dispose();
          }
        }
      );
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
      PeerListingPanel.show(context, manager, configStore, databaseId, tracker, logger);
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
      QueryEditorPanel.show(context, manager, configStore, databaseId, tracker, logger);
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
