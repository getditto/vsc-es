import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePeerList,
  dominantConnectionType,
  parseSyncStatusRow,
} from '../ditto/peer-info.js';
import type { PeerInfo, ConnectionInfo } from '../models/DittoConfig.js';

const LOCAL = 'LOCAL';

interface FakePresencePeer {
  peerKey: string;
  deviceName: string;
  os?: any;
  dittoSdkVersion?: string;
  connections: Array<{ id: string; connectionType: any; peer1: string; peer2: string }>;
  peerMetadata: Record<string, unknown>;
  identityServiceMetadata: Record<string, unknown>;
  isConnectedToDittoServer: boolean;
}

function makePeer(overrides: Partial<FakePresencePeer> = {}): FakePresencePeer {
  return {
    peerKey: 'peer-' + Math.random().toString(36).slice(2),
    deviceName: 'phone',
    os: 'iOS',
    dittoSdkVersion: '5.0.0',
    connections: [],
    peerMetadata: {},
    identityServiceMetadata: {},
    isConnectedToDittoServer: false,
    ...overrides,
  };
}

/** Helper: build a remote peer that is directly connected to LOCAL via `type`. */
function makeRemotePeer(
  peerKey: string,
  type: any = 'AccessPoint',
  extraOverrides: Partial<FakePresencePeer> = {},
): FakePresencePeer {
  return makePeer({
    peerKey,
    connections: [{ id: 'c-' + peerKey, connectionType: type, peer1: LOCAL, peer2: peerKey }],
    ...extraOverrides,
  });
}

function makeLocalPeer(): FakePresencePeer {
  return makePeer({ peerKey: LOCAL });
}

function makeConnection(type: any): ConnectionInfo {
  return { id: 'c-' + type, connectionType: type, peer1: 'a', peer2: 'b' };
}

function makePeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    id: 'p1',
    isDittoServer: false,
    deviceName: 'd',
    connections: [],
    syncSessionStatus: 'Unknown',
    ...overrides,
  };
}

test('mergePeerList produces empty remote[] when presence has no remote peers', () => {
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [] } as any,
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snapshot.remote, []);
});

test('each remote peer becomes a PeerInfo with id/deviceName/os/sdkVersion mapped', () => {
  const remote = makeRemotePeer('k1', 'AccessPoint', {
    deviceName: 'phone',
    os: 'Android',
    dittoSdkVersion: '4.10.0',
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [remote] } as any,
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0].id, 'k1');
  assert.equal(snapshot.remote[0].deviceName, 'phone');
  assert.equal(snapshot.remote[0].os, 'Android');
  assert.equal(snapshot.remote[0].dittoSdkVersion, '4.10.0');
  assert.equal(snapshot.remote[0].syncSessionStatus, 'Unknown');
});

test('sync status row matched by peer key flows through; missing match defaults to Unknown', () => {
  const r1 = makeRemotePeer('k1');
  const r2 = makeRemotePeer('k2');
  const syncMap = new Map();
  syncMap.set('k1', {
    _id: 'k1',
    is_ditto_server: false,
    sync_session_status: 'Connected' as const,
    synced_up_to_local_commit_id: 42,
    last_update_received_time: 1700000000000,
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [r1, r2] } as any,
    syncMap,
    null,
    [],
  );
  const k1 = snapshot.remote.find(p => p.id === 'k1')!;
  const k2 = snapshot.remote.find(p => p.id === 'k2')!;
  assert.equal(k1.syncSessionStatus, 'Connected');
  assert.equal(k1.syncedUpToLocalCommitId, 42);
  assert.equal(k1.lastUpdateReceivedTime, 1700000000000);
  assert.equal(k2.syncSessionStatus, 'Unknown');
});

test('isDittoServer precedence: __sync_status.is_ditto_server overrides presence flag', () => {
  const peer = makeRemotePeer('k1', 'WebSocket', { isConnectedToDittoServer: false });
  const syncMap = new Map();
  syncMap.set('k1', {
    _id: 'k1',
    is_ditto_server: true,
    sync_session_status: 'Connected' as const,
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [peer] } as any,
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote[0].isDittoServer, true);
});

test('isDittoServer defaults to false when no sync row, even if peer.isConnectedToDittoServer is true', () => {
  // SwiftUI parity: `isConnectedToDittoServer` means the peer connects to a
  // Ditto server (true for every peer in a cloud-attached mesh) — it must NOT
  // be used as a fallback for `is_ditto_server` (which means the peer IS the server).
  const peer = makeRemotePeer('k1', 'AccessPoint', { isConnectedToDittoServer: true });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [peer] } as any,
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote[0].isDittoServer, false);
});

