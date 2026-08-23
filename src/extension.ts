import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Logger as DittoLogger } from '@dittolive/ditto';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { SubscriptionStore } from './storage/SubscriptionStore.js';
import { ObserverStore } from './storage/ObserverStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import type { DatabaseTreeNode } from './tree/DatabaseTreeItem.js';
import { LoggingTreeProvider } from './tree/LoggingTreeProvider.js';
import { HelpTreeProvider } from './tree/HelpTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
import { PeerListingPanel } from './panels/PeerListingPanel.js';
import { QueryEditorPanel } from './panels/QueryEditorPanel.js';
import { QueryMetricsPanel } from './panels/QueryMetricsPanel.js';
import { DatabaseMetricsPanel } from './panels/DatabaseMetricsPanel.js';
import { ImportDataPanel } from './panels/ImportDataPanel.js';
import { WelcomePanel } from './panels/WelcomePanel.js';
import { SubscriptionEditorPanel } from './panels/SubscriptionEditorPanel.js';
import { ObserverEditorPanel } from './panels/ObserverEditorPanel.js';
import { ObserverPanel } from './panels/ObserverPanel.js';
import { ImportSubscriptionsPanel } from './panels/ImportSubscriptionsPanel.js';
import { AddIndexPanel } from './panels/AddIndexPanel.js';
import { DittoManager } from './ditto/DittoManager.js';
import { CollectionsRepository } from './ditto/CollectionsRepository.js';
import { isBareIdentifier, quoteIdentifier } from './ditto/dql-identifier.js';
import { OpenPanelsTracker } from './ditto/OpenPanelsTracker.js';
import { confirmSwitch, performSwitch, type SwitchDeps } from './ditto/switch-orchestrator.js';
import { createLogger } from './logging/Logger.js';
import { attachSdkLogBridge } from './logging/sdk-bridge.js';
import type { Logger, LogLevel } from './logging/types.js';
import { InspectorController } from './inspector/InspectorController.js';
import { InspectorViewProvider } from './inspector/InspectorViewProvider.js';
import { AttachmentCache } from './inspector/AttachmentCache.js';
import { QueryHistoryStore } from './storage/QueryHistoryStore.js';
import { QueryFavoritesStore } from './storage/QueryFavoritesStore.js';
import { QueryMetricsStore } from './storage/QueryMetricsStore.js';
import { TreeExpansionStore } from './storage/TreeExpansionStore.js';
import { MetricsPreferencesStore } from './storage/MetricsPreferencesStore.js';
import type { TestApi } from './test-api/index.js';
import { makeTestApi } from './test-api/index.js';
import { QuickstartService, createNodeGitRunner } from './quickstart/QuickstartService.js';
import type { EnvValues, CloneMode } from './quickstart/QuickstartService.js';
import { QUICKSTART_FOLDER_NAME } from './quickstart/quickstart-projects.js';
import { AnalyzerSink } from './logAnalyzer/AnalyzerSink.js';
import { PatternEngine } from './logAnalyzer/PatternEngine.js';
import { PatternStore } from './logAnalyzer/PatternStore.js';
import { ConnectionTracker } from './logAnalyzer/ConnectionTracker.js';
import { LogAnalyzerService } from './logAnalyzer/LogAnalyzerService.js';
import { LogAnalyzerPanel } from './panels/LogAnalyzerPanel.js';
import { PatternEditorPanel } from './panels/PatternEditorPanel.js';
import {
  waitForConnectionPersistence,
  withConnectionPersistenceLock,
} from './storage/connection-persistence-lock.js';
import { deleteConnectionAtomically } from './panels/save-connection.js';

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
  metrics: QueryMetricsStore,
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
      // preserveTabs/preserveState: the switch restore reopens these
      // panels from the tracker — disposing must not delete the entries
      // it's about to read.
      closeQuery: () => QueryEditorPanel.dispose({ preserveTabs: true }),
      closePeers: () => PeerListingPanel.dispose({ preserveState: true }),
      closeSubscription: () => SubscriptionEditorPanel.dispose(),
      closeQueryMetrics: () => QueryMetricsPanel.dispose(),
      closeDatabaseMetrics: () => DatabaseMetricsPanel.dispose(),
      closeImportData: () => ImportDataPanel.dispose(),
      closeObserver: () => ObserverPanel.disposeAll(),
      closeObserverEditor: () => ObserverEditorPanel.dispose(),
      closeAddIndex: () => AddIndexPanel.dispose(),
      closeImportSubscriptions: () => ImportSubscriptionsPanel.dispose(),
      showQuery: (databaseId, queryText) => {
        const panel = QueryEditorPanel.show(
          context, manager, configStore, secretStore, databaseId, tracker, inspector, history, favorites, metrics, loggerArg,
        );
        if (queryText !== undefined && queryText.length > 0) {
          panel.loadQuery(queryText);
        }
      },
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
  return picked?.label;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  // Channel ownership: Logger.dispose() calls channelSink.dispose() which calls
  // channel.dispose(). Don't also push to context.subscriptions or it double-disposes.
  const channel = vscode.window.createOutputChannel('Ditto Edge Studio', { log: true });
  const sessionId = crypto.randomUUID();
  const fileDir = path.join(context.globalStorageUri.fsPath, 'logs');
  const analyzerSink = new AnalyzerSink();
  logger = createLogger({
    channel,
    fileDir,
    sessionId,
    mode: context.extensionMode === vscode.ExtensionMode.Development
      || context.extensionMode === vscode.ExtensionMode.Test
        ? 'development' : 'production',
    extraSinks: [analyzerSink],
  });
  // NOTE: the logger's disposal is registered at the END of activate() —
  // VS Code disposes subscriptions in registration order, and everything
  // else (manager.disconnect above all) logs during its own teardown.

  // SDK bridge: pipe Ditto SDK logs into our Logger under the 'sdk' tag.
  attachSdkLogBridge(DittoLogger, logger.withTag('sdk'));

  const log = logger.withTag('ext');

  // ─── Log Analyzer wiring ─────────────────────────────────────
  // PatternStore reads the bundled catalog from the extension's dist/
  // and merges in user-authored patterns from globalStorage (or a
  // workspace-configured override). Engine reloads compiled patterns
  // whenever the store changes (add/update/delete from the editor) or
  // when the user points the setting at a different file.
  const patternStore = new PatternStore({
    bundledPath: context.asAbsolutePath(path.join('dist', 'patterns', 'problem_patterns.json')),
    resolveUserPath: () => {
      const setting = vscode.workspace.getConfiguration('dittoVsce.logAnalyzer').get<string>('customPatternsFile');
      if (setting && setting.trim().length > 0) { return setting; }
      return path.join(context.globalStorageUri.fsPath, 'log-analyzer', 'user_patterns.json');
    },
    logger,
  });
  const patternEngine = new PatternEngine(patternStore);
  // activate() is sync, so kick the initial load asynchronously. The
  // engine starts empty until the load resolves — that's fine: the
  // analyzer panel is user-initiated and won't open faster than this
  // I/O completes in practice.
  //
  // The catch matters: `void promise.then(...)` observes nothing, so a missing
  // or malformed bundled catalog became an unhandled rejection and the engine
  // stayed permanently empty. The analyzer would then report "no problems
  // detected" forever with no indication that detection was never running.
  const loadPatterns = (reason: 'startup' | 'settingChanged'): void => {
    void patternStore.load()
      .then(() => {
        patternEngine.load();
        const rejected = patternEngine.listRejected();
        if (rejected.length > 0) {
          logger.warn('Log analyzer: some patterns were skipped', {
            reason,
            skipped: rejected.map(r => `${r.key}: ${r.reason}`).join('; '),
          });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Log analyzer: pattern catalog failed to load', { reason, err: message });
        void vscode.window.showWarningMessage(
          `Ditto: log analyzer patterns failed to load (${message}). `
          + 'Problem detection is disabled until this is resolved.',
        );
      });
  };
  loadPatterns('startup');
  context.subscriptions.push(
    patternStore.onDidChange(() => patternEngine.reload()),
  );

  // LogAnalyzerService is per-database, lazily created when the user opens
  // the panel for an active connection. Each service has its own
  // ConnectionTracker + line buffer so disconnect→reconnect produces a
  // fresh view rather than carrying stale problems across sessions.
  function makeAnalyzerService(): LogAnalyzerService {
    return new LogAnalyzerService({
      sink: analyzerSink,
      engine: patternEngine,
      tracker: new ConnectionTracker(),
    });
  }

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);
  const subscriptionStore = new SubscriptionStore(context.globalState);
  const observerStore = new ObserverStore(context.globalState);
  const tracker = new OpenPanelsTracker(context.globalState);
  const manager = new DittoManager(context, logger, configStore);
  const collectionsRepo = new CollectionsRepository(manager, logger);
  const inspectorController = new InspectorController(context.globalState);
  const historyStore = new QueryHistoryStore(context.globalState);
  const favoritesStore = new QueryFavoritesStore(context.globalState);
  const queryMetricsStore = new QueryMetricsStore();
  const treeExpansionStore = new TreeExpansionStore(context.globalState);
  const metricsPrefs = new MetricsPreferencesStore(context.globalState);

  // Initialize the context key to a known value so view `when` clauses
  // evaluate deterministically even before the first lifecycle transition.
  void vscode.commands.executeCommand(
    'setContext', 'dittoVsce.hasActiveDatabase',
    manager.getCurrentLifecycleState().kind === 'active',
  );

  // In-memory cache for inspector attachment bytes. Survives across
  // tab switches so re-opening the JSON viewer doesn't re-download
  // the attachment from the SDK. Cleared on every non-active lifecycle
  // transition below — so a disconnect (or a connect that goes through
  // an intermediate non-active state) drops everything it cached for
  // the previous session. Bounded at 64 MB to keep the extension host
  // memory profile sane; see AttachmentCache for the LRU policy.
  const attachmentCache = new AttachmentCache();

  // Tracks when each database last entered the 'active' lifecycle state.
  // The Log Analyzer uses this as a backfill floor so its histograms only
  // reflect the current connection — not weeks of rotated log history.
  // Map clears the entry on disconnect so reconnecting gives a fresh
  // timestamp.
  const connectedAt = new Map<string, Date>();
  let lastActiveConfigId: string | null = null;

  context.subscriptions.push(manager.onLifecycleStateChange(state => {
    if (state.kind === 'active') {
      // Record connect time on transition INTO active. The lifecycle
      // emitter can fire 'active' multiple times for the same configId
      // (e.g. transient sub-state notifications) — only stamp the first.
      if (lastActiveConfigId !== state.configId) {
        connectedAt.set(state.configId, new Date());
        lastActiveConfigId = state.configId;
      }
      void collectionsRepo.load();
    } else {
      inspectorController.clearOnDisconnect();
      collectionsRepo.clear();
      // Lifecycle leaving 'active' === the previously-cached
      // attachments belong to a session that no longer exists; the
      // tokens won't work against a fresh session anyway. Belt-and-
      // suspenders: clearAll() rather than clearDatabase(prevId) so
      // even if some other path stashed entries we don't carry orphans
      // into the next connection.
      attachmentCache.clearAll();
      // Log Analyzer is per-database; close all open panels (their
      // services dispose with them) so disconnect → reconnect produces
      // a fresh view rather than carrying stale problems across sessions.
      LogAnalyzerPanel.dispose();
      if (lastActiveConfigId) {
        connectedAt.delete(lastActiveConfigId);
        lastActiveConfigId = null;
      }
    }
    void vscode.commands.executeCommand('setContext', 'dittoVsce.hasActiveDatabase', state.kind === 'active');
  }));

  const inspectorView = new InspectorViewProvider(
    context, inspectorController, historyStore, favoritesStore, manager, logger, metricsPrefs, attachmentCache,
  );
  context.subscriptions.push(
    // `retainContextWhenHidden: true` keeps the Inspector's webview
    // process (and therefore all its UI state — selected tab, scroll
    // position, parsed JSON in the viewer, in-flight attachment
    // previews) alive when the user switches to a different view in
    // the auxiliary bar (Claude Code, Chat, etc.) and back.
    //
    // Without this, VS Code disposes the webview on hide; the next
    // reveal re-runs the bundle from scratch and the controller's
    // `getContent()` is re-pushed — but the user perceives this as
    // "the Inspector lost everything" because the tab state, scroll
    // position, and ephemeral preview state are gone.
    //
    // The cost is memory (the webview process keeps running while
    // hidden). For an auxiliary-bar inspector that's tiny relative
    // to the UX win.
    vscode.window.registerWebviewViewProvider(
      InspectorViewProvider.viewType,
      inspectorView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const treeProvider = new DatabaseTreeProvider(
    configStore,
    id => manager.getStatus(id),
    subscriptionStore,
    observerStore,
    () => manager.getCurrentLifecycleState(),
    collectionsRepo,
  );
  context.subscriptions.push(manager.onStatusChange(() => treeProvider.refresh()));
  context.subscriptions.push(manager.onLifecycleStateChange(() => treeProvider.refresh()));
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);
  context.subscriptions.push({ dispose: () => treeProvider.dispose() });

  // ─── Settings reactivity ─────────────────────────────────────
  // When the user toggles dittoVsce.collectProfiling or
  // dittoVsce.collectMetrics (either via the Query Editor's cog menu,
  // VS Code's settings UI, or editing settings.json directly), refresh
  // the tree (so the Query Metrics row shows/hides) and re-push the
  // settings to the Inspector webview (so the Metrics tab shows/hides).
  // The Query Editor reads the settings fresh on every Run, so it
  // doesn't need an event hook.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dittoVsce.collectMetrics')) {
        treeProvider.refresh();
        inspectorView.pushSettings();
      }
      if (e.affectsConfiguration('dittoVsce.collectProfiling')) {
        // No tree gate yet for profiling (Query Editor reads the
        // setting on each Run), but re-push to the Inspector in case
        // we add a profile-specific tab there later.
        inspectorView.pushSettings();
      }
      if (e.affectsConfiguration('dittoVsce.logAnalyzer.customPatternsFile')) {
        // Repoint PatternStore at the new user file (or fall back to
        // the default in globalStorage) and recompile the engine. The
        // analyzer panel, if open, will see the new patterns the next
        // time it processes a line (or via the store's change event,
        // which already triggers engine.reload above).
        loadPatterns('settingChanged');
      }
    }),
  );

  // ─── Tree expansion persistence ──────────────────────────────
  // VS Code's TreeView API doesn't expose "is X expanded?" — we
  // maintain our own model by listening to expand/collapse events.
  // Each event is keyed by the active config (every node carries
  // databaseId or configId in its discriminated-union shape).
  const databaseIdFor = (node: DatabaseTreeNode): string | undefined => {
    if (node.kind === 'database' || node.kind === 'databaseDetails') { return node.config.id; }
    if ('databaseId' in node) { return node.databaseId; }
    return undefined;
  };
  context.subscriptions.push(treeView.onDidExpandElement(async ({ element }) => {
    const dbId = databaseIdFor(element);
    const item = treeProvider.getTreeItem(element);
    if (dbId && item.id) { await treeExpansionStore.add(dbId, item.id); }
  }));
  context.subscriptions.push(treeView.onDidCollapseElement(async ({ element }) => {
    const dbId = databaseIdFor(element);
    const item = treeProvider.getTreeItem(element);
    if (dbId && item.id) { await treeExpansionStore.remove(dbId, item.id); }
  }));

  // Drive the Inspector's content from tree selection so clicking
  // "Subscriptions" / "Presence" / "Query Editor" surfaces the right
  // help even when no panel opens. Without this, the only way to see
  // Subscriptions help was to click an existing subscription leaf —
  // which is impossible the first time you set up a connection.
  // Other selections (database row, collection, indexes) leave the
  // Inspector untouched.
  context.subscriptions.push(treeView.onDidChangeSelection(({ selection }) => {
    const node = selection[0];
    if (!node) { return; }
    const dbId = databaseIdFor(node);
    if (!dbId) { return; }
    if (node.kind === 'subscriptionsParent'
      || node.kind === 'subscription'
      || node.kind === 'subscriptionQuery') {
      inspectorController.setActiveFeature({ kind: 'subscriptions', databaseId: dbId });
    } else if (node.kind === 'peerListing') {
      inspectorController.setActiveFeature({ kind: 'peers', databaseId: dbId });
    } else if (node.kind === 'queryEditor') {
      inspectorController.setActiveFeature({ kind: 'query', databaseId: dbId });
    } else if (node.kind === 'queryMetrics') {
      inspectorController.setActiveFeature({ kind: 'metrics', databaseId: dbId });
    } else if (node.kind === 'databaseMetrics') {
      inspectorController.setActiveFeature({ kind: 'databaseMetrics', databaseId: dbId });
    }
  }));

  // Restore expansion is tricky because some nodes (collections,
  // indexes) come from the live __collections observer which fires
  // asynchronously *after* lifecycle-active. IDs that don't resolve on
  // the first pass get parked here and retried each time the
  // collections list changes — see the collectionsRepo.onChange
  // subscriber below.
  const pendingExpansionRetry = new Map<string, Set<string>>(); // dbId → unresolved IDs

  /** Try to reveal each id; returns the set of ids that didn't resolve
   *  (because the corresponding tree node doesn't exist yet). */
  const restoreExpansion = async (_dbId: string, ids: readonly string[]): Promise<Set<string>> => {
    const remaining = new Set<string>();
    for (const id of ids) {
      const node = await treeProvider.findNodeById(id);
      if (!node) { remaining.add(id); continue; }
      try {
        await treeView.reveal(node, { expand: true, focus: false, select: false });
      } catch {
        // reveal can race with the refresh emitter; safe to swallow.
      }
    }
    return remaining;
  };

  // When a connection becomes active, restore the tree to the shape
  // the user left it in last time. First-time connections (no stored
  // state) fall back to the legacy `expand: 2` behaviour so the data
  // + features rows are immediately visible.
  context.subscriptions.push(manager.onLifecycleStateChange(async state => {
    if (state.kind !== 'active') {
      // Disconnect → drop any pending retries; they'd be stale anyway.
      pendingExpansionRetry.clear();
      return;
    }
    const config = configStore.get(state.configId);
    if (!config) { return; }
    const stored = treeExpansionStore.list(state.configId);
    try {
      if (stored.length === 0) {
        // First-time connect → default expand-2 (database + databaseDetails).
        await treeView.reveal(
          { kind: 'database', config, status: 'active' },
          { expand: 2, focus: false, select: false },
        );
        // collectionsRepo.load() runs concurrently with this reveal — the
        // first reveal happens before the cache is populated, so
        // databaseDetails is rendered with no collection rows. The
        // _changeEmitter.fire from the eventual load doesn't always
        // re-render the children of an already-revealed node (the user has
        // to disconnect+reconnect to see collections). Set up a one-shot
        // listener on the next collections.onChange and re-reveal so the
        // tree picks up the newly-loaded children. This is the
        // first-connect equivalent of the parked-retry mechanism the
        // restoreExpansion branch below already provides.
        const targetId = state.configId;
        const oneShot = collectionsRepo.onChange(() => {
          if (manager.getActiveConfigId() !== targetId) { oneShot.dispose(); return; }
          oneShot.dispose();
          void treeView.reveal(
            { kind: 'database', config, status: 'active' },
            { expand: 2, focus: false, select: false },
          ).then(undefined, () => { /* swallow refresh race */ });
        });
        // Make sure the listener is torn down on disconnect even if
        // collections never fire (e.g. SDK error mid-hydrate).
        context.subscriptions.push(oneShot);
        return;
      }
      const remaining = await restoreExpansion(state.configId, stored);
      if (remaining.size > 0) {
        // Park unresolved IDs (e.g. collections that haven't synced
        // yet) so they get re-tried as the collections observer fires.
        pendingExpansionRetry.set(state.configId, remaining);
      }
    } catch {
      // reveal can race with the refresh emitter; safe to swallow.
    }
  }));

  // Retry pending expansion whenever the collections list changes —
  // i.e. when the live __collections observer or a manual refresh
  // surfaces new collection rows. Once every parked ID resolves, the
  // entry drops out of the map and we stop spinning on each event.
  context.subscriptions.push(collectionsRepo.onChange(async () => {
    const activeId = manager.getActiveConfigId();
    if (!activeId) { return; }
    const pending = pendingExpansionRetry.get(activeId);
    if (!pending || pending.size === 0) { return; }
    const remaining = await restoreExpansion(activeId, [...pending]);
    if (remaining.size === 0) { pendingExpansionRetry.delete(activeId); }
    else { pendingExpansionRetry.set(activeId, remaining); }
  }));

  const loggingProvider = new LoggingTreeProvider(logger);
  context.subscriptions.push(vscode.window.createTreeView('dittoLogging', { treeDataProvider: loggingProvider }));

  const helpProvider = new HelpTreeProvider();
  context.subscriptions.push(vscode.window.createTreeView('dittoHelp', { treeDataProvider: helpProvider }));

  context.subscriptions.push(
    vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
      DatabaseEditorPanel.show(context, configStore, secretStore, logger, manager);
    }),
    vscode.commands.registerCommand('dittoVsce.editDatabase', (node) => {
      if (node?.kind !== 'database') { return; }
      DatabaseEditorPanel.show(context, configStore, secretStore, logger, manager, node.config);
    }),
    vscode.commands.registerCommand('dittoVsce.deleteDatabase', async (node) => {
      if (node?.kind !== 'database') { return; }
      if (manager.isApplyingTransports()) {
        vscode.window.showInformationMessage('Transport change in progress — please wait.');
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `Delete connection "${node.config.name}"?`, { modal: true }, 'Delete'
      );
      if (ok !== 'Delete') { return; }
      try {
        await withConnectionPersistenceLock(async () => {
          if (manager.getActiveConfigId() === node.config.id) {
            // Mirror the disconnect command's panel teardown — without
            // this, deleting the active database leaves stale panels.
            QueryEditorPanel.dispose();
            PeerListingPanel.dispose();
            SubscriptionEditorPanel.dispose();
            QueryMetricsPanel.dispose();
            DatabaseMetricsPanel.dispose();
            ImportDataPanel.dispose();
            ObserverEditorPanel.dispose();
            ObserverPanel.disposeAll();
            AddIndexPanel.dispose();
            ImportSubscriptionsPanel.dispose();
            await manager.disconnect();
          }
          // In-memory per-DB metrics aren't in the persistent stores below.
          queryMetricsStore.clear(node.config.id);
          const cleanup = await Promise.allSettled([
            subscriptionStore.deleteAll(node.config.id),
            observerStore.deleteAll(node.config.id),
            tracker.deleteAll(node.config.id),
            historyStore.deleteAll(node.config.id),
            favoritesStore.deleteAll(node.config.id),
            inspectorController.clearForDatabase(node.config.id),
            treeExpansionStore.clearAll(node.config.id),
          ]);
          if (cleanup.some(result => result.status === 'rejected')) {
            throw new Error('Associated connection data could not be removed.');
          }
          const dir = vscode.Uri.joinPath(context.globalStorageUri, 'dittoData', node.config.id);
          try {
            await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
          } catch (error) {
            if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; }
          }
          await deleteConnectionAtomically(configStore, secretStore, node.config.id);
        });
      } catch {
        vscode.window.showErrorMessage('Connection deletion did not complete. Retry to finish removing any remaining connection data.');
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', async (node) => {
      if (node?.kind !== 'database') { return; }
      if (manager.isApplyingTransports()) {
        vscode.window.showInformationMessage('Transport change in progress — please wait.');
        return;
      }
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
      const deps = buildSwitchDeps(context, manager, configStore, secretStore, subscriptionStore, tracker, inspectorController, historyStore, favoritesStore, queryMetricsStore, logger);
      const currentTarget = configStore.get(node.config.id);
      if (!currentTarget) {
        vscode.window.showErrorMessage('This connection no longer exists. Refresh the database list and try again.');
        return;
      }
      // The confirmation modal runs OUTSIDE the persistence lock: a modal
      // can stay open indefinitely and deactivate() waits on the lock tail,
      // so a modal inside the lock can deadlock shutdown.
      if (!await confirmSwitch(deps, fromActive, currentTarget)) { return; }
      await withConnectionPersistenceLock(async () => {
        // Re-check inside the lock — the config could have been deleted
        // while the modal was open.
        const stillTarget = configStore.get(node.config.id);
        if (!stillTarget) {
          vscode.window.showErrorMessage('This connection no longer exists. Refresh the database list and try again.');
          return;
        }
        await performSwitch(deps, fromActive, stillTarget);
      });
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', async () => {
      if (manager.isApplyingTransports()) {
        vscode.window.showInformationMessage('Transport change in progress — please wait.');
        return;
      }
      if (manager.isSwitchInProgress()) {
        vscode.window.showInformationMessage('Switch in progress — please wait.');
        return;
      }
      const cur = manager.getCurrentLifecycleState();
      if (cur.kind !== 'active') { return; }
      const name = configStore.get(cur.configId)?.name ?? 'Unknown';
      await withConnectionPersistenceLock(async () => vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Disconnecting from "${name}"`, cancellable: false },
        async () => {
          const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
          statusItem.text = `$(sync~spin) Ditto: disconnecting ${name}`;
          statusItem.show();
          try {
            // Mirror the switch orchestrator's teardown — every per-DB
            // panel must close, not just the oldest few. Tabs/peers state
            // is preserved so a later reconnect restores them.
            QueryEditorPanel.dispose({ preserveTabs: true });
            PeerListingPanel.dispose({ preserveState: true });
            SubscriptionEditorPanel.dispose();
            QueryMetricsPanel.dispose();
            DatabaseMetricsPanel.dispose();
            ImportDataPanel.dispose();
            ObserverEditorPanel.dispose();
            ObserverPanel.disposeAll();
            AddIndexPanel.dispose();
            ImportSubscriptionsPanel.dispose();
            await manager.disconnect();
          } finally {
            statusItem.dispose();
          }
        }
      ));
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
    vscode.commands.registerCommand('dittoVsce.newSubscription', async (node) => {
      const databaseId = node?.kind === 'subscriptionsParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Open a connection first.');
        return;
      }
      // If the connection has both an HTTP API URL and key, offer the
      // user a choice between hand-writing a subscription and importing
      // from the Ditto Server. Otherwise fall straight through to the
      // editor — no QuickPick noise when there's only one option.
      const cfg = configStore.get(databaseId);
      const secrets = await secretStore.read(databaseId);
      const canImport = !!(cfg?.httpApiUrl && secrets.httpApiKey);
      if (canImport) {
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'New Subscription…', description: 'Create a new DQL subscription by hand' },
            { label: 'Import from Server…', description: 'Pick from subscriptions known to the Ditto Server' },
          ],
          { placeHolder: 'How would you like to create the subscription?' },
        );
        if (!picked) { return; }
        if (picked.label === 'Import from Server…') {
          ImportSubscriptionsPanel.show(
            context, configStore, secretStore, subscriptionStore, manager, databaseId, logger,
          );
          return;
        }
      }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, databaseId, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.importSubscriptionsFromServer', async (node) => {
      const databaseId = node?.kind === 'subscriptionsParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Open a connection first.');
        return;
      }
      const cfg = configStore.get(databaseId);
      const secrets = await secretStore.read(databaseId);
      if (!cfg?.httpApiUrl || !secrets.httpApiKey) {
        vscode.window.showWarningMessage(
          'Set the HTTP API URL and key on this connection to import subscriptions from the server.',
        );
        return;
      }
      ImportSubscriptionsPanel.show(
        context, configStore, secretStore, subscriptionStore, manager, databaseId, logger,
      );
    }),
    vscode.commands.registerCommand('dittoVsce.editSubscription', (node) => {
      if (node?.kind !== 'subscription') { return; }
      SubscriptionEditorPanel.show(context, subscriptionStore, manager, node.databaseId, inspectorController, logger, node.sub);
    }),
    vscode.commands.registerCommand('dittoVsce.newObserver', async (node) => {
      const databaseId = node?.kind === 'observersParent'
        ? node.databaseId
        : manager.getActiveConfigId();
      if (!databaseId) {
        vscode.window.showWarningMessage('Open a connection first.');
        return;
      }
      ObserverEditorPanel.show(context, observerStore, databaseId, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.editObserver', (node) => {
      if (node?.kind !== 'observer') { return; }
      ObserverEditorPanel.show(context, observerStore, node.databaseId, inspectorController, logger, node.observer);
    }),
    vscode.commands.registerCommand('dittoVsce.deleteObserver', async (node) => {
      if (node?.kind !== 'observer') { return; }
      const ok = await vscode.window.showWarningMessage(
        `Delete observer "${node.observer.name}"?`,
        { modal: true },
        'Delete',
      );
      if (ok !== 'Delete') { return; }
      await observerStore.delete(node.databaseId, node.observer.id);
      // Close ONLY the panel for the observer being deleted — other
      // open observer panels for the same database stay put.
      ObserverPanel.disposeOne(node.databaseId, node.observer.id);
    }),
    vscode.commands.registerCommand('dittoVsce.openObserver', (node) => {
      if (node?.kind !== 'observer') { return; }
      if (manager.getActiveConfigId() !== node.databaseId) {
        vscode.window.showWarningMessage('Connect to this database first.');
        return;
      }
      ObserverPanel.show(context, manager, node.databaseId, node.observer, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
      if (!databaseId) { return; }
      QueryEditorPanel.show(context, manager, configStore, secretStore, databaseId, tracker, inspectorController, historyStore, favoritesStore, queryMetricsStore, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryMetrics', (databaseId: string) => {
      if (!databaseId) { return; }
      QueryMetricsPanel.show(context, configStore, queryMetricsStore, databaseId, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.openDatabaseMetrics', (databaseId: string) => {
      if (!databaseId) { return; }
      DatabaseMetricsPanel.show(context, configStore, manager, databaseId, inspectorController, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.openWelcome', () => {
      WelcomePanel.show(context, configStore, logger);
    }),
    vscode.commands.registerCommand('dittoVsce.getQuickstarts', async () => {
      const qsLog = logger.withTag('ext:quickstart');
      const service = new QuickstartService(qsLog, createNodeGitRunner());

      // The Logger interface has no show() method; surface the output channel
      // via the existing dittoVsce.openOutputChannel command instead.
      const showLog = () => vscode.commands.executeCommand('dittoVsce.openOutputChannel');

      // 1. Pre-flight: git on PATH?
      if (!(await service.isGitAvailable())) {
        const pick = await vscode.window.showErrorMessage(
          'Git is required for Get Quickstarts. Install git and try again.',
          'Open install docs',
        );
        if (pick === 'Open install docs') {
          vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
        }
        return;
      }

      // 2. Snapshot active connection values (or null for code-only).
      const activeId = manager.getActiveConfigId();
      let values: EnvValues | null = null;
      if (activeId) {
        const cfg = configStore.get(activeId);
        const sec = await secretStore.read(activeId);
        if (cfg) {
          values = {
            databaseId: cfg.databaseId,
            token: sec.token,
            authUrl: cfg.authUrl,
            websocketUrl: cfg.websocketUrl ?? '',
          };
        }
      }
      if (!values) {
        const pick = await vscode.window.showWarningMessage(
          'No active connection — .env files will not be configured. Continue with code-only download?',
          { modal: true },
          'Continue',
        );
        if (pick !== 'Continue') { return; }
      }

      // 3. Parent folder picker.
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select parent folder for quickstart',
      });
      if (!picked || picked.length === 0) { return; }
      const parentDir = picked[0].fsPath;
      const targetDir = path.join(parentDir, QUICKSTART_FOLDER_NAME);

      // 4. Inspect target, prompt if needed.
      const inspection = await service.inspectTarget(targetDir);
      let mode: CloneMode = 'fresh-clone';
      if (inspection.kind === 'git-checkout') {
        const pick = await vscode.window.showInformationMessage(
          `A quickstart checkout already exists at ${targetDir}.`,
          { modal: true },
          'Pull latest', 'Replace',
        );
        if (pick === 'Pull latest') { mode = 'pull-existing'; }
        else if (pick === 'Replace') { mode = 'replace-and-clone'; }
        else { return; }
      } else if (inspection.kind === 'non-git-folder') {
        const pick = await vscode.window.showWarningMessage(
          `A non-git folder named 'quickstart' exists at ${targetDir}. Replace it?`,
          { modal: true },
          'Replace',
        );
        if (pick !== 'Replace') { return; }
        mode = 'replace-and-clone';
      }

      // 5. Progress notification + the actual work.
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Setting up Quickstarts', cancellable: true },
          async (progress, token) => {
            const ac = new AbortController();
            token.onCancellationRequested(() => ac.abort());

            progress.report({ message: mode === 'pull-existing' ? 'Updating clone…' : 'Cloning…' });
            const { repoRoot } = await service.cloneOrPull(
              parentDir,
              mode,
              (m) => progress.report({ message: m }),
              ac.signal,
            );

            if (values) {
              progress.report({ message: 'Writing .env files…' });
              const envResults = service.writeEnvFiles(repoRoot, values);
              progress.report({ message: 'Writing edge-server config…' });
              const yamlResult = service.writeEdgeServerYaml(repoRoot, {
                databaseId: values.databaseId,
                token: values.token,
                authUrl: values.authUrl,
              });
              return { repoRoot, envResults, yamlResult };
            }
            return { repoRoot, envResults: [], yamlResult: null };
          },
        );

        // 6. Success notification with summary.
        const writtenCount = result.envResults.filter((r) => r.outcome === 'written').length
          + (result.yamlResult?.outcome === 'written' ? 1 : 0);
        const msg = values
          ? `Quickstarts ready at ${result.repoRoot}. Configured ${writtenCount} config file(s).`
          : `Quickstarts cloned at ${result.repoRoot}. Open a connection and re-run to configure .env files.`;
        const pick = await vscode.window.showInformationMessage(msg, 'Open Folder', 'Show Log');
        if (pick === 'Open Folder') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.repoRoot));
        } else if (pick === 'Show Log') {
          await showLog();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        qsLog.error('Get Quickstarts failed', { err: errMsg });
        // Clean up partial fresh/replace clone on failure (best effort).
        if (mode !== 'pull-existing') {
          try {
            const { rmSync } = await import('node:fs');
            rmSync(targetDir, { recursive: true, force: true });
          } catch { /* ignore cleanup failures */ }
        }
        const pickErr = await vscode.window.showErrorMessage(`Get Quickstarts failed: ${errMsg}`, 'Show Log');
        if (pickErr === 'Show Log') { await showLog(); }
      }
    }),
    vscode.commands.registerCommand('dittoVsce.openImportData', (databaseIdOrNode: any) => {
      // Two call sites converge here:
      //   1. The "Import Data" tree leaf — passes a plain string databaseId.
      //   2. Right-click → "Import Data into Collection…" on a collection
      //      row — passes the tree node, from which we pull both the
      //      databaseId and the preselected collection name.
      let dbId: string | undefined;
      let preselected: string | undefined;
      if (typeof databaseIdOrNode === 'string') {
        dbId = databaseIdOrNode;
      } else if (databaseIdOrNode && typeof databaseIdOrNode === 'object') {
        dbId = databaseIdOrNode.databaseId;
        preselected = databaseIdOrNode.collection?.name;
      }
      if (!dbId) { return; }
      if (manager.getActiveConfigId() !== dbId) {
        vscode.window.showWarningMessage('Connect to this database before importing data.');
        return;
      }
      ImportDataPanel.show(context, configStore, manager, collectionsRepo, dbId, logger, preselected);
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
    vscode.commands.registerCommand('dittoVsce.resetWarnings', async () => {
      await metricsPrefs.resetAll();
      inspectorView.pushPreferences();
      vscode.window.showInformationMessage('Ditto warnings and tips re-enabled.');
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
    vscode.commands.registerCommand('dittoVsce.openLogAnalyzer', (databaseId?: string) => {
      // The Log Analyzer is per-database — invoked from the tree row of an
      // active connection. Without a databaseId we have no scope to bind
      // to, so refuse rather than guess.
      if (!databaseId) {
        void vscode.window.showWarningMessage(
          'Log Analyzer must be opened from a connected database. Expand a connected database in the Ditto sidebar and click "Log Analyzer".',
        );
        return;
      }
      const cfg = configStore.get(databaseId);
      const databaseName = cfg?.name ?? databaseId;
      // Fall back to "now" when we have no recorded connect time (edge
      // case: panel opened from a tree row of a DB that's somehow active
      // without a tracked transition). A `now` cutoff effectively means
      // "no backfill" — the panel populates from new lines only, which
      // is still correct: we shouldn't import weeks of unrelated history.
      const minTimestamp = connectedAt.get(databaseId) ?? new Date();
      LogAnalyzerPanel.show(
        context,
        databaseId,
        databaseName,
        makeAnalyzerService(),
        () => logger.readAllLogs(),
        logger,
        inspectorController,
        minTimestamp,
      );
    }),
    vscode.commands.registerCommand('dittoVsce.openLogPatternEditor', () => {
      PatternEditorPanel.show(context, patternStore, logger, inspectorController);
    }),
    vscode.commands.registerCommand('dittoVsce.toggleInspector', async () => {
      await vscode.commands.executeCommand('dittoVsce.inspector.focus');
    }),
    vscode.commands.registerCommand('dittoVsce.openQueryEditorWithText', (query: string) => {
      const cur = manager.getCurrentLifecycleState();
      if (cur.kind !== 'active') { return; }
      const panel = QueryEditorPanel.show(
        context, manager, configStore, secretStore, cur.configId,
        tracker, inspectorController, historyStore, favoritesStore, queryMetricsStore, logger,
      );
      panel.loadQuery(query);
    }),
    vscode.commands.registerCommand('dittoVsce.refreshCollections', async () => {
      try { await collectionsRepo.refresh(); }
      catch (err) { vscode.window.showErrorMessage(`Refresh collections failed: ${err instanceof Error ? err.message : String(err)}`); }
    }),
    vscode.commands.registerCommand('dittoVsce.addIndex', (node?: any) => {
      // From context menu the node is the tree node — extract collection name.
      const preselected = typeof node === 'object' && node?.collection?.name
        ? String(node.collection.name)
        : undefined;
      AddIndexPanel.show(context, collectionsRepo, logger, preselected);
    }),
    vscode.commands.registerCommand('dittoVsce.deleteIndex', async (node?: any) => {
      // Context-menu only — the menu's `when` clause restricts to
      // `viewItem == index`, so a missing node here means the command
      // was invoked from the palette without a tree selection.
      if (node?.kind !== 'index') {
        vscode.window.showWarningMessage('Right-click an index in the tree to delete it.');
        return;
      }
      if (manager.getActiveConfigId() !== node.databaseId) {
        vscode.window.showWarningMessage('Connect to this database first.');
        return;
      }
      const indexName = node.index.displayName;
      const confirm = await vscode.window.showWarningMessage(
        `Delete index "${indexName}" on collection "${node.collectionName}"?`,
        { modal: true, detail: 'This removes the index from the SDK store. The data in the collection is not affected, but queries that relied on the index may run slower until you add it back.' },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }
      try {
        await collectionsRepo.dropIndex(indexName, node.collectionName);
        vscode.window.showInformationMessage(`Deleted index "${indexName}".`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.withTag('ext:deleteIndex').error('Drop index failed', { indexName, collection: node.collectionName, err: message });
        vscode.window.showErrorMessage(`Delete index failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('dittoVsce.queryAllInCollection', (databaseIdOrNode: any, collectionName?: string) => {
      // Tree single-click invocation passes (databaseId, collectionName) via `arguments`.
      // Right-click context menu passes the node itself.
      const dbId = typeof databaseIdOrNode === 'string'
        ? databaseIdOrNode
        : databaseIdOrNode?.databaseId;
      const name = collectionName
        ?? (typeof databaseIdOrNode === 'object' ? databaseIdOrNode?.collection?.name : undefined);
      if (!dbId || !name) { return; }
      // Quote only when the name needs it: the prefill lands in the editor as
      // text the user will read and edit, and `SELECT * FROM tasks` is nicer
      // to look at than the backticked form. Names that need backticks get
      // them, so the prefilled query runs as-is either way.
      const from = isBareIdentifier(name) ? name : quoteIdentifier(name, 'collection');
      void vscode.commands.executeCommand('dittoVsce.openQueryEditorWithText', `SELECT * FROM ${from}`);
    }),
  );

  context.subscriptions.push({ dispose: () => manager.disconnect() });
  // Logger disposal goes LAST: subscriptions dispose in registration order
  // and manager.disconnect() (plus everything else) still logs during
  // teardown — disposing the logger first would route those lines into a
  // disposed channel.
  context.subscriptions.push({ dispose: () => { void logger.dispose(); } });
  log.info('Ditto Edge Studio extension activated.');

  // First-run / blank-slate onboarding. When the user has no database
  // connections configured we open the Welcome panel automatically —
  // it walks them through getting Portal credentials and dropping
  // them straight into the Register dialog. Users can always re-open
  // it via the "Ditto: Welcome" command or the tree-view title bar.
  //
  // Defer one tick so VS Code finishes the rest of activate before
  // a webview spawns; doing this synchronously inside activate has
  // (on rare hosts) shown up as "view container not ready yet" race
  // warnings in the extension log.
  if (configStore.list().length === 0) {
    setTimeout(() => {
      // Recheck — another extension command or migration could have
      // added a connection in the interim. Cheap to check; cheaper
      // than dismissing the panel right after it opens.
      if (configStore.list().length === 0) {
        WelcomePanel.show(context, configStore, logger);
      }
    }, 100);
  }

  process.on('uncaughtException', (err) => {
    log.error('UNCAUGHT EXCEPTION', { stack: err.stack ?? err.message });
  });
  process.on('unhandledRejection', (reason) => {
    log.error('UNHANDLED REJECTION', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });

  if (process.env.DITTO_CI_MODE === '1') {
    return makeTestApi({ configStore, secretStore, manager });
  }
  return undefined;
}

export async function deactivate() {
  await waitForConnectionPersistence();
  // logger.dispose() runs via context.subscriptions
}
