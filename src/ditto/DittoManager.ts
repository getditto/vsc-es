import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Ditto, DittoConfig, Authenticator } from '@dittolive/ditto';
import type { StoredDittoConfig, SecretSet, PeerSnapshot, RemotePeer } from '../models/DittoConfig.js';
import type { DatabaseStatus } from '../tree/DatabaseTreeProvider.js';

type StatusListener = (status: DatabaseStatus, configId: string | null) => void;
type PresenceListener = (snapshot: PeerSnapshot) => void;
type SyncListener = (sync: SyncState, configId: string | null) => void;
export type SyncState = 'active' | 'idle';

interface ActiveSession {
  configId: string;
  ditto: Ditto;
  presenceObserver?: { stop?: () => void };
  subscriptionHandles: Map<string, { cancel: () => void }>;
}

export class DittoManager {
  private session: ActiveSession | null = null;
  private status: DatabaseStatus = 'idle';
  private syncState: SyncState = 'idle';
  private statusListeners = new Set<StatusListener>();
  private presenceListeners = new Set<PresenceListener>();
  private syncListeners = new Set<SyncListener>();
  private latestSnapshot: PeerSnapshot = { local: null, remote: [] };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  getStatus(configId: string): DatabaseStatus {
    if (!this.session) { return 'idle'; }
    if (this.session.configId === configId) { return this.status; }
    return 'idle';
  }

  getActiveConfigId(): string | null { return this.session?.configId ?? null; }
  getLatestSnapshot(): PeerSnapshot { return this.latestSnapshot; }
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

  async connect(config: StoredDittoConfig, secrets: SecretSet): Promise<void> {
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
      const ditto = await Ditto.open(dittoCfg);

      ditto.updateTransportConfig((c: any) => {
        c.peerToPeer.bluetoothLE.isEnabled = false;
        c.peerToPeer.awdl.isEnabled = false;
        c.peerToPeer.lan.isEnabled = true;
        c.peerToPeer.lan.isMdnsEnabled = true;
        c.peerToPeer.lan.isMulticastEnabled = true;
      });

      if (config.mode === 'server' && ditto.auth.loginSupported) {
        await ditto.auth.setExpirationHandler(async (instance: any) => {
          if (instance.auth.loginSupported) {
            await instance.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
          }
        });
        const result = await ditto.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
        if ((result as any).error) { throw new Error(`Login failed: ${(result as any).error}`); }
      }

      ditto.sync.start();

      this.session = { configId: config.id, ditto, subscriptionHandles: new Map() };
      this.attachPresenceObserver(ditto);

      this.setSyncState('active', config.id);
      this.setStatus('active', config.id);
      this.output.appendLine(`Connected to "${config.name}".`);
    } catch (err) {
      this.output.appendLine(`Connect failed: ${err instanceof Error ? err.stack : String(err)}`);
      this.setStatus('error', config.id);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    if (!s) { return; }
    this.session = null;
    try {
      for (const h of s.subscriptionHandles.values()) { try { h.cancel(); } catch { /* ignore */ } }
      try { s.presenceObserver?.stop?.(); } catch { /* ignore */ }
      try { s.ditto.sync.stop(); } catch { /* ignore */ }
      try { await s.ditto.close(); } catch { /* ignore */ }
    } finally {
      this.latestSnapshot = { local: null, remote: [] };
      this.firePresence(this.latestSnapshot);
      this.setSyncState('idle', null);
      this.setStatus('idle', null);
      this.output.appendLine('Disconnected.');
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

  // ─── private ─────────────────────────────────────────────────
  private attachPresenceObserver(ditto: Ditto) {
    const presence: any = (ditto as any).presence;
    if (!presence?.observe) {
      this.output.appendLine('Presence API not available on this SDK.');
      return;
    }
    let coalesceTimer: NodeJS.Timeout | null = null;
    let pending: any = null;
    const flush = () => {
      coalesceTimer = null;
      if (pending) { this.firePresence(toSnapshot(pending)); pending = null; }
    };
    const observer = presence.observe((graph: any) => {
      pending = graph;
      if (!coalesceTimer) { coalesceTimer = setTimeout(flush, 250); }
    });
    if (this.session) { this.session.presenceObserver = observer; }
  }

  private firePresence(snapshot: PeerSnapshot) {
    this.latestSnapshot = snapshot;
    for (const l of this.presenceListeners) { l(snapshot); }
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

// ─── presence-graph adapter ────────────────────────────────────
// The exact shape from `ditto.presence.observe(...)` is verified during
// integration. This adapter narrows a best-guess shape into our
// PeerSnapshot type, falling back gracefully when fields are missing.
function toSnapshot(graph: any): PeerSnapshot {
  const local = graph?.localPeer ? {
    deviceName: graph.localPeer.deviceName ?? 'unknown',
    sdkLanguage: graph.localPeer.sdkLanguage ?? 'JS',
    sdkPlatform: graph.localPeer.platform ?? 'Node',
    sdkVersion: graph.localPeer.sdkVersion ?? 'unknown'
  } : null;

  const remoteRaw: any[] = Array.isArray(graph?.remotePeers) ? graph.remotePeers : [];
  const remote: RemotePeer[] = remoteRaw.map(r => ({
    id: String(r.peerKey ?? r.id ?? r._id ?? 'unknown'),
    deviceName: r.deviceName,
    sdkVersion: r.sdkVersion,
    os: r.os ?? r.platform ?? 'unknown',
    connections: Array.isArray(r.connections)
      ? r.connections.map((c: any) => ({ type: (c.type ?? c.kind ?? 'unknown'), address: c.address }))
      : [],
    lastUpdate: Date.now()
  }));

  return { local, remote };
}
