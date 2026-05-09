import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  Ditto,
  DittoConfig,
  Authenticator,
  Logger as DittoLogger,
  type PresenceGraph,
  type Attachment,
  type AttachmentFetcher,
  type AttachmentFetchEvent,
} from '@dittolive/ditto';
import type {
  StoredDittoConfig,
  SecretSet,
  StoredSubscription,
  PeerListSnapshot,
  LocalPeerInfo,
} from '../models/DittoConfig.js';
import type { DatabaseStatus } from '../tree/DatabaseTreeProvider.js';
import { mergePeerList, parseSyncStatusRow, type SyncStatusRow } from './peer-info.js';
import type { Logger } from '../logging/types.js';
import {
  reduceLifecycle,
  isSwitchInProgress as reducerIsSwitchInProgress,
  type LifecycleState,
  type LifecycleAction,
} from './lifecycle-state.js';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';

type StatusListener = (status: DatabaseStatus, configId: string | null) => void;
type PresenceListener = (snapshot: PeerListSnapshot) => void;
type SyncListener = (sync: SyncState, configId: string | null) => void;
export type SyncState = 'active' | 'idle';

interface ActiveSession {
  configId: string;
  ditto: Ditto;
  presenceObserver?: { stop?: () => void };
  syncStatusObserver?: { cancel?: () => void };
  subscriptionHandles: Map<string, { cancel: () => void }>;
  presenceCoalesceTimer?: NodeJS.Timeout;
}

const SYNC_STATUS_HANDLE_ID = '__sync_status';

export class DittoManager {
  private session: ActiveSession | null = null;
  private status: DatabaseStatus = 'idle';
  private syncState: SyncState = 'idle';
  private statusListeners = new Set<StatusListener>();
  private presenceListeners = new Set<PresenceListener>();
  private syncListeners = new Set<SyncListener>();

  private latestPresence: PresenceGraph | null = null;
  private syncStatusByPeerKey = new Map<string, SyncStatusRow>();
  private localPeerInfo: LocalPeerInfo | null = null;
  private previousOrder: string[] = [];
  private latestSnapshot: PeerListSnapshot = { local: null, remote: [] };

  private lifecycleState: LifecycleState = { kind: 'idle' };
  private readonly lifecycleEmitter = new vscode.EventEmitter<LifecycleState>();
  readonly onLifecycleStateChange = this.lifecycleEmitter.event;

