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
  isCompatible?: boolean;
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

function makeLocalPeer(overrides: Partial<FakePresencePeer> = {}): FakePresencePeer {
  return makePeer({ peerKey: LOCAL, ...overrides });
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
    syncSessionStatus: 'Connected',
    ...overrides,
  };
}

test('mergePeerList produces empty remote[] when presence has no remote peers', () => {
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [] },
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snapshot.remote, []);
});

test('mergePeerList: presenceGraph includes multi-hop peers that remote[] filters out', () => {
  // Topology:
  //   LOCAL ─── A ─── B    (B is multi-hop: connects to A, not to LOCAL)
  // Direct list should hold {A}; presenceGraph should hold {A, B}.
  const A = makePeer({
    peerKey: 'A',
    connections: [{ id: 'c-LA', connectionType: 'AccessPoint', peer1: LOCAL, peer2: 'A' }],
  });
  const B = makePeer({
    peerKey: 'B',
    connections: [{ id: 'c-AB', connectionType: 'AccessPoint', peer1: 'A', peer2: 'B' }],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, B] },
    new Map(),
    null,
    [],
  );
  // Direct-only list: just A (B has no edge to LOCAL).
  assert.deepEqual(snapshot.remote.map(p => p.id), ['A']);
  // Full graph: both A and B.
  assert.ok(snapshot.presenceGraph);
  assert.deepEqual(
    snapshot.presenceGraph.remotePeers.map(p => p.peerKey).sort(),
    ['A', 'B'],
  );
  // Both edges present in the full graph (deduped pair-sorted by type).
  const edges = snapshot.presenceGraph.connections
    .map(c => `${[c.peer1, c.peer2].sort().join('-')}/${c.connectionType}`)
    .sort();
  // Sorted alphabetically: 'A-B/AccessPoint' < 'A-LOCAL/AccessPoint'
  // (LOCAL is the string sentinel from the test fixture).
  assert.deepEqual(edges, [
    'A-B/AccessPoint',
    `${[LOCAL, 'A'].sort().join('-')}/AccessPoint`,
  ]);
});

test('mergePeerList: presenceGraph carries the detail-card enrichment for multi-hop peers', () => {
  // The graph detail card reads presence-graph facts for peers that are NOT
  // in the merged direct list — B here is only reachable through A.
  const A = makeRemotePeer('A');
  const B = makePeer({
    peerKey: 'B',
    os: 'Android',
    dittoSdkVersion: '5.1.2',
    isConnectedToDittoServer: true,
    isCompatible: true,
    peerMetadata: { role: 'kitchen', floor: 2 },
    identityServiceMetadata: { sub: 'auth0|123' },
    connections: [{ id: 'c-AB', connectionType: 'P2PWiFi', peer1: 'A', peer2: 'B' }],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, B] },
    new Map(),
    null,
    [],
  );

  assert.deepEqual(snapshot.remote.map(p => p.id), ['A'], 'B is multi-hop only');
  const b = snapshot.presenceGraph?.remotePeers.find(p => p.peerKey === 'B');
  assert.deepEqual(b, {
    peerKey: 'B',
    deviceName: 'phone',
    os: 'Android',
    dittoSdkVersion: '5.1.2',
    isConnectedToDittoServer: true,
    isCompatible: true,
    // The card only ever renders "N keys" — bodies stay off the wire.
    peerMetadataKeyCount: 2,
    identityMetadataKeyCount: 1,
  });

  // The merged direct row now also states the cloud link, so the fallback
  // (pre-presence-graph) card can render the same Cloud row for A.
  assert.equal(snapshot.remote[0]?.isConnectedToDittoServer, false);
});

test('mergePeerList: presenceGraph counts empty metadata as 0 keys (card shows —)', () => {
  const A = makeRemotePeer('A', 'AccessPoint', {
    peerMetadata: {},
    identityServiceMetadata: {},
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A] },
    new Map(),
    null,
    [],
  );
  const a = snapshot.presenceGraph?.remotePeers.find(p => p.peerKey === 'A');
  assert.equal(a?.peerMetadataKeyCount, 0);
  assert.equal(a?.identityMetadataKeyCount, 0);
});

