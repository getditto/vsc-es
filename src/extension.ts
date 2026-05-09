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
import { performSwitch, type SwitchDeps } from './ditto/switch-orchestrator.js';
import { createLogger } from './logging/Logger.js';
import { attachSdkLogBridge } from './logging/sdk-bridge.js';
import type { Logger, LogLevel } from './logging/types.js';
import { InspectorController } from './inspector/InspectorController.js';
import { InspectorViewProvider } from './inspector/InspectorViewProvider.js';
import { QueryHistoryStore } from './storage/QueryHistoryStore.js';
import { QueryFavoritesStore } from './storage/QueryFavoritesStore.js';

let logger: Logger;

function buildSwitchDeps(
  context: vscode.ExtensionContext,
  manager: DittoManager,
  configStore: ConfigStore,
  secretStore: SecretStore,
  subStore: SubscriptionStore,
  tracker: OpenPanelsTracker,
  inspector: InspectorController,
  history: QueryHistoryStore,
  favorites: QueryFavoritesStore,
  loggerArg: Logger,
): SwitchDeps {
  return {
    manager,
    configStore: { get: (id) => configStore.get(id) },
    secretStore: { read: (id) => secretStore.read(id) },
    subStore: { list: (id) => subStore.list(id) },
    tracker,
    logger: loggerArg,
    ui: {
      showModalWarn: async ({ message, buttons }) =>
        vscode.window.showWarningMessage(message, { modal: true }, ...buttons),
      showError: (msg) => { vscode.window.showErrorMessage(msg); },
      showInfo: (msg) => { vscode.window.showInformationMessage(msg); },
      withProgress: async (title, work) => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: false },
          async (notif) => work({ report: (o) => notif.report(o) }),
        );
      },
      statusBarItem: () => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
        return {
          setText: (text) => { item.text = text; },
          show: () => item.show(),
          dispose: () => item.dispose(),
        };
      },
    },
    panels: {
      closeQuery: () => QueryEditorPanel.dispose(),
      closePeers: () => PeerListingPanel.dispose(),
      closeSubscription: () => SubscriptionEditorPanel.dispose(),
      showQuery: (databaseId) =>
        QueryEditorPanel.show(context, manager, configStore, databaseId, tracker, inspector, history, favorites, loggerArg),
      showPeers: (databaseId) =>
        PeerListingPanel.show(context, manager, configStore, databaseId, tracker, inspector, loggerArg),
    },
  };
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
  // Channel ownership: Logger.dispose() calls channelSink.dispose() which calls
  // channel.dispose(). Don't also push to context.subscriptions or it double-disposes.
  const channel = vscode.window.createOutputChannel('Ditto Edge Studio', { log: true });
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
  attachSdkLogBridge(DittoLogger as unknown as Parameters<typeof attachSdkLogBridge>[0], logger.withTag('sdk'));

  const log = logger.withTag('ext');

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);
  const subscriptionStore = new SubscriptionStore(context.globalState);
  const tracker = new OpenPanelsTracker(context.globalState);
  const manager = new DittoManager(context, logger);
  const inspectorController = new InspectorController(context.globalState);
  const historyStore = new QueryHistoryStore(context.globalState);
  const favoritesStore = new QueryFavoritesStore(context.globalState);

  context.subscriptions.push(manager.onLifecycleStateChange(state => {
    if (state.kind !== 'active') inspectorController.clearOnDisconnect();
    void vscode.commands.executeCommand('setContext', 'dittoVsce.hasActiveDatabase', state.kind === 'active');
  }));

  const inspectorView = new InspectorViewProvider(
    context, inspectorController, historyStore, favoritesStore, manager, logger,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(InspectorViewProvider.viewType, inspectorView),
  );

  const treeProvider = new DatabaseTreeProvider(
    configStore,
    id => manager.getStatus(id),
    subscriptionStore,
    () => manager.getCurrentLifecycleState(),
  );
  context.subscriptions.push(manager.onStatusChange(() => treeProvider.refresh()));
  context.subscriptions.push(manager.onLifecycleStateChange(() => treeProvider.refresh()));
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
        await historyStore.deleteAll(node.config.id);
        await favoritesStore.deleteAll(node.config.id);
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
      const deps = buildSwitchDeps(context, manager, configStore, secretStore, subscriptionStore, tracker, inspectorController, historyStore, favoritesStore, logger);
      await performSwitch(deps, fromActive, node.config);
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
      PeerListingPanel.show(context, manager, configStore, databaseId, tracker, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', (node) => {
      const databaseId = node?.kind === 'subscriptionsParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Open a connection first.');
        return;
      }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, databaseId, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.editSubscription', (node) => {
      if (node?.kind !== 'subscription') { return; }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, node.databaseId, inspectorController, logger, node.sub);
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
      if (!databaseId) { return; }
      QueryEditorPanel.show(context, manager, configStore, databaseId, tracker, inspectorController, historyStore, favoritesStore, logger);
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
    }),
    vscode.commands.registerCommand('dittoVsce.toggleInspector', async () => {
      await vscode.commands.executeCommand('dittoVsce.inspector.focus');
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditorWithText', (query: string) => {
      const cur = manager.getCurrentLifecycleState();
      if (cur.kind !== 'active') { return; }
      QueryEditorPanel.show(
        context, manager, configStore, cur.configId,
        tracker, inspectorController, historyStore, favoritesStore, logger,
      );
      QueryEditorPanel.current?.loadQuery(query);
    }),
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
