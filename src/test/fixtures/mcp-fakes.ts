// Shared fakes/seams for the MCP suites. Everything in-memory; the real
// store classes (ConfigStore, SecretStore, QueryMetricsStore,
// CollectionsRepository) run against the in-memory memento + a scripted
// DittoManager so assertions cover the REAL adapter code paths.

import type { McpToolContext, SwitchAttemptResult } from '../../mcp/context.js';
import type { DittoManager } from '../../ditto/DittoManager.js';
import type { Logger, LogLevel } from '../../logging/types.js';
import { ConfigStore, type MementoLike } from '../../storage/ConfigStore.js';
import { SecretStore } from '../../storage/SecretStore.js';
import { SubscriptionStore } from '../../storage/SubscriptionStore.js';
import { ObserverStore } from '../../storage/ObserverStore.js';
import { QueryMetricsStore } from '../../storage/QueryMetricsStore.js';
import { CollectionsRepository } from '../../ditto/CollectionsRepository.js';
import { SystemMetricsHub } from '../../ditto/SystemMetricsHub.js';
import type { LogAnalyzerService } from '../../logAnalyzer/LogAnalyzerService.js';
import type { PeerListSnapshot, StoredDittoConfig } from '../../models/DittoConfig.js';
import { newConfig } from '../../models/DittoConfig.js';

export function makeMemoryMemento(initial: Record<string, unknown> = {}): MementoLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get<T>(key: string): T | undefined { return data.get(key) as T | undefined; },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) { data.delete(key); } else { data.set(key, value); }
    },
  };
}

export interface SecretMemory {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  data: Map<string, string>;
}

export function makeSecretMemory(): SecretMemory {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k)),
    store: (k, v) => { data.set(k, v); return Promise.resolve(); },
    delete: (k) => { data.delete(k); return Promise.resolve(); },
  };
}

/** Minimal Logger. `canned` backs readRecentLogLines/readAllLogs. */
export function makeFakeLogger(canned: string[] = []): Logger & { written: string[] } {
  const written: string[] = [];
  const noEvent = (): { dispose(): void } => ({ dispose() { /* no-op */ } });
  const self = {
    written,
    error: (m: string) => { written.push(`ERROR ${m}`); },
    warn: (m: string) => { written.push(`WARN ${m}`); },
    info: (m: string) => { written.push(`INFO ${m}`); },
    debug: (m: string) => { written.push(`DEBUG ${m}`); },
    trace: (m: string) => { written.push(`TRACE ${m}`); },
    setChannelLevel: (_l: LogLevel): void => { /* no-op */ },
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: noEvent,
    setSdkLevel: (_l: LogLevel): void => { /* no-op */ },
    getSdkLevel: (): LogLevel => 'info',
    onDidChangeSdkLevel: noEvent,
    withTag: () => self,
    registerKnownSecrets: (_v: readonly string[]): void => { /* no-op */ },
    clearKnownSecrets: (): void => { /* no-op */ },
    readAllLogs: (): Promise<string> => Promise.resolve(canned.join('\n')),
    readRecentLogLines: (n: number): Promise<string[]> => Promise.resolve(canned.slice(-n)),
    setFileLimits: (): Promise<void> => Promise.resolve(),
    pruneLogFilesOlderThan: (): Promise<number> => Promise.resolve(0),
    clearLogFiles: (): Promise<void> => Promise.resolve(),
    dispose: (): Promise<void> => Promise.resolve(),
  };
  return self;
}

export interface DetailedResult {
  rows: Record<string, unknown>[];
  mutatedDocumentIds: string[];
  commitId: string | null;
}

export interface FakeManagerState {
  activeId: string | null;
  statuses: Record<string, 'idle' | 'active' | 'error'>;
  syncState: 'active' | 'idle';
  lifecycleKind: string;
  applyingTransports: boolean;
  snapshot: PeerListSnapshot;
  /** Scripted store executor — drives executeRaw + executeRawDetailed
   *  (and seeds explainQuery/executeQuery defaults). */
  execute: (query: string, args?: Record<string, unknown>) => Promise<DetailedResult>;
  /** Optional full control of the PROFILE pipeline result (executeQuery). */
  runQuery?: (query: string, options?: { collectProfiling?: boolean; collectMetrics?: boolean }) => Promise<{
    rows: Record<string, unknown>[];
    durationMs: number;
    metadata: Record<string, unknown>;
  }>;
  toggleSyncCalls: number;
  appliedTransports: { isLanEnabled: boolean; isBluetoothLeEnabled: boolean; isAwdlEnabled: boolean }[];
  executeCalls: { query: string; args?: Record<string, unknown> }[];
  registeredSubscriptions: { id: string; query: string }[];
  cancelledSubscriptions: string[];
  /** Scripted observer firehose for watch_query tests: when set, the fake
   *  returns a handle and hands the callback back for manual driving. */
  observerHarness?: {
    onRegister(query: string, cb: (ev: {
      rows: Record<string, unknown>[];
      totalRows: number;
      insertions: number[];
      updates: number[];
      deletions: number[];
      moves: { from: number; to: number }[];
    }) => void): void;
    cancelCalls: number;
  };
  /** Scripted attachment fetch for fetch_attachment tests. */
  attachmentScript?: {
    fetch(token: { id: string; len: number | bigint; metadata: Record<string, string> }):
      Promise<{ copyToPath(dest: string): Promise<void>; close(): Promise<void> } | null>;
    fetchCalls: { id: string }[];
    savedTo: string[];
  };
}