test('mergePeerList: malformed metadata from the SDK never throws or leaks', () => {
  // Presence metadata from remote peers crosses the napi boundary without
  // the local set-time validation. A null/non-object document must read as
  // "no metadata" — an Object.keys throw here would escape into the 250ms
  // presence flush and silently freeze every panel.
  const A = makeRemotePeer('A', 'AccessPoint', {
    peerMetadata: null as unknown as Record<string, unknown>,
    identityServiceMetadata: [] as unknown as Record<string, unknown>,
  });
  const B = makeRemotePeer('B', 'Bluetooth', {
    peerMetadata: undefined as unknown as Record<string, unknown>,
    identityServiceMetadata: { sub: 'auth0|123' },
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, B] },
    new Map(),
    null,
    [],
  );

  const a = snapshot.presenceGraph?.remotePeers.find(p => p.peerKey === 'A');
  assert.deepEqual([a?.peerMetadataKeyCount, a?.identityMetadataKeyCount], [0, 0]);

  // The direct row hardens the same way (its bodies still ship to the
  // list tab — but only genuine objects, emptied arrays never pass).
  const rowA = snapshot.remote.find(p => p.id === 'A')!;
  assert.equal(rowA.peerMetadata, undefined);
  assert.equal(rowA.identityMetadata, undefined);
  const rowB = snapshot.remote.find(p => p.id === 'B')!;
  assert.deepEqual(rowB.identityMetadata, { sub: 'auth0|123' });
});

test('mergePeerList preserves multicast edges in the full presence graph', () => {
  const multicastPeer = makePeer({
    peerKey: 'multicast-peer',
    connections: [{
      id: 'c-multicast',
      connectionType: 'Multicast',
      peer1: LOCAL,
      peer2: 'multicast-peer',
    }],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [multicastPeer] },
    new Map(),
    null,
    [],
  );

  assert.deepEqual(snapshot.presenceGraph?.connections, [{
    peer1: LOCAL,
    peer2: 'multicast-peer',
    connectionType: 'Multicast',
  }]);
  assert.deepEqual(snapshot.presenceGraph?.remotePeers, [{
    peerKey: 'multicast-peer',
    deviceName: 'phone',
    os: 'iOS',
    dittoSdkVersion: '5.0.0',
    isConnectedToDittoServer: false,
    isCompatible: undefined,
    peerMetadataKeyCount: 0,
    identityMetadataKeyCount: 0,
  }]);
});

test('mergePeerList includes edges advertised only by the local presence peer', () => {
  const localMulticast = {
    id: 'c-local-multicast',
    connectionType: 'Multicast',
    peer1: LOCAL,
    peer2: 'multicast-peer',
  };
  const snapshot = mergePeerList(
    {
      localPeer: makeLocalPeer({ connections: [localMulticast] }),
      remotePeers: [makePeer({ peerKey: 'multicast-peer' })],
    },
    new Map(),
    null,
    [],
  );

  assert.deepEqual(snapshot.presenceGraph?.connections, [{
    peer1: LOCAL,
    peer2: 'multicast-peer',
    connectionType: 'Multicast',
  }]);
  assert.deepEqual(snapshot.presenceGraph?.remotePeers, [{
    peerKey: 'multicast-peer',
    deviceName: 'phone',
    os: 'iOS',
    dittoSdkVersion: '5.0.0',
    isConnectedToDittoServer: false,
    isCompatible: undefined,
    peerMetadataKeyCount: 0,
    identityMetadataKeyCount: 0,
  }]);
});

test('mergePeerList: presenceGraph drops orphan peers (discovered but no edges) — regression for sync stop/start', () => {
  // Repro: after `ditto.sync.stop()` → `sync.start()`, the SDK
  // temporarily keeps peers in the presence graph (mDNS/BLE
  // discovery survives the toggle) but their `connections` arrays
  // are empty (sync sessions haven't re-established). The
  // unfiltered Presence Graph would render these as orphan pills
  // floating at the outermost ring with no edges — perceived as a
  // broken view.
  //
  // The filter keeps peers that appear in ANY edge in the graph
  // (so a peer reachable only via someone else's connection list
  // is still kept), and drops peers whose connections array is
  // empty AND who aren't referenced by any other peer's edges.
  const A = makePeer({
    peerKey: 'A',
    connections: [{ id: 'c-LA', connectionType: 'AccessPoint', peer1: LOCAL, peer2: 'A' }],
  });
  const orphan = makePeer({ peerKey: 'orphan', connections: [] });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, orphan] },
    new Map(),
    null,
    [],
  );
  // Direct list correctly excludes orphan (no edge to local).
  assert.deepEqual(snapshot.remote.map(p => p.id), ['A']);
  // Full graph also excludes the orphan — that's the new behaviour.
  assert.ok(snapshot.presenceGraph);
  assert.deepEqual(snapshot.presenceGraph.remotePeers.map(p => p.peerKey), ['A']);
});

