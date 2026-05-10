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
  SdkLogLevel,
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
import { detectPlatform, transportSupportFor } from '../util/platform.js';
import type { ConfigStore } from '../storage/ConfigStore.js';

export interface TransportPrefs {
  isLanEnabled: boolean;
  isBluetoothLeEnabled: boolean;
  isAwdlEnabled: boolean;
}

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
  private applyingTransports = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    parentLogger: Logger,
    private readonly configStore?: ConfigStore,
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

      // Apply per-DB SDK log level before opening the SDK. `config.logLevel`
      // is `SdkLogLevel` (lowercase 'warning'/'verbose'); the SDK runtime
      // expects capitalized names.
      const sdkLevelMap: Record<SdkLogLevel, string> = {
        error: 'Error', warning: 'Warning',
        info: 'Info', debug: 'Debug', verbose: 'Verbose',
      };
      (DittoLogger as any).minimumLogLevel = sdkLevelMap[config.logLevel] ?? 'Info';
      this.log.info('Applied per-DB SDK log level', { configId: config.id, level: config.logLevel });

      const ditto = await Ditto.open(dittoCfg);

      // Per-DB transport prefs gated by the runtime's OS support matrix.
      // The OS gate is defense-in-depth: even if a synced/replicated config
      // sets `isAwdlEnabled = true`, a Linux runtime keeps AWDL off because
      // `support.awdl` is false there.
      const support = transportSupportFor(detectPlatform());
      ditto.updateTransportConfig((c) => {
        const lanOn = config.isLanEnabled ?? true;
        c.peerToPeer.lan.isEnabled = lanOn;
        c.peerToPeer.lan.isMdnsEnabled = lanOn;
        c.peerToPeer.lan.isMulticastEnabled = lanOn;
        c.peerToPeer.bluetoothLE.isEnabled =
          support.bluetoothLE && (config.isBluetoothLeEnabled ?? support.bluetoothLE);
        c.peerToPeer.awdl.isEnabled =
          support.awdl && (config.isAwdlEnabled ?? support.awdl);
      });
      this.logTransportReadback(ditto, 'connect');

      if (config.mode === 'server' && ditto.auth.loginSupported) {
        await ditto.auth.setExpirationHandler(async (instance) => {
          if (instance.auth.loginSupported) {
            await instance.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
          }
        });
        const result = await ditto.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
        if ((result as any).error) { throw new Error(`Login failed: ${(result as any).error}`); }
      }

      await ditto.store.execute('ALTER SYSTEM SET mesh_chooser_max_wlan_clients = 12');
      this.log.info('Set mesh_chooser_max_wlan_clients to 12 to improve amount of peers connectivity.');
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
      // Bound Ditto.close() at 10s; on timeout, force-discard the instance.
      // SDK can hang when network teardown blocks (Lifecycle spec §3.3 risk).
      try {
        await Promise.race([
          s.ditto.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Ditto.close() timed out after 10s')), 10_000),
          ),
        ]);
      } catch (err) {
        this.log.warn('Ditto.close() failed or timed out — discarding instance', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
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
      // Force an immediate snapshot rebuild — mergePeerList's syncActive=false
      // gate will drop the cloud row this turn, instead of waiting for the
      // next presence emission (which may not arrive for a while after
      // sync.stop, and which would otherwise show a stale "Connected" cloud
      // peer until system:data_sync_info caught up).
      this.firePresence();
      return 'idle';
    }
    ditto.sync.start();
    this.setSyncState('active', this.session.configId);
    this.firePresence();
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

  /** Run a raw DQL query and return its rows. No EXPLAIN side-trip, no
   *  history — meant for system queries (CollectionsRepository, etc.).
   *  Optional `args` map binds `:name` placeholders for parameterised
   *  UPDATE/INSERT statements (used by the attachment add/delete
   *  flows). */
  async executeRaw(query: string, args?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    if (!this.session) { throw new Error('No active database.'); }
    const result = args === undefined
      ? await this.session.ditto.store.execute(query)
      : await this.session.ditto.store.execute(query, args as any);
    return (result.items as any[]).map(i => i.value as Record<string, unknown>);
  }

  /**
   * Sum the CBOR byte count for every row in `collectionExpr` —
   * `collectionExpr` is whatever appears after `FROM` (caller is
   * responsible for backtick-quoting if the collection name needs
   * escaping). Materializes each row, reads `.cborData().byteLength`,
   * then dematerializes — bounded memory regardless of collection
   * size. Mirrors SwiftUI's per-row cborData() loop in
   * `StorageRepository.computeCollectionBreakdown`.
   */
  async cborBytesForCollection(
    collectionExpr: string,
  ): Promise<{ documentCount: number; totalBytes: number }> {
    if (!this.session) { throw new Error('No active database.'); }
    const result = await this.session.ditto.store.execute(`SELECT * FROM ${collectionExpr}`);
    let totalBytes = 0;
    let documentCount = 0;
    for (const item of result.items as any[]) {
      try {
        const bytes: Uint8Array = item.cborData();
        totalBytes += bytes.byteLength;
        documentCount += 1;
      } finally {
        try { item.dematerialize?.(); } catch { /* ignore */ }
      }
    }
    return { documentCount, totalBytes };
  }

  /** Create a new Ditto attachment from a local file path. The returned
   *  object can be passed straight into a DQL UPDATE via executeRaw's
   *  `args` map: `UPDATE col SET field = :att WHERE _id = :docId`.
   *  Mirrors `ditto.store.newAttachment` from the SwiftUI implementation. */
  async newAttachment(
    filePath: string,
    metadata: Record<string, string>,
  ): Promise<unknown> {
    if (!this.session) { throw new Error('No active database.'); }
    return this.session.ditto.store.newAttachment(filePath, metadata as any);
  }

  /**
   * Register a live store observer for `query` (Node SDK
   * `ditto.store.registerObserver`). Fires once with the current
   * result set on registration and again whenever the SDK detects a
   * change — used by {@link CollectionsRepository} to keep
   * `__collections` up to date when synced data introduces (or
   * removes) a collection. Returns a cancel handle the caller is
   * responsible for invoking on teardown, or `null` if there is no
   * active session.
   *
   * Each item is `dematerialize()`d immediately after we read its
   * `.value` so the SDK can release the materialized object —
   * matches the SwiftUI repository's pattern, otherwise items pin
   * themselves in memory for the life of the result.
   */
  registerStoreObserver(
    query: string,
    callback: (rows: Record<string, unknown>[]) => void,
  ): { cancel(): void } | null {
    if (!this.session) { return null; }
    const observer = this.session.ditto.store.registerObserver(query, (queryResult) => {
      const rows: Record<string, unknown>[] = [];
      for (const item of queryResult.items) {
        const value = item.value as Record<string, unknown>;
        item.dematerialize();
        rows.push(value);
      }
      try { callback(rows); }
      catch (err) {
        this.log.warn('Store observer callback threw', {
          query, err: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return { cancel: () => { try { observer.cancel(); } catch { /* ignore */ } } };
  }

  /** Run a one-shot DQL query against the active database. Used by QueryEditorPanel.
   *
   *  Mirrors the SwiftUI `QueryService.executeSelectedAppQuery` pattern: run the
   *  user's query as-is for real result rows, then issue a SECOND `EXPLAIN <query>`
   *  call to harvest plan metadata. Running EXPLAIN inline (prefixed) returns the
   *  plan rows in place of the actual results, which is not what callers want.
   */
  async executeQuery(query: string): Promise<{ rows: Record<string, unknown>[]; durationMs: number; metadata: QueryResultMetadata }> {
    if (!this.session) { throw new Error('No active database.'); }
    const start = performance.now();
    const result = await this.session.ditto.store.execute(query);
    const durationMs = Math.round(performance.now() - start);
    const rows = (result.items as any[]).map((i: any) => i.value as Record<string, unknown>);

    // Capture the EXPLAIN plan as a separate, non-fatal call. If the user
    // already prefixed EXPLAIN themselves, skip the recursive lookup.
    const explain = await this.runExplain(query);

    const metadata: QueryResultMetadata = {
      dql: query,
      durationMs,
      resultCount: rows.length,
      explain,
      timestamp: Date.now(),
    };
    return { rows, durationMs, metadata };
  }

  /** Captures `EXPLAIN <query>` output as a pretty-printed JSON string.
   *  Failures degrade the metrics tab but never break the main query.
   *  Mirrors `QueryService.runExplain` in the SwiftUI app. */
  private async runExplain(query: string): Promise<string> {
    if (!this.session) { return ''; }
    if (query.trimStart().toUpperCase().startsWith('EXPLAIN')) { return ''; }
    try {
      const result = await this.session.ditto.store.execute(`EXPLAIN ${query}`);
      const first = (result.items as any[])[0]?.value;
      if (!first) { return ''; }
      return JSON.stringify(first, null, 2);
    } catch (err) {
      this.log.warn('EXPLAIN failed; metrics tab will show plan unavailable', {
        err: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  /** True while a transport-config apply is in flight. Callers (extension.ts
   *  command handlers) should bail with "Transport change in progress" rather
   *  than racing connect/disconnect against an in-flight cycle. */
  isApplyingTransports(): boolean { return this.applyingTransports; }

  /**
   * Soft-cycle transport configuration without closing the Ditto instance.
   *
   * Mirrors the SwiftUI `applyTransportConfig` flow: stop sync → tear down
   * presence + sync_status observers (Ditto stays open) → updateTransportConfig
   * with the OS-gated user prefs → readback log → persist back to ConfigStore
   * → restart sync → re-attach observers + refresh local peer info.
   *
   * On error in any phase we still attempt to restart sync + reattach observers
   * inside the finally block so the user isn't left with a stranded session.
   */
  async applyTransportConfig(opts: TransportPrefs): Promise<void> {
    if (!this.session) { throw new Error('No active database.'); }
    if (this.applyingTransports) { throw new Error('Transport change already in progress.'); }
    const session = this.session;
    const ditto = session.ditto;
    const configId = session.configId;

    // OS gate the user's request — a Linux runtime can never end up with
    // AWDL on, even if the webview sends `isAwdlEnabled: true` (e.g. via a
    // stale UI state).
    const support = transportSupportFor(detectPlatform());
    const gated: TransportPrefs = {
      isLanEnabled: opts.isLanEnabled,
      isBluetoothLeEnabled: support.bluetoothLE && opts.isBluetoothLeEnabled,
      isAwdlEnabled: support.awdl && opts.isAwdlEnabled,
    };

    this.applyingTransports = true;
    let phase: 'stoppingSync' | 'tearingDownObservers' | 'applyingConfig' | 'persisting' | 'restartingSync' | 'reattachingObservers' = 'stoppingSync';
    try {
      this.log.info('Transport apply: stopping sync', { configId });
      try { ditto.sync.stop(); } catch { /* ignore — best-effort */ }

      phase = 'tearingDownObservers';
      // Tear down observers + clear derived state, but KEEP the Ditto instance.
      try { session.presenceObserver?.stop?.(); } catch { /* ignore */ }
      session.presenceObserver = undefined;
      try { session.syncStatusObserver?.cancel?.(); } catch { /* ignore */ }
      session.syncStatusObserver = undefined;
      if (session.presenceCoalesceTimer) {
        clearTimeout(session.presenceCoalesceTimer);
        session.presenceCoalesceTimer = undefined;
      }
      this.latestPresence = null;
      this.syncStatusByPeerKey.clear();
      this.previousOrder = [];
      this.latestSnapshot = { local: this.localPeerInfo, remote: [] };
      // Push the empty state so the UI reflects the pre-apply clear immediately.
      this.firePresence();

      phase = 'applyingConfig';
      ditto.updateTransportConfig((c) => {
        c.peerToPeer.lan.isEnabled = gated.isLanEnabled;
        c.peerToPeer.lan.isMdnsEnabled = gated.isLanEnabled;
        c.peerToPeer.lan.isMulticastEnabled = gated.isLanEnabled;
        c.peerToPeer.bluetoothLE.isEnabled = gated.isBluetoothLeEnabled;
        c.peerToPeer.awdl.isEnabled = gated.isAwdlEnabled;
      });
      this.logTransportReadback(ditto, 'applyTransportConfig');
      this.log.info('Transport apply: applied', { configId, prefs: gated });

      phase = 'persisting';
      // Persist to ConfigStore between updateTransportConfig and restart so a
      // crash mid-restart still keeps the new prefs on disk.
      if (this.configStore) {
        const cfg = this.configStore.get(configId);
        if (cfg) {
          await this.configStore.save({
            ...cfg,
            isLanEnabled: gated.isLanEnabled,
            isBluetoothLeEnabled: gated.isBluetoothLeEnabled,
            isAwdlEnabled: gated.isAwdlEnabled,
          });
        } else {
          this.log.warn('Transport apply: configStore had no entry for configId', { configId });
        }
      } else {
        this.log.warn('Transport apply: no configStore reference — skipping persistence', { configId });
      }
    } catch (err) {
      this.log.error('Transport apply: failed', {
        phase, configId, err: err instanceof Error ? err.stack : String(err),
      });
      // Still attempt to restart sync + re-attach observers inside finally
      // so the user isn't left with a stranded session.
      throw err;
    } finally {
      // Restart + reattach are best-effort recovery; if they throw we log and
      // surface the original error (or the new restart error if no original).
      try {
        this.log.info('Transport apply: restarting sync', { configId });
        ditto.sync.start();
      } catch (err) {
        this.log.error('Transport apply: sync.start() failed', {
          configId, err: err instanceof Error ? err.stack : String(err),
        });
        this.applyingTransports = false;
        throw err;
      }
      try {
        this.attachPresenceObserver(ditto);
        this.attachSyncStatusObserver(ditto);
        await this.loadLocalPeerInfo(ditto);
        this.setSyncState('active', configId);
        this.firePresence();
        this.log.info('Transport apply: complete', { configId });
      } catch (err) {
        this.log.error('Transport apply: re-attach observers failed', {
          configId, err: err instanceof Error ? err.stack : String(err),
        });
      }
      this.applyingTransports = false;
    }
  }

  /** Read each transport's `isEnabled` back from `ditto.transportConfig` and
   *  log it. Mirrors SwiftUI's `logTransportReadback` — defensive surface for
   *  SDK no-ops where update silently drops a flag. */
  private logTransportReadback(ditto: Ditto, context: string): void {
    try {
      const tc: any = (ditto as any).transportConfig;
      const p2p = tc?.peerToPeer ?? {};
      this.log.info('Transport readback', {
        context,
        lan: !!p2p.lan?.isEnabled,
        lanMdns: !!p2p.lan?.isMdnsEnabled,
        lanMulticast: !!p2p.lan?.isMulticastEnabled,
        bluetoothLE: !!p2p.bluetoothLE?.isEnabled,
        awdl: !!p2p.awdl?.isEnabled,
      });
    } catch (err) {
      this.log.warn('Transport readback failed', {
        context, err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── private ─────────────────────────────────────────────────

  private attachPresenceObserver(ditto: Ditto) {
    let pending: PresenceGraph | null = null;
    const flush = async () => {
      if (!this.session) { return; }
      this.session.presenceCoalesceTimer = undefined;
      if (!pending) { return; }
      const graph = pending;
      pending = null;
      // Refetch sync metrics on every presence emission. Mirrors SwiftUI:
      // SystemRepository runs a one-shot SELECT * FROM system:data_sync_info
      // inside the presence callback. Cheap — the 250ms coalesce caps the
      // rate, and a failure here just degrades to presence-only data.
      await this.refreshSyncMetrics(ditto);
      // Bail if the session was torn down during the await.
      if (!this.session) { return; }
      this.latestPresence = graph;
      this.firePresence();
    };
    const observer = ditto.presence.observe((graph: PresenceGraph) => {
      pending = graph;
      if (this.session && !this.session.presenceCoalesceTimer) {
        this.session.presenceCoalesceTimer = setTimeout(() => { void flush(); }, 250);
      }
    });
    if (this.session) { this.session.presenceObserver = observer as any; }
  }

  /**
   * Refresh `syncStatusByPeerKey` from the SDK's `system:data_sync_info`
   * collection. This is the canonical source for per-peer sync metrics
   * (commit ids, last-update timestamps, is_ditto_server flag) — SwiftUI
   * Edge Studio reads from the same collection.
   *
   * Implemented as a one-shot DQL query rather than a live observer because
   * `system:*` collections don't accept sync subscriptions and our prior
   * `__sync_status` observer was silently failing — leaving every peer card
   * with no commitId, no last-update, and no Ditto Cloud Server row at all.
   */
  private async refreshSyncMetrics(ditto: Ditto): Promise<void> {
    try {
      const result = await ditto.store.execute('SELECT * FROM system:data_sync_info');
      const next = new Map<string, SyncStatusRow>();
      for (const item of (result as any).items) {
        const row = parseSyncStatusRow(item.value);
        if (row) { next.set(row._id, row); }
      }
      this.syncStatusByPeerKey = next;
    } catch (err) {
      this.log.warn('system:data_sync_info query failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      // Keep the previous map; cards still render from presence alone.
    }
  }

  /** Deprecated: pre-fix code attached an observer on `__sync_status`. The
   *  metrics now refresh inside the presence-flush path via refreshSyncMetrics.
   *  Kept as a noop placeholder for the connect() call site so the diff stays
   *  small; can be deleted in a follow-up. */
  private attachSyncStatusObserver(_ditto: Ditto): void {
    // Intentionally empty — see refreshSyncMetrics().
    void SYNC_STATUS_HANDLE_ID;   // retain export for compatibility
  }

  private async loadLocalPeerInfo(ditto: Ditto) {
    try {
      const result = await ditto.store.execute(
        'SELECT ditto_sdk_language, ditto_sdk_platform, ditto_sdk_version FROM __small_peer_info'
      );
      const items: any[] = (result as any).items ?? [];
      const first = items[0]?.value ?? {};
      this.localPeerInfo = {
        // peerKey is stamped by firePresence when the first presence
        // graph arrives — at construction time we don't have it yet.
        peerKey: '',
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
    // Stamp the local peer key onto localPeerInfo from the latest
    // presence graph — we don't know it at loadLocalPeerInfo time.
    // The graph webview needs this as the BFS root.
    if (this.localPeerInfo && this.latestPresence) {
      const presenceLocalKey = (this.latestPresence as any)?.localPeer?.peerKey;
      if (typeof presenceLocalKey === 'string' && presenceLocalKey) {
        this.localPeerInfo.peerKey = presenceLocalKey;
      }
    }
    if (this.latestPresence) {
      const snap = mergePeerList(
        this.latestPresence as any,
        this.syncStatusByPeerKey,
        this.localPeerInfo,
        this.previousOrder,
        this.syncState === 'active',
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