export function makeFakeManager(partial: Partial<FakeManagerState> = {}): DittoManager & { state: FakeManagerState } {
  const state: FakeManagerState = {
    activeId: null,
    statuses: {},
    syncState: 'active',
    lifecycleKind: 'idle',
    applyingTransports: false,
    snapshot: { local: null, remote: [] },
    execute: () => Promise.resolve({ rows: [], mutatedDocumentIds: [], commitId: null }),
    toggleSyncCalls: 0,
    appliedTransports: [],
    executeCalls: [],
    registeredSubscriptions: [],
    cancelledSubscriptions: [],
    ...partial,
  };
  const fake = {
    state,
    getActiveConfigId: () => state.activeId,
    getStatus: (id: string) => state.statuses[id] ?? 'idle',
    getSyncState: () => state.syncState,
    getCurrentLifecycleState: () => ({ kind: state.activeId ? 'active' : state.lifecycleKind }),
    isApplyingTransports: () => state.applyingTransports,
    isSwitchInProgress: () => false,
    getLatestSnapshot: () => state.snapshot,
    toggleSync: () => {
      state.toggleSyncCalls += 1;
      state.syncState = state.syncState === 'active' ? 'idle' : 'active';
      return Promise.resolve(state.syncState);
    },
    applyTransportConfig: (prefs: { isLanEnabled: boolean; isBluetoothLeEnabled: boolean; isAwdlEnabled: boolean }) => {
      state.appliedTransports.push(prefs);
      return Promise.resolve();
    },
    executeRaw: async (query: string, args?: Record<string, unknown>) => {
      state.executeCalls.push(args === undefined ? { query } : { query, args });
      return (await state.execute(query, args)).rows;
    },
    executeRawDetailed: async (query: string, args?: Record<string, unknown>) => {
      state.executeCalls.push(args === undefined ? { query } : { query, args });
      return state.execute(query, args);
    },
    registerStoreObserver: () => null,
    registerObserver: (query: string, cb: unknown) => {
      if (!state.observerHarness) { return null; }
      state.observerHarness.onRegister(query, cb as never);
      return {
        cancel: () => {
          if (state.observerHarness) { state.observerHarness.cancelCalls += 1; }
        },
      };
    },
    fetchAttachment: (token: { id: string; len: number | bigint; metadata: Record<string, string> }, _onEvent?: unknown) => {
      if (!state.attachmentScript || !state.activeId) { return null; }
      state.attachmentScript.fetchCalls.push({ id: token.id });
      return Promise.resolve(state.attachmentScript.fetch(token));
    },
    saveAttachmentToPath: async (attachment: { copyToPath(dest: string): Promise<void> }, destPath: string) => {
      if (state.attachmentScript) { state.attachmentScript.savedTo.push(destPath); }
      await attachment.copyToPath(destPath);
    },
    cborBytesForCollection: async (collectionExpr: string) => {
      const r = await state.execute(`SELECT * FROM ${collectionExpr}`);
      return { documentCount: r.rows.length, totalBytes: r.rows.length * 10 };
    },
    registerSubscription: (id: string, query: string) => {
      state.registeredSubscriptions.push({ id, query });
    },
    cancelSubscription: (id: string) => {
      state.cancelledSubscriptions.push(id);
      state.registeredSubscriptions = state.registeredSubscriptions.filter(s => s.id !== id);
    },
    explainQuery: async (query: string) => {
      state.executeCalls.push({ query: `EXPLAIN ${query}` });
      const r = await state.execute(`EXPLAIN ${query}`);
      const plan = r.rows[0];
      if (!plan) { throw new Error('EXPLAIN returned no plan.'); }
      return plan;
    },
    executeQuery: async (query: string, options?: { collectProfiling?: boolean; collectMetrics?: boolean }) => {
      if (state.runQuery) { return state.runQuery(query, options); }
      const r = await state.execute(query);
      return {
        rows: r.rows,
        durationMs: 1,
        metadata: {
          dql: query, durationMs: 1, resultCount: r.rows.length,
          explain: '', timestamp: Date.now(),
        },
      };
    },
    onStatusChange: () => ({ dispose() { /* no-op */ } }),
    onPresence: () => ({ dispose() { /* no-op */ } }),
    onSyncChange: () => ({ dispose() { /* no-op */ } }),
    onLifecycleStateChange: () => ({ dispose() { /* no-op */ } }),
  };
  return fake as unknown as DittoManager & { state: FakeManagerState };
}