test('mergePeerList: presenceGraph keeps a peer that only appears as the OTHER endpoint of someone else\'s edge', () => {
  // Topology: LOCAL ─ A ─ B, but B's own `connections` array is
  // empty (the SDK only reports the edge from A's side). B should
  // still appear in the unfiltered graph because A's connection
  // list names it as `peer2` of an edge.
  const A = makePeer({
    peerKey: 'A',
    connections: [
      { id: 'c-LA', connectionType: 'AccessPoint', peer1: LOCAL, peer2: 'A' },
      { id: 'c-AB', connectionType: 'AccessPoint', peer1: 'A',   peer2: 'B' },
    ],
  });
  const B = makePeer({ peerKey: 'B', connections: [] });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, B] },
    new Map(),
    null,
    [],
  );
  assert.ok(snapshot.presenceGraph);
  assert.deepEqual(
    snapshot.presenceGraph.remotePeers.map(p => p.peerKey).sort(),
    ['A', 'B'],
  );
});

test('mergePeerList: presenceGraph dedupes A→B and B→A of the same type', () => {
  // SDK emits both directions as separate Connection objects.
  // The full-graph view must keep them as a single edge.
  const A = makePeer({
    peerKey: 'A',
    connections: [
      { id: 'c-ab', connectionType: 'AccessPoint', peer1: 'A', peer2: 'B' },
      { id: 'c-ba', connectionType: 'AccessPoint', peer1: 'B', peer2: 'A' },
    ],
  });
  const B = makePeer({
    peerKey: 'B',
    connections: [
      { id: 'c-ba2', connectionType: 'AccessPoint', peer1: 'B', peer2: 'A' },
    ],
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [A, B] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.presenceGraph!.connections.length, 1);
});

test('each remote peer becomes a PeerInfo with id/deviceName/os/sdkVersion mapped', () => {
  const remote = makeRemotePeer('k1', 'AccessPoint', {
    deviceName: 'phone',
    os: 'Android',
    dittoSdkVersion: '4.10.0',
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [remote] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0]?.id, 'k1');
  assert.equal(snapshot.remote[0]?.deviceName, 'phone');
  assert.equal(snapshot.remote[0]?.os, 'Android');
  assert.equal(snapshot.remote[0]?.dittoSdkVersion, '4.10.0');
  // Presence-graph peer with no sync_status row defaults to 'Connected' —
  // the presence-graph fact alone is evidence the peer is connected.
  assert.equal(snapshot.remote[0]?.syncSessionStatus, 'Connected');
});

test('sync status row matched by peer key flows through; missing match defaults to Connected', () => {
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
    { localPeer: makeLocalPeer(), remotePeers: [r1, r2] },
    syncMap,
    null,
    [],
  );
  const k1 = snapshot.remote.find(p => p.id === 'k1')!;
  const k2 = snapshot.remote.find(p => p.id === 'k2')!;
  assert.equal(k1.syncSessionStatus, 'Connected');
  assert.equal(k1.syncedUpToLocalCommitId, 42);
  assert.equal(k1.lastUpdateReceivedTime, 1700000000000);
  assert.equal(k2.syncSessionStatus, 'Connected');
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
    { localPeer: makeLocalPeer(), remotePeers: [peer] },
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote[0]?.isDittoServer, true);
});

test('isDittoServer defaults to false when no sync row, even if peer.isConnectedToDittoServer is true', () => {
  // SwiftUI parity: `isConnectedToDittoServer` means the peer connects to a
  // Ditto server (true for every peer in a cloud-attached mesh) — it must NOT
  // be used as a fallback for `is_ditto_server` (which means the peer IS the server).
  const peer = makeRemotePeer('k1', 'AccessPoint', { isConnectedToDittoServer: true });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [peer] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote[0]?.isDittoServer, false);
});

test('order preservation: existing peers keep position, new peers append, absent peers drop', () => {
  // First emission: peers a, b, c.
  let snap = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [makeRemotePeer('a'), makeRemotePeer('b'), makeRemotePeer('c')] },
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snap.remote.map(p => p.id), ['a', 'b', 'c']);
  // Second emission: b drops, d appears. Expected: a, c, d.
  snap = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [makeRemotePeer('a'), makeRemotePeer('c'), makeRemotePeer('d')] },
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
  assert.equal(dominantConnectionType(makePeerInfo({ connections: [makeConnection('Multicast')] })), 'Multicast');
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
    { localPeer: makeLocalPeer(), remotePeers: [directPeer, multihopPeer] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0]?.id, 'direct');
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
    { localPeer: makeLocalPeer(), remotePeers: [peer] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0]?.connections.length, 1);
  assert.equal(snapshot.remote[0]?.connections[0]?.id, 'c-direct');
  assert.equal(snapshot.remote[0]?.connections[0]?.connectionType, 'AccessPoint');
});