test('order preservation: existing peers keep position, new peers append, absent peers drop', () => {
  // First emission: peers a, b, c.
  let snap = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [makeRemotePeer('a'), makeRemotePeer('b'), makeRemotePeer('c')] } as any,
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snap.remote.map(p => p.id), ['a', 'b', 'c']);
  // Second emission: b drops, d appears. Expected: a, c, d.
  snap = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [makeRemotePeer('a'), makeRemotePeer('c'), makeRemotePeer('d')] } as any,
    new Map(),
    null,
    ['a', 'b', 'c'],
  );
  assert.deepEqual(snap.remote.map(p => p.id), ['a', 'c', 'd']);
});

test('dominantConnectionType priority: cloud > WebSocket > AccessPoint > P2PWiFi > Bluetooth > unknown', () => {
  assert.equal(dominantConnectionType(makePeerInfo({ isDittoServer: true, connections: [makeConnection('Bluetooth')] })), 'cloud');
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [makeConnection('Bluetooth'), makeConnection('WebSocket')] })), 'WebSocket');
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [makeConnection('Bluetooth'), makeConnection('AccessPoint')] })), 'AccessPoint');
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [makeConnection('Bluetooth'), makeConnection('P2PWiFi')] })), 'P2PWiFi');
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [makeConnection('Bluetooth')] })), 'Bluetooth');
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [] })), 'unknown');
});

test('parseSyncStatusRow handles nested documents shape and coerces last_update_received_time', () => {
  const row = parseSyncStatusRow({
    _id: 'k1',
    is_ditto_server: true,
    documents: {
      sync_session_status: 'Connected',
      synced_up_to_local_commit_id: 7,
      last_update_received_time: 1700000000000,
    },
  });
  assert.equal(row?._id, 'k1');
  assert.equal(row?.is_ditto_server, true);
  assert.equal(row?.sync_session_status, 'Connected');
  assert.equal(row?.synced_up_to_local_commit_id, 7);
  assert.equal(row?.last_update_received_time, 1700000000000);
  // Garbage shape returns null.
  assert.equal(parseSyncStatusRow({ junk: true }), null);
});

// ─── New tests: SwiftUI-parity filtering & dedupe ───────────────────

test('mergePeerList drops multihop peers (peer with no connection involving local)', () => {
  // A peer whose only connections are between two OTHER peers — i.e. multihop topology.
  // SwiftUI filters this out; presence.remotePeers includes it but it's not directly connected.
  const directPeer = makeRemotePeer('direct');
  const multihopPeer = makePeer({
    peerKey: 'multihop',
    connections: [
      { id: 'c-mh1', connectionType: 'P2PWiFi', peer1: 'other-a', peer2: 'other-b' },
      { id: 'c-mh2', connectionType: 'Bluetooth', peer1: 'other-c', peer2: 'multihop' },
    ],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [directPeer, multihopPeer] } as any,
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0].id, 'direct');
  assert.equal(snapshot.remote.find(p => p.id === 'multihop'), undefined);
});

test('mergePeerList filters out connections that don\'t involve local peer', () => {
  // One peer has 2 connections: one direct (involves LOCAL), one multihop (doesn't).
  // The peer survives (because it has at least one direct connection), but only
  // the direct connection appears on the resulting PeerInfo.
  const peer = makePeer({
    peerKey: 'k1',
    connections: [
      { id: 'c-direct', connectionType: 'AccessPoint', peer1: LOCAL, peer2: 'k1' },
      { id: 'c-multihop', connectionType: 'Bluetooth', peer1: 'other-a', peer2: 'other-b' },
    ],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [peer] } as any,
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0].connections.length, 1);
  assert.equal(snapshot.remote[0].connections[0].id, 'c-direct');
  assert.equal(snapshot.remote[0].connections[0].connectionType, 'AccessPoint');
});

test('mergePeerList deduplicates connections by type', () => {
  // The SDK reports A→B and B→A as separate Connection objects with the same
  // type but different IDs. SwiftUI keeps only the first-seen per type.
  const peer = makePeer({
    peerKey: 'k1',
    connections: [
      { id: 'c-forward', connectionType: 'Bluetooth', peer1: LOCAL, peer2: 'k1' },
      { id: 'c-reverse', connectionType: 'Bluetooth', peer1: 'k1', peer2: LOCAL },
    ],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [peer] } as any,
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0].connections.length, 1);
  assert.equal(snapshot.remote[0].connections[0].id, 'c-forward');
  assert.equal(snapshot.remote[0].connections[0].connectionType, 'Bluetooth');
});
