import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Logger, LogContext, LogLevel } from '../logging/types.js';

/**
 * PeerListingPanel change detection: presence/status/sync listeners fire on a
 * 250ms coalesced beat even when nothing changed, and mergePeerList allocates
 * a fresh snapshot every time. Without a fingerprint the panel would post a
 * full peer.state to the webview 4×/s for the life of the panel.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  __resetStub(): void;
};

interface FakePanel {
  webview: { posted: unknown[] };
}

interface FakeManager {
  snapshot: unknown;
  sync: string;
  presenceCbs: (() => void)[];
}

/** Let the panel's deferred constructor work (setTimeout … 50) run. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 80));

interface RecordedLogger extends Logger { readonly warns: string[] }

function recordingLogger(): RecordedLogger {
  const warns: string[] = [];
  const self = {
    error: (_m: string, _c?: LogContext) => {},
    warn: (m: string) => { warns.push(m); },
    info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
    warns,
  } as unknown as RecordedLogger;
  return self;
}

async function showPanel(): Promise<{ panel: FakePanel; manager: FakeManager; log: RecordedLogger }> {
  stub.__resetStub();
  const { PeerListingPanel } = await import('../panels/PeerListingPanel.js');
  PeerListingPanel.dispose();
  stub.__resetStub();
  const sub = { dispose: () => {} };
  const manager: FakeManager = {
    snapshot: { local: null, remote: [] },
    sync: 'idle',
    presenceCbs: [],
  };
  const mem = new Map<string, unknown>();
  const log = recordingLogger();
  PeerListingPanel.show(
    {
      extensionUri: vscode.Uri.file('/ext'),
      subscriptions: [],
      globalState: {
        keys: () => [...mem.keys()],
        get: <T>(k: string, d?: T) => (mem.has(k) ? mem.get(k) : d) as T,
        update: (k: string, v: unknown) => { mem.set(k, v); return Promise.resolve(); },
      },
    } as never,
    {
      onPresence: (cb: () => void) => { manager.presenceCbs.push(cb); return sub; },
      onStatusChange: () => sub,
      onSyncChange: () => sub,
      getLatestSnapshot: () => manager.snapshot,
      getSyncState: () => manager.sync,
      getActiveConfigId: () => 'db-1',
      isApplyingTransports: () => false,
      toggleSync: () => Promise.resolve('active'),
    } as never,
    { get: () => ({ id: 'db-1', name: 'db' }) } as never,
    'db-1',
    { setPeers: () => Promise.resolve() } as never,
    { setActiveFeature: () => {} } as never,
    log,
  );
  await settle();
  return { panel: stub.createdWebviewPanels[0]!, manager, log };
}

function peerStatePosts(panel: FakePanel): unknown[] {
  return panel.webview.posted.filter(
    m => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'peer.state',
  );
}

test('PeerListingPanel: unchanged presence beats post nothing new', async () => {
  const { panel, manager } = await showPanel();
  assert.equal(peerStatePosts(panel).length, 1, 'initial deferred push landed');

  for (let i = 0; i < 5; i++) {
    for (const cb of manager.presenceCbs) { cb(); }
  }
  assert.equal(peerStatePosts(panel).length, 1, 'five unchanged beats skipped');
});

test('PeerListingPanel: a changed snapshot is posted on the next beat', async () => {
  const { panel, manager } = await showPanel();

  manager.snapshot = {
    local: null,
    remote: [{
      id: 'peer-1',
      isDittoServer: false,
      deviceName: 'Peer One',
      connections: [],
      syncSessionStatus: 'Connected',
    }],
  };
  for (const cb of manager.presenceCbs) { cb(); }
  assert.equal(peerStatePosts(panel).length, 2, 'content change is pushed');

  // …and the new state becomes the baseline to beat.
  for (const cb of manager.presenceCbs) { cb(); }
  assert.equal(peerStatePosts(panel).length, 2, 'unchanged repeat skipped again');
});

test('PeerListingPanel: a non-serializable snapshot skips the beat instead of wedging the panel', async () => {
  const { panel, manager, log } = await showPanel();
  assert.equal(peerStatePosts(panel).length, 1, 'initial deferred push landed');

  // A BigInt anywhere in the payload detonates JSON.stringify — previously
  // the throw escaped the listener and EVERY later beat failed the same
  // way, freezing the panel on the last good frame forever.
  manager.snapshot = {
    local: null,
    remote: [{
      id: 'peer-1', isDittoServer: false, deviceName: 'Peer One',
      connections: [], syncSessionStatus: 'Connected',
      peerMetadata: { big: 10n },
    }],
  };
  for (const cb of manager.presenceCbs) { cb(); }
  for (const cb of manager.presenceCbs) { cb(); }
  assert.equal(peerStatePosts(panel).length, 1, 'poisoned beats are skipped');
  assert.equal(
    log.warns.filter(m => m.includes('not JSON-serializable')).length, 1,
    'and the failure is logged once, not once per beat',
  );

  // Recovery: once the poisoning value is gone, the very next beat posts
  // (a payload that differs from the initial frame — the dedupe must see it).
  manager.snapshot = {
    local: null,
    remote: [{ id: 'peer-1', isDittoServer: false, deviceName: 'Peer One', connections: [], syncSessionStatus: 'Connected' }],
  };
  for (const cb of manager.presenceCbs) { cb(); }
  assert.equal(peerStatePosts(panel).length, 2, 'the panel self-heals on the next changed snapshot');
});

test('PeerListingPanel: a sync-state change alone reposts', async () => {
  const { panel, manager } = await showPanel();

  manager.sync = 'active';
  for (const cb of manager.presenceCbs) { cb(); }
  assert.equal(peerStatePosts(panel).length, 2, 'sync flip counts as a change');
});