  private readonly log: Logger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    parentLogger: Logger
  ) {
    this.log = parentLogger.withTag('ext:DittoManager');
  }

  getStatus(configId: string): DatabaseStatus {
    if (!this.session) { return 'idle'; }
    if (this.session.configId === configId) { return this.status; }
    return 'idle';
  }

  getActiveConfigId(): string | null { return this.session?.configId ?? null; }
  getLatestSnapshot(): PeerListSnapshot { return this.latestSnapshot; }
  getSyncState(): SyncState { return this.syncState; }

  onStatusChange(l: StatusListener): vscode.Disposable {
    this.statusListeners.add(l);
    return new vscode.Disposable(() => this.statusListeners.delete(l));
  }

  onPresence(l: PresenceListener): vscode.Disposable {
    this.presenceListeners.add(l);
    return new vscode.Disposable(() => this.presenceListeners.delete(l));
  }

  onSyncChange(l: SyncListener): vscode.Disposable {
    this.syncListeners.add(l);
    return new vscode.Disposable(() => this.syncListeners.delete(l));
  }

  getCurrentLifecycleState(): LifecycleState { return this.lifecycleState; }
  isSwitchInProgress(): boolean { return reducerIsSwitchInProgress(this.lifecycleState); }

  private dispatch(action: LifecycleAction): LifecycleState {
    const next = reduceLifecycle(this.lifecycleState, action);
    if (next === this.lifecycleState) { return next; }
    const from = this.lifecycleState.kind;
    this.lifecycleState = next;
    this.log.info('Lifecycle transition', { from, action: action.type });
    this.lifecycleEmitter.fire(next);
    return next;
  }

  async connect(
    config: StoredDittoConfig,
    secrets: SecretSet,
    initialSubs: StoredSubscription[] = []
  ): Promise<void> {
    const wasActive = this.session != null;
    if (wasActive) {
      this.dispatch({ type: 'switchStart', toConfigId: config.id });
    } else {
      this.dispatch({ type: 'connectStart', configId: config.id });
    }
    if (this.session) { await this.disconnect(); }
    this.setStatus('activating', config.id);
    try {
      const persistenceDir = path.join(this.context.globalStorageUri.fsPath, 'dittoData', config.id);
      fs.mkdirSync(persistenceDir, { recursive: true });

      const dittoCfg = new DittoConfig(
        config.databaseId,
        config.mode === 'server'
          ? { mode: 'server', url: config.authUrl }
          : { mode: 'smallPeersOnly' as const },
        persistenceDir
      );

      // Apply per-DB SDK log level before opening the SDK.
      const sdkLevelMap: Record<string, any> = {
        error: 'Error', warning: 'Warning', warn: 'Warning',
        info: 'Info', debug: 'Debug', verbose: 'Verbose', trace: 'Verbose',
      };
      (DittoLogger as any).minimumLogLevel = sdkLevelMap[config.logLevel] ?? 'Info';
      this.log.info('Applied per-DB SDK log level', { configId: config.id, level: config.logLevel });

      const ditto = await Ditto.open(dittoCfg);

      ditto.updateTransportConfig((c) => {
        c.peerToPeer.bluetoothLE.isEnabled = false;
        c.peerToPeer.awdl.isEnabled = false;
        c.peerToPeer.lan.isEnabled = true;
        c.peerToPeer.lan.isMdnsEnabled = true;
        c.peerToPeer.lan.isMulticastEnabled = true;
      });

      if (config.mode === 'server' && ditto.auth.loginSupported) {
        await ditto.auth.setExpirationHandler(async (instance) => {
          if (instance.auth.loginSupported) {
            await instance.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
          }
        });
        const result = await ditto.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
        if ((result as any).error) { throw new Error(`Login failed: ${(result as any).error}`); }
      }

      ditto.sync.start();

      this.session = {
        configId: config.id,
        ditto,
        subscriptionHandles: new Map(),
      };

      this.attachPresenceObserver(ditto);
      this.attachSyncStatusObserver(ditto);
      await this.loadLocalPeerInfo(ditto);

      // Re-register persisted subscriptions
      for (const sub of initialSubs) {
        try {
          const handle = ditto.sync.registerSubscription(sub.query);
          this.session.subscriptionHandles.set(sub.id, handle);
        } catch (err) {
          this.log.warn('Subscription register failed', { name: sub.name, err: err instanceof Error ? err.message : String(err) });
        }
      }

      this.setSyncState('active', config.id);
      this.dispatch({ type: 'connectOk' });
      this.setStatus('active', config.id);
      this.firePresence();
      this.log.info('Connected', { name: config.name, configId: config.id, mode: config.mode });
    } catch (err) {
      this.log.error('Connect failed', { configId: config.id, err: err instanceof Error ? err.stack : String(err) });
      this.setStatus('error', config.id);
      this.dispatch({ type: 'connectFail', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    if (!s) { return; }
    this.dispatch({ type: 'disconnectStart' });
    this.session = null;
    if (s.presenceCoalesceTimer) { clearTimeout(s.presenceCoalesceTimer); }
    try {
      for (const h of s.subscriptionHandles.values()) { try { h.cancel(); } catch { /* ignore */ } }
      try { s.syncStatusObserver?.cancel?.(); } catch { /* ignore */ }
      try { s.presenceObserver?.stop?.(); } catch { /* ignore */ }
      try { s.ditto.sync.stop(); } catch { /* ignore */ }
      try { await s.ditto.close(); } catch { /* ignore */ }
    } finally {
      this.latestPresence = null;
      this.syncStatusByPeerKey.clear();
      this.localPeerInfo = null;
      this.previousOrder = [];
      this.latestSnapshot = { local: null, remote: [] };
      this.firePresence();
      this.setSyncState('idle', null);
      this.setStatus('idle', null);
      this.dispatch({ type: 'disconnectOk' });
      this.log.info('Disconnected');
    }
  }

  async toggleSync(): Promise<SyncState> {
    if (!this.session) { return 'idle'; }
    const ditto = this.session.ditto;
    if (this.syncState === 'active') {
      ditto.sync.stop();
      this.setSyncState('idle', this.session.configId);
      return 'idle';
    }
    ditto.sync.start();
    this.setSyncState('active', this.session.configId);
    return 'active';
  }

  registerSubscription(subId: string, query: string) {
    if (!this.session) { return; }
    if (this.session.subscriptionHandles.has(subId)) { return; }
    const handle = this.session.ditto.sync.registerSubscription(query);
    this.session.subscriptionHandles.set(subId, handle);
  }

  cancelSubscription(subId: string) {
    if (!this.session) { return; }
    const h = this.session.subscriptionHandles.get(subId);
    if (h) { try { h.cancel(); } catch { /* ignore */ } }
    this.session.subscriptionHandles.delete(subId);
  }

  /**
   * Begin fetching an attachment by token against the active database.
   *
   * Returns the SDK's {@link AttachmentFetcher} (which is `PromiseLike<Attachment | null>`)
   * so callers can `await` it directly and obtain the attachment bytes via `attachment.data()`.
   * Returns `null` if there is no active session.
   *
   * The optional `onEvent` callback receives `Progress`, `Completed`, and `Deleted` events
   * during the fetch.
   */
  fetchAttachment(
    token: { id: string; len: number | bigint; metadata: { [key: string]: string } },
    onEvent?: (event: AttachmentFetchEvent) => void,
  ): AttachmentFetcher | null {
    if (!this.session) { return null; }
    return this.session.ditto.store.fetchAttachment(token, onEvent);
  }

  /** Run a one-shot DQL query against the active database. Used by QueryEditorPanel.
   *  Tries `EXPLAIN <query>` first to harvest plan/index metadata; falls back to
   *  the plain query if the SDK rejects the prefixed form.
   */
  async executeQuery(query: string): Promise<{ rows: Record<string, unknown>[]; durationMs: number; metadata: QueryResultMetadata }> {
    if (!this.session) { throw new Error('No active database.'); }
    const start = performance.now();
    const explained = `EXPLAIN ${query}`;
    let result: any;
    let metadata: QueryResultMetadata = { durationMs: 0, timestamp: Date.now() };
    try {
      result = await this.session.ditto.store.execute(explained);
      metadata = {
        durationMs: Math.round(performance.now() - start),
        resultCount: result.items.length,
        usedIndex: !!result.metadata?.usedIndex,
        explain: result.metadata?.explain ?? result.metadata?.queryPlan ?? '',
        timestamp: Date.now(),
      };
    } catch (err) {
      this.log.warn('EXPLAIN-prefixed execute failed; falling back to plain', {
        err: err instanceof Error ? err.message : String(err),
      });
      result = await this.session.ditto.store.execute(query);
      metadata = {
        durationMs: Math.round(performance.now() - start),
        resultCount: result.items.length,
        timestamp: Date.now(),
      };
    }
    const rows = (result.items as any[]).map((i: any) => i.value as Record<string, unknown>);
    return { rows, durationMs: metadata.durationMs ?? 0, metadata };
  }

  // ─── private ─────────────────────────────────────────────────

  private attachPresenceObserver(ditto: Ditto) {
    let pending: PresenceGraph | null = null;
    const flush = () => {
      if (!this.session) { return; }
      this.session.presenceCoalesceTimer = undefined;
      if (pending) {
        this.latestPresence = pending;
        pending = null;
        this.firePresence();
      }
    };
    const observer = ditto.presence.observe((graph: PresenceGraph) => {
      pending = graph;
      if (this.session && !this.session.presenceCoalesceTimer) {
        this.session.presenceCoalesceTimer = setTimeout(flush, 250);
      }
    });
    if (this.session) { this.session.presenceObserver = observer as any; }
  }

  private attachSyncStatusObserver(ditto: Ditto) {
    if (!this.session) { return; }
    const query = 'SELECT * FROM __sync_status';
    try {
      const subHandle = ditto.sync.registerSubscription(query);
      this.session.subscriptionHandles.set(SYNC_STATUS_HANDLE_ID, subHandle);
    } catch (err) {
      this.log.warn('__sync_status subscription failed', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    try {
      const obs = ditto.store.registerObserver(query, (result: any) => {
        if (!this.session) { return; }
        const next = new Map<string, SyncStatusRow>();
        for (const item of result.items) {
          const row = parseSyncStatusRow(item.value);
          if (row) { next.set(row._id, row); }
        }
        this.syncStatusByPeerKey = next;
        this.firePresence();
      });
      this.session.syncStatusObserver = obs as any;
    } catch (err) {
      this.log.warn('__sync_status observer failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadLocalPeerInfo(ditto: Ditto) {
    try {
      const result = await ditto.store.execute(
        'SELECT ditto_sdk_language, ditto_sdk_platform, ditto_sdk_version FROM __small_peer_info'
      );
      const items: any[] = (result as any).items ?? [];
      const first = items[0]?.value ?? {};
      this.localPeerInfo = {
        deviceName: 'VS Code',
        sdkLanguage: typeof first.ditto_sdk_language === 'string' ? first.ditto_sdk_language : '',
        sdkPlatform: typeof first.ditto_sdk_platform === 'string' ? first.ditto_sdk_platform : '',
        sdkVersion: typeof first.ditto_sdk_version === 'string' ? first.ditto_sdk_version : '',
      };
    } catch (err) {
      this.log.warn('__small_peer_info query failed', { err: err instanceof Error ? err.message : String(err) });
      this.localPeerInfo = null;
    }
  }

  private firePresence() {
    if (this.latestPresence) {
      const snap = mergePeerList(
        this.latestPresence as any,
        this.syncStatusByPeerKey,
        this.localPeerInfo,
        this.previousOrder,
      );
      this.previousOrder = snap.remote.map(p => p.id);
      this.latestSnapshot = snap;
    } else {
      this.latestSnapshot = { local: this.localPeerInfo, remote: [] };
    }
    for (const l of this.presenceListeners) { l(this.latestSnapshot); }
  }

  private setStatus(s: DatabaseStatus, configId: string | null) {
    this.status = s;
    for (const l of this.statusListeners) { l(s, configId); }
  }

  private setSyncState(s: SyncState, configId: string | null) {
    if (this.syncState === s) { return; }
    this.syncState = s;
    for (const l of this.syncListeners) { l(s, configId); }
  }
}