test('parseSyncStatusRow coerces bigint commitId/timestamp (Node SDK quirk)', () => {
  // The Ditto Node SDK returns large DQL integers as bigint, not number.
  // A strict typeof===number check would silently drop them — that's why the
  // commitId row + last-update row used to be missing on every peer card.
  const row = parseSyncStatusRow({
    _id: 'k1',
    is_ditto_server: false,
    documents: {
      sync_session_status: 'Connected',
      synced_up_to_local_commit_id: BigInt(99999999999),
      last_update_received_time: BigInt(1700000000000),
    },
  });
  assert.equal(row?.synced_up_to_local_commit_id, 99999999999);
  assert.equal(row?.last_update_received_time, 1700000000000);
});

test('mergePeerList second pass adds Ditto Cloud Server peers from __sync_status', () => {
  // Cloud peers don't appear in the presence graph; they live only in
  // __sync_status. SwiftUI's pass 2 surfaces them; we mirror that.
  const direct = makeRemotePeer('peer-a', 'AccessPoint');
  const syncMap = new Map();
  syncMap.set('peer-a', {
    _id: 'peer-a',
    is_ditto_server: false,
    sync_session_status: 'Connected' as const,
  });
  syncMap.set('cloud-1', {
    _id: 'cloud-1',
    is_ditto_server: true,
    sync_session_status: 'Connected' as const,
    synced_up_to_local_commit_id: 12345,
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [direct] },
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 2);
  const cloud = snapshot.remote.find(p => p.id === 'cloud-1')!;
  assert.equal(cloud.isDittoServer, true);
  assert.equal(cloud.deviceName, 'Ditto Cloud Server');
  assert.deepEqual(cloud.connections, []);
  assert.equal(cloud.syncSessionStatus, 'Connected');
  assert.equal(cloud.syncedUpToLocalCommitId, 12345);
});

test('mergePeerList second pass skips cloud servers that are not actively syncing', () => {
  // A past SwiftUI bug: counting Disconnected servers in pass 2 produced
  // count=2 with 1 visible card. We're stricter — only Connected/Connecting
  // cloud rows render, so toggling sync off makes the card disappear.
  const syncMap = new Map();
  syncMap.set('cloud-disconnected', {
    _id: 'cloud-disconnected',
    is_ditto_server: true,
    sync_session_status: 'Disconnected' as const,
  });
  syncMap.set('cloud-stale', {
    _id: 'cloud-stale',
    is_ditto_server: true,
    sync_session_status: undefined,    // SDK returned "Not Connected" or junk
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [] },
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 0);
});

test('mergePeerList drops cloud peers when syncActive=false even if status says Connected', () => {
  // The SDK doesn't promptly update system:data_sync_info when sync.stop()
  // runs — the cloud row keeps reporting Connected for a while. Our
  // syncActive flag is the authoritative override.
  const syncMap = new Map();
  syncMap.set('cloud-1', {
    _id: 'cloud-1',
    is_ditto_server: true,
    sync_session_status: 'Connected' as const,
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [] },
    syncMap,
    null,
    [],
    /* syncActive */ false,
  );
  assert.equal(snapshot.remote.length, 0);
});

test('parseSyncStatusRow maps SDK "Not Connected" string to Disconnected', () => {
  // The SDK reports stopped sync as the literal "Not Connected" — a value
  // outside our SyncSessionStatus enum. Parser normalizes to Disconnected
  // so pass-2 filtering treats it identically.
  const row = parseSyncStatusRow({
    _id: 'cloud-1',
    is_ditto_server: true,
    documents: { sync_session_status: 'Not Connected' },
  });
  assert.equal(row?.sync_session_status, 'Disconnected');
});

test('mergePeerList second pass does NOT duplicate cloud peer if it appears in presence', () => {
  // If for some reason the cloud peer DID land in presence (defensive), pass 1
  // owns it; pass 2 skips by id.
  const cloudInPresence = makeRemotePeer('cloud-1', 'WebSocket');
  const syncMap = new Map();
  syncMap.set('cloud-1', {
    _id: 'cloud-1',
    is_ditto_server: true,
    sync_session_status: 'Connected' as const,
  });
  const snapshot = mergePeerList(
    { localPeer: makeLocalPeer(), remotePeers: [cloudInPresence] },
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
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
    { localPeer: makeLocalPeer(), remotePeers: [peer] },
    new Map(),
    null,
    [],
  );
  assert.equal(snapshot.remote.length, 1);
  assert.equal(snapshot.remote[0]?.connections.length, 1);
  assert.equal(snapshot.remote[0]?.connections[0]?.id, 'c-forward');
  assert.equal(snapshot.remote[0]?.connections[0]?.connectionType, 'Bluetooth');
});
