import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  Ditto,
  DittoConfig,
  DittoError,
  Authenticator,
  Differ,
  type Diff,
  Logger as DittoLogger,
  type LogLevel as DittoSdkLogLevel,
  type DQLQueryArguments,
  type TransportConfig,
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
import { isSelectStatement, alreadyHasProfilePrefix, isProfilableSelect } from './QueryProfileParser.js';
import { projectQueryRows } from './query-projection.js';
import { startSyncWithCollectionScopes } from './sync-scopes.js';
import { applySystemSettings, parseShowAllOptions } from './system-settings.js';
import { withConnectionPersistenceLock } from '../storage/connection-persistence-lock.js';

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
  presenceObserver?: { stop?: () => void } | undefined;
  subscriptionHandles: Map<string, { cancel: () => void }>;
  presenceCoalesceTimer?: NodeJS.Timeout | undefined;
}

/** Cap on rows shipped to an observer webview per firing. The Differ still
 *  sees the full result set (diff semantics are unchanged) — only the payload
 *  pushed over postMessage is capped, mirroring the MAX_QUERY_ROWS /
 *  DETAIL_ROW_CAP conventions used by the query paths. */
const OBSERVER_ROW_CAP = 1000;


export class DittoManager {
  private session: ActiveSession | null = null;
  private status: DatabaseStatus = 'idle';
  /** Which config `status` describes. Needed because a failed connect leaves
   *  no session to infer it from. */
  private statusConfigId: string | null = null;
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
    if (this.session?.configId === configId) { return this.status; }
    // A failed connect holds no session — the catch tears the partial one down
    // — so short-circuiting on `!this.session` made 'error' unreachable. The
    // tree derives its red icon and the `database.error` context value from
    // this, so the row fell back to the plain idle circle and the user got no
    // lasting sign that the last attempt failed.
    if (this.status === 'error' && this.statusConfigId === configId) { return 'error'; }
    return 'idle';
  }

  getActiveConfigId(): string | null { return this.session?.configId ?? null; }
  async getSystemSettingOptions(configId: string) {
    if (!this.session || this.session.configId !== configId) {
      throw new Error('Connect this database to load its current system settings.');
    }
    const result = await this.session.ditto.store.execute('SHOW ALL');
    return parseShowAllOptions(result);
  }
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
    // Hoisted outside try so the catch can release the SDK's working-directory
    // file lock if open() succeeded but a later step (activation, sync.start,
    // …) threw. Without this, the orphaned instance keeps __ditto_lock_file
    // and the next connect retries with "File already locked".
    let openedDitto: Ditto | null = null;
    try {
      const persistenceDir = path.join(this.context.globalStorageUri.fsPath, 'dittoData', config.id);
      fs.mkdirSync(persistenceDir, { recursive: true });

      const dittoCfg = new DittoConfig(
        config.databaseId,
        config.mode === 'server'
          ? { mode: 'server', url: config.authUrl }
          : {
              mode: 'smallPeersOnly' as const,
              // Shared secret for peer-to-peer encryption. SDK accepts
              // string | null; treat empty/undefined as "no shared key".
              privateKey: secrets.secretKey || null,
            },
        persistenceDir
      );

      // Apply per-DB SDK log level before opening the SDK. `config.logLevel`
      // is `SdkLogLevel` (lowercase 'warning'/'verbose'); the SDK runtime
      // expects capitalized names.
      const sdkLevelMap: Record<SdkLogLevel, DittoSdkLogLevel> = {
        error: 'Error', warning: 'Warning',
        info: 'Info', debug: 'Debug', verbose: 'Verbose',
      };
      DittoLogger.minimumLogLevel = sdkLevelMap[config.logLevel] ?? 'Info';
      this.log.info('Applied per-DB SDK log level', { configId: config.id, level: config.logLevel });

      let ditto: Ditto;
      try {
        ditto = await Ditto.open(dittoCfg);
      } catch (openErr) {
        // The SDK uses an OS-level advisory lock on `__ditto_lock_file` inside
        // the working directory; the file itself is an empty placeholder. When
        // open() reports this condition, another live process holds the kernel
        // lock — typically another VS Code window pointing at the same
        // persistence directory, or (pre-fix) an orphaned in-process instance
        // from a prior failed connect. Translate the SDK's terse error into
        // something actionable.
        //
        // Prefer the structured DittoError code (FFI `LockedDittoWorkingDirectory`
        // → `store/persistence-directory-locked`); fall back to the substring
        // match so a future native-side rephrasing of the message still hits
        // the same translation path.
        const lockedByCode =
          openErr instanceof DittoError && openErr.code === 'store/persistence-directory-locked';
        const lockedByMessage =
          openErr instanceof Error && /File already locked/i.test(openErr.message);
        if (lockedByCode || lockedByMessage) {
          throw new Error(
            `Cannot open the Ditto working directory because it is locked by another process: ${persistenceDir}\n` +
            `Another VS Code window may have this connection open, or a previous instance is still shutting down. ` +
            `Close other VS Code windows using this connection, or restart VS Code, then try again.`,
            { cause: openErr },
          );
        }
        throw openErr;
      }
      openedDitto = ditto;

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
        if (result.error) { throw new Error(`Login failed: ${result.error}`); }
      }

      // Small-peers-only mode is internally an OfflinePlayground identity and
      // refuses sync.start() until activated via setOfflineOnlyLicenseToken.
      // Mirrors SwiftUI Edge Studio's DittoManager.hydrateDittoSelectedDatabase.
      if (config.mode === 'smallPeersOnly' && secrets.token) {
        ditto.setOfflineOnlyLicenseToken(secrets.token);
      }

      const configuredScopes = config.advancedConfig?.collectionSyncScopes ?? [];
      await startSyncWithCollectionScopes(ditto, configuredScopes, async () => {
        if (configuredScopes.length > 0) {
          this.log.info('Applied collection sync scopes before sync start', {
            configId: config.id,
            count: configuredScopes.length,
          });
        }
        await ditto.store.execute(
          'ALTER SYSTEM SET DQL_STRICT_MODE TO :value',
          { value: config.isStrictModeEnabled },
        );
        await ditto.store.execute('ALTER SYSTEM SET mesh_chooser_max_wlan_clients = 12');
        this.log.info('Set mesh_chooser_max_wlan_clients to 12 to improve amount of peers connectivity.');
        const systemSettings = config.advancedConfig?.systemSettings ?? [];
        await applySystemSettings(ditto.store, systemSettings);
        if (systemSettings.length > 0) {
          this.log.info('Applied startup system settings before sync start', {
            configId: config.id,
            parameters: systemSettings.map(setting => setting.parameter),
          });
        }
      });

      this.session = {
        configId: config.id,
        ditto,
        subscriptionHandles: new Map(),
      };
      // Ownership transferred to the session; disconnect() owns close() now.
      openedDitto = null;

      this.attachPresenceObserver(ditto);
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
      // Register the active connection's secrets with the logger so its
      // redaction recognises them even where a call site logs a value
      // verbatim. Defensive: empty/undefined entries are dropped.
      this.log.registerKnownSecrets(
        [secrets.token, secrets.secretKey, secrets.httpApiKey]
          .filter((s): s is string => typeof s === 'string' && s.length > 0),
      );
      this.log.info('Connected', { name: config.name, configId: config.id, mode: config.mode });
    } catch (err) {
      this.log.error('Connect failed', { configId: config.id, err: err instanceof Error ? err.stack : String(err) });
      // If the failure happened AFTER the session was assigned (e.g. the
      // presence-observer attach threw), the session is a zombie holding a
      // live Ditto instance — tear it down so getActiveConfigId() doesn't
      // report a config whose lifecycle is 'error'.
      const partial = this.session;
      if (partial) {
        this.session = null;
        if (partial.presenceCoalesceTimer) { clearTimeout(partial.presenceCoalesceTimer); }
        for (const h of partial.subscriptionHandles.values()) { try { h.cancel(); } catch { /* ignore */ } }
        try { partial.presenceObserver?.stop?.(); } catch { /* ignore */ }
        try {
          await Promise.race([
            partial.ditto.close(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Ditto.close() timed out after 10s')), 10_000),
            ),
          ]);
        } catch { /* discard */ }
      }
      // Release the working-directory file lock left by a partially-opened
      // Ditto instance. Bounded at 10s like disconnect() — the SDK can hang
      // here when network teardown blocks, and we'd rather discard than wait.
      if (openedDitto) {
        try {
          await Promise.race([
            openedDitto.close(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Ditto.close() timed out after 10s')), 10_000),
            ),
          ]);
        } catch (closeErr) {
          this.log.warn('Ditto.close() during connect cleanup failed — discarding instance', {
            err: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
      }
      this.setStatus('error', config.id);
      // Never keep a failed connection's secrets registered for redaction —
      // the session they belonged to is gone.
      this.log.clearKnownSecrets();
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
      // Drop the previous connection's redaction set before any new one is
      // registered by the next connect.
      this.log.clearKnownSecrets();
      this.dispatch({ type: 'disconnectOk' });
      this.log.info('Disconnected');
    }
  }

  async toggleSync(): Promise<SyncState> {
    if (!this.session) { return 'idle'; }
    const session = this.session;
    const ditto = session.ditto;
    if (this.syncState === 'active') {
      // Guard like disconnect()/applyTransportConfigLocked do: sync.stop can
      // throw (e.g. SDK teardown in flight), and flipping state anyway would
      // lie to the UI.
      try {
        ditto.sync.stop();
      } catch (err) {
        this.log.warn('sync.stop() failed; sync state left as active', {
          err: err instanceof Error ? err.message : String(err),
        });
        return 'active';
      }
      this.setSyncState('idle', session.configId);
      // Force an immediate snapshot rebuild — mergePeerList's syncActive=false
      // gate will drop the cloud row this turn, instead of waiting for the
      // next presence emission (which may not arrive for a while after
      // sync.stop, and which would otherwise show a stale "Connected" cloud
      // peer until system:data_sync_info caught up).
      this.firePresence();
      return 'idle';
    }
    try {
      ditto.sync.start();
    } catch (err) {
      this.log.warn('sync.start() failed; sync state left as idle', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 'idle';
    }
    this.setSyncState('active', session.configId);
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

  /**
   * Save a fetched attachment to `destPath` WITHOUT materializing its bytes
   * in the extension-host heap: the SDK's `Attachment.copyToPath` performs a
   * native store-to-disk copy, so the whole blob never becomes a JS
   * `Uint8Array` (which `attachment.data()` + `fs.writeFile` would give you,
   * doubling peak memory for the duration of the write).
   *
   * Used by the Inspector's uncapped Download action — the user explicitly
   * asked for the file, so large attachments must be writable without heap
   * pressure on the shared extension host.
   *
   * Throws whatever the SDK throws (e.g. permission errors surface as a
   * `DittoError` whose message the caller reports).
   */
  async saveAttachmentToPath(attachment: Attachment, destPath: string): Promise<void> {
    await attachment.copyToPath(destPath);
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
      // Callers build args as Record<string, unknown> (attachment tokens,
      // arbitrary row values); the SDK's DQLQueryArguments is a recursive
      // value union `unknown` isn't assignable to. The runtime accepts any
      // JSON-shaped value, so a one-way narrowing cast is correct here.
      : await this.session.ditto.store.execute(query, args as unknown as DQLQueryArguments);
    // Dematerialize each item right after reading its value — otherwise
    // items pin themselves in native memory for the life of the result
    // (same discipline as registerStoreObserver).
    const rows: Record<string, unknown>[] = [];
    for (const item of result.items) {
      try {
        rows.push(item.value as Record<string, unknown>);
      } finally {
        try { item.dematerialize(); } catch { /* ignore */ }
      }
    }
    return rows;
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
    for (const item of result.items) {
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
    return this.session.ditto.store.newAttachment(filePath, metadata);
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

  /** Register a Ditto store observer for `query`, wrapping the SDK's
   *  `Differ` so the callback receives both the materialized rows
   *  AND the diff vs. the previous firing (insertions / updates /
   *  moves / deletions as index arrays).
   *
   *  Each call constructs its own `Differ` instance so multiple
   *  concurrent observer panels don't interfere with one another's
   *  diff state. The first firing always reports every row as an
   *  insertion (that's the SDK's documented `Differ` contract).
   *
   *  Returns a cancel handle the caller is responsible for invoking
   *  on teardown. Returns `null` if there is no active session.
   *
   *  `rows` is capped at OBSERVER_ROW_CAP per firing so a huge result set
   *  doesn't get structured-cloned to the webview on every emission;
   *  `totalRows` carries the uncapped count so the UI can say "first N of
   *  M". The Differ still runs against the FULL result set (subscription
   *  and diff semantics are unchanged) — diff indexes past the cap simply
   *  have no corresponding row in the shipped payload. */
  registerObserver(
    query: string,
    callback: (event: {
      rows: Record<string, unknown>[];
      totalRows: number;
      insertions: number[];
      updates: number[];
      deletions: number[];
      moves: Array<{ from: number; to: number }>;
    }) => void,
  ): { cancel(): void } | null {
    if (!this.session) { return null; }
    // `let` (not const): if .diff() ever throws the differ's internal
    // baseline is indeterminate — replace it with a fresh instance so
    // the next firing reports everything as insertions (matching the
    // SDK's documented "first call shows everything as inserted"
    // behaviour) instead of silently emitting wrong diffs forever.
    let differ = new Differ();
    const observer = this.session.ditto.store.registerObserver(query, (queryResult) => {
      let diff: Diff;
      try {
        diff = differ.diff(queryResult.items);
      } catch (err) {
        this.log.warn('Differ.diff threw — resetting differ and emitting empty diff', {
          query, err: err instanceof Error ? err.message : String(err),
        });
        diff = { insertions: [], deletions: [], updates: [], moves: [] };
        differ = new Differ();
      }
      const rows: Record<string, unknown>[] = [];
      let totalRows = 0;
      for (const item of queryResult.items) {
        totalRows += 1;
        if (rows.length < OBSERVER_ROW_CAP) {
          rows.push(item.value as Record<string, unknown>);
        }
        // Dematerialize EVERY item, capped or not — otherwise items pin
        // themselves in native memory for the life of the result.
        try { item.dematerialize(); } catch { /* ignore */ }
      }
      try {
        callback({
          rows,
          totalRows,
          insertions: diff.insertions,
          updates: diff.updates,
          deletions: diff.deletions,
          moves: diff.moves,
        });
      } catch (err) {
        this.log.warn('Observer callback threw', {
          query, err: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return { cancel: () => { try { observer.cancel(); } catch { /* ignore */ } } };
  }

  /** Run a one-shot DQL query against the active database. Used by QueryEditorPanel.
   *
   *  Two independent gates control collection of expensive metadata:
   *   - `collectProfiling` (default true): when true, SELECT statements
   *     are rewritten as `PROFILE <query>` and the trailing
   *     `~request_profile` envelope is popped and parsed into
   *     `metadata.profile`. When false, queries run unmodified and
   *     `metadata.profile` is undefined.
   *   - `collectMetrics` (default true): when true, a second SDK call
   *     issues `EXPLAIN <query>` and stores the result in
   *     `metadata.explain`. When false, the side-trip is skipped and
   *     `metadata.explain` is the empty string.
   *
   *  Both gates exist so a developer can opt out of either feature's
   *  per-query overhead via the workspace setting (the Query Editor's
   *  cog menu writes these settings). User-typed `PROFILE` prefixes,
   *  non-SELECT statements, and forward-incompatible SDK output all
   *  degrade gracefully: query runs as-is and the relevant metadata
   *  field is omitted.
   */
  async executeQuery(
    query: string,
    options?: { collectProfiling?: boolean; collectMetrics?: boolean },
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number; metadata: QueryResultMetadata }> {
    if (!this.session) { throw new Error('No active database.'); }

    const collectProfiling = options?.collectProfiling ?? true;
    const collectMetrics = options?.collectMetrics ?? true;

    // Two related gates:
    //   - `shouldPrefixProfile`: do WE need to inject the keyword? Only
    //     when profiling is on, the bare statement is a SELECT, and the
    //     user didn't already type PROFILE themselves (double-prefix
    //     would be a syntax error).
    //   - `expectsEnvelope`: will Ditto's response carry a profile
    //     envelope as the trailing item? True whenever profiling is on
    //     AND the statement is a SELECT — *including* the case where
    //     the user typed `PROFILE SELECT…` themselves. `isProfilableSelect`
    //     handles that by stripping any leading PROFILE before checking.
    const shouldPrefixProfile = collectProfiling
      && isSelectStatement(query)
      && !alreadyHasProfilePrefix(query);
    const expectsEnvelope = collectProfiling && isProfilableSelect(query);
    const effectiveQuery = shouldPrefixProfile ? `PROFILE ${query}` : query;

    const start = performance.now();
    const result = await this.session.ditto.store.execute(effectiveQuery);
    const durationMs = Math.round(performance.now() - start);

    // Bounded projection + profile-envelope handling live in
    // query-projection so the row cap is unit-testable without an SDK.
    const { rows, profile, totalRowCount, truncated } =
      projectQueryRows(result.items, { expectsEnvelope });

    // Capture the EXPLAIN plan as a non-fatal side-trip, gated on the
    // metrics setting. We pass the ORIGINAL (non-PROFILE-prefixed)
    // query so EXPLAIN runs against what the user typed.
    const explain = collectMetrics ? await this.runExplain(query) : '';

    const metadata: QueryResultMetadata = {
      dql: query,
      durationMs,
      resultCount: rows.length,
      explain,
      timestamp: Date.now(),
      profile,
      ...(truncated ? { truncated: true, totalResultCount: totalRowCount } : {}),
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
      const first = result.items[0]?.value;
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
   * the presence observer (Ditto stays open) → updateTransportConfig
   * with the OS-gated user prefs → readback log → persist back to ConfigStore
   * → restart sync → re-attach observers + refresh local peer info.
   *
   * On error in any phase we still attempt to restart sync + reattach observers
   * inside the finally block so the user isn't left with a stranded session.
  */
  async applyTransportConfig(opts: TransportPrefs): Promise<void> {
    await withConnectionPersistenceLock(() => this.applyTransportConfigLocked(opts));
  }

  private async applyTransportConfigLocked(opts: TransportPrefs): Promise<void> {
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
    /** The apply failure, if any. Held rather than rethrown so recovery can
     *  run first without a `finally` throw clobbering it. */
    let primaryError: unknown;
    try {
      this.log.info('Transport apply: stopping sync', { configId });
      try { ditto.sync.stop(); } catch { /* ignore — best-effort */ }

      phase = 'tearingDownObservers';
      // Tear down observers + clear derived state, but KEEP the Ditto instance.
      try { session.presenceObserver?.stop?.(); } catch { /* ignore */ }
      session.presenceObserver = undefined;
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
      // Recorded rather than rethrown here. Recovery below still has to run so
      // the user isn't left with a stranded session, and a `throw` from a
      // `finally` block REPLACES this error instead of deferring to it — which
      // is precisely the bug this shape used to have: a failing sync.start()
      // during recovery discarded the real cause and reported itself instead.
      primaryError = err;
    }

    // ── Recovery: restart sync and re-attach observers ──────────
    // Deliberately outside `finally` so the ordering above is explicit and
    // the original error always wins.
    let recoveryError: unknown;
    try {
      this.log.info('Transport apply: restarting sync', { configId });
      ditto.sync.start();
    } catch (err) {
      this.log.error('Transport apply: sync.start() failed', {
        configId, err: err instanceof Error ? err.stack : String(err),
      });
      recoveryError = err;
    }

    if (recoveryError === undefined) {
      try {
        this.attachPresenceObserver(ditto);
        await this.loadLocalPeerInfo(ditto);
        this.setSyncState('active', configId);
        this.firePresence();
        this.log.info('Transport apply: complete', { configId });
      } catch (err) {
        // Best-effort: observers can be re-attached on the next presence tick,
        // so this never masks the apply result.
        this.log.error('Transport apply: re-attach observers failed', {
          configId, err: err instanceof Error ? err.stack : String(err),
        });
      }
    }

    this.applyingTransports = false;
    // The apply failure is the cause the user needs; a recovery failure is
    // only interesting when the apply itself succeeded.
    // Rethrown verbatim rather than wrapped: callers up the stack test for
    // DittoError codes, and re-wrapping would erase both the type and the
    // SDK's stack.
    /* eslint-disable @typescript-eslint/only-throw-error */
    if (primaryError !== undefined) { throw primaryError; }
    if (recoveryError !== undefined) { throw recoveryError; }
    /* eslint-enable @typescript-eslint/only-throw-error */
  }

  /** Read each transport's `isEnabled` back from `ditto.transportConfig` and
   *  log it. Mirrors SwiftUI's `logTransportReadback` — defensive surface for
   *  SDK no-ops where update silently drops a flag. */
  private logTransportReadback(ditto: Ditto, context: string): void {
    try {
      const tc: TransportConfig = ditto.transportConfig;
      const p2p = tc.peerToPeer;
      this.log.info('Transport readback', {
        context,
        lan: p2p.lan.isEnabled,
        lanMdns: p2p.lan.isMdnsEnabled,
        lanMulticast: p2p.lan.isMulticastEnabled,
        bluetoothLE: p2p.bluetoothLE.isEnabled,
        awdl: p2p.awdl.isEnabled,
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
      // Identity check, not mere presence: during disconnect→reconnect a
      // flush in flight resumes with `this.session` being the NEW session,
      // and a truthiness guard alone would write the old DB's presence graph
      // into it.
      if (this.session?.ditto !== ditto) { return; }
      this.session.presenceCoalesceTimer = undefined;
      if (!pending) { return; }
      const graph = pending;
      pending = null;
      // Refetch sync metrics on every presence emission. Mirrors SwiftUI:
      // SystemRepository runs a one-shot SELECT * FROM system:data_sync_info
      // inside the presence callback. Cheap — the 250ms coalesce caps the
      // rate, and a failure here just degrades to presence-only data.
      await this.refreshSyncMetrics(ditto);
      // Re-check identity after the await: a disconnect could have torn the
      // session down (or replaced it) while refreshSyncMetrics was in flight.
      if (this.session?.ditto !== ditto) { return; }
      this.latestPresence = graph;
      this.firePresence();
    };
    const observer = ditto.presence.observe((graph: PresenceGraph) => {
      if (this.session?.ditto !== ditto) { return; }
      pending = graph;
      if (!this.session.presenceCoalesceTimer) {
        this.session.presenceCoalesceTimer = setTimeout(() => { void flush(); }, 250);
      }
    });
    if (this.session?.ditto === ditto) { this.session.presenceObserver = observer; }
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
      for (const item of result.items) {
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

  private async loadLocalPeerInfo(ditto: Ditto) {
    try {
      const result = await ditto.store.execute(
        'SELECT ditto_sdk_language, ditto_sdk_platform, ditto_sdk_version FROM __small_peer_info'
      );
      const items = result.items ?? [];
      const first: Record<string, unknown> = (items[0]?.value ?? {}) as Record<string, unknown>;
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
      const presenceLocalKey = this.latestPresence.localPeer?.peerKey;
      if (typeof presenceLocalKey === 'string' && presenceLocalKey) {
        this.localPeerInfo.peerKey = presenceLocalKey;
      }
    }
    if (this.latestPresence) {
      const snap = mergePeerList(
        // PresenceGraphLike (peer-info.ts) keys connections on the app's
        // models/DittoConfig ConnectionType, which lacks the SDK's newer
        // 'Multicast' variant — a one-variant widening mismatch in the type
        // defs, not a shape mismatch, so a narrow cast is appropriate here.
        this.latestPresence as unknown as Parameters<typeof mergePeerList>[0],
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
    for (const l of this.presenceListeners) { this.notify(l, this.latestSnapshot); }
  }

  /**
   * Invoke one listener, isolating its failure.
   *
   * Listeners are observers — a tree provider, a panel that may be mid-
   * disposal — and their exceptions used to propagate out of setStatus and
   * therefore out of connect(), turning an unrelated UI bug into a connection
   * failure. `setStatus('activating', …)` runs before connect's try block, so a
   * throw there escaped with no teardown at all. Matches the isolation
   * AnalyzerSink.write already applies to its own listeners.
   */
  private notify<A extends unknown[]>(listener: (...args: A) => void, ...args: A): void {
    try {
      listener(...args);
    } catch (err) {
      this.log.warn('Listener threw; continuing', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private setStatus(s: DatabaseStatus, configId: string | null) {
    this.status = s;
    this.statusConfigId = configId;
    for (const l of this.statusListeners) { this.notify(l, s, configId); }
  }

  private setSyncState(s: SyncState, configId: string | null) {
    if (this.syncState === s) { return; }
    this.syncState = s;
    for (const l of this.syncListeners) { this.notify(l, s, configId); }
  }
}