export function seedConfig(overrides: Partial<StoredDittoConfig> = {}): StoredDittoConfig {
  return {
    ...newConfig(),
    id: 'cfg-1',
    name: 'Dev DB',
    databaseId: 'db-123',
    mode: 'server',
    authUrl: 'https://acme.ditto.live',
    httpApiUrl: 'acme.ditto.live:443',
    ...overrides,
  };
}

export interface FakeContextBundle {
  ctx: McpToolContext;
  manager: ReturnType<typeof makeFakeManager>;
  configStore: ConfigStore;
  secretStore: SecretStore;
  secrets: SecretMemory;
  collectionsRepo: CollectionsRepository;
  queryMetrics: QueryMetricsStore;
  subscriptionStore: SubscriptionStore;
  observerStore: ObserverStore;
  systemMetricsHub: SystemMetricsHub;
  logger: Logger & { written: string[] };
  /** Script connect outcomes for the automation seam. */
  automationScript: {
    connectImpl: (idOrName: string) => Promise<SwitchAttemptResult>;
    disconnectImpl: () => Promise<boolean>;
    connectCalls: string[];
    disconnectCalls: number;
  };
  /** Scripted Log Analyzer responses for query_log_analyzer tests. */
  logAnalyzerScript: {
    queryLinesResult: unknown;
    openCalls: string[];
    queryLinesCalls: Record<string, unknown>[];
  };
}

export function makeContext(opts: {
  configs?: StoredDittoConfig[];
  activeId?: string | null;
  logLines?: string[];
  manager?: Partial<FakeManagerState>;
} = {}): FakeContextBundle {
  const memento = makeMemoryMemento();
  const configStore = new ConfigStore(memento);
  const secrets = makeSecretMemory();
  const secretStore = new SecretStore(secrets);
  const manager = makeFakeManager({ activeId: opts.activeId ?? null, ...opts.manager });
  const logger = makeFakeLogger(opts.logLines ?? []);
  const collectionsRepo = new CollectionsRepository(manager, logger);
  const queryMetrics = new QueryMetricsStore();
  const subscriptionStore = new SubscriptionStore(memento);
  const observerStore = new ObserverStore(memento);
  const systemMetricsHub = new SystemMetricsHub(manager, logger);

  const automationScript = {
    connectImpl: (idOrName: string): Promise<SwitchAttemptResult> =>
      Promise.resolve({ kind: 'connected' as const, configId: idOrName, name: idOrName }),
    disconnectImpl: (): Promise<boolean> => Promise.resolve(true),
    connectCalls: [] as string[],
    disconnectCalls: 0,
  };

  const logAnalyzerScript = {
    queryLinesResult: { items: [], total: 0 } as unknown,
    openCalls: [] as string[],
    queryLinesCalls: [] as Record<string, unknown>[],
  };

  const ctx: McpToolContext = {
    manager,
    configStore,
    secretStore,
    collectionsRepo,
    queryMetrics,
    subscriptionStore,
    observerStore,
    logger,
    globalStorageFsPath: '/tmp/fake-globalstorage',
    systemMetricsHub,
    openLogAnalyzer: (configId: string) => {
      logAnalyzerScript.openCalls.push(configId);
      return Promise.resolve({
        queryLines: (opts: Record<string, unknown>) => {
          logAnalyzerScript.queryLinesCalls.push(opts);
          return logAnalyzerScript.queryLinesResult;
        },
      } as unknown as LogAnalyzerService);
    },
    automation: {
      connect: (idOrName) => {
        automationScript.connectCalls.push(idOrName);
        return automationScript.connectImpl(idOrName);
      },
      disconnect: () => {
        automationScript.disconnectCalls += 1;
        return automationScript.disconnectImpl();
      },
    },
    log: logger,
  };

  // Seed configs synchronously into the memento so tests don't await.
  memento.data.set('dittoConfigs.v1', opts.configs ?? [seedConfig()]);

  return {
    ctx, manager, configStore, secretStore, secrets, collectionsRepo,
    queryMetrics, subscriptionStore, observerStore, systemMetricsHub, logger, automationScript,
    logAnalyzerScript,
  };
}

/** Seed the connection's secrets the way the editor's save flow would. */
export async function seedSecrets(bundle: FakeContextBundle, configId: string, values: {
  token?: string;
  secretKey?: string;
  httpApiKey?: string;
}): Promise<void> {
  const { data } = bundle.secrets;
  if (values.token !== undefined) { data.set(`ditto.${configId}.token`, values.token); }
  if (values.secretKey !== undefined) { data.set(`ditto.${configId}.secretKey`, values.secretKey); }
  if (values.httpApiKey !== undefined) { data.set(`ditto.${configId}.httpApiKey`, values.httpApiKey); }
}
