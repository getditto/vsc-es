# Ditto Edge Studio VS Code — POC v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "best-guess" presence-graph adapter with three real SDK data sources (presence + `__sync_status` + `__small_peer_info`), rewrite the peer-listing UI to match SwiftUI Edge Studio 1:1 (gradient backgrounds, codicons, status dots, animations), and add a DQL Query Editor panel — proving the SDK is usable for the broader project.

**Architecture:** Three coordinated changes layered on the existing extension. `DittoManager` becomes the data merger (typed `PresenceGraph` callback + DQL observer on `__sync_status` + one-shot DQL on `__small_peer_info` joined into typed `PeerInfo[]`). The peer-listing webview is rewritten to consume the new payload with SwiftUI-parity visuals via `@vscode/codicons`. A new `QueryEditorPanel` opens from a new `Query Editor` tree leaf, runs `ditto.store.execute(query)`, and renders results as a table or JSON.

**Tech Stack:** TypeScript (ESM source, CJS extension bundle), `@dittolive/ditto` 5.0.0, Lit 3, esbuild, `@vscode/codicons` (new), `node:test` + `tsx` for unit tests, VS Code Extension API ≥ 1.95.

**Reference spec:** `docs/superpowers/specs/2026-05-08-ditto-edge-studio-vsce-poc-v2-real-data.md`

**Manual testing docs:** Built incrementally in `docs/MANUAL_TESTING.md` — every task that ships user-visible functionality appends a recipe.

**Baseline:** Original POC v1 fully shipped; `npm test` reports 22 passing.

---

## Task 1: New typed models alongside legacy types

**Goal:** Introduce the typed contract (`PeerInfo`, `LocalPeerInfo`, `PeerListSnapshot`, `ConnectionInfo`, `ConnectionType`, `PeerOS`, `SyncSessionStatus`) without removing existing code paths. Pure type addition; no runtime change.

**Files:**
- Modify: `src/models/DittoConfig.ts`

- [ ] **Step 1: Read current `src/models/DittoConfig.ts`**

Before editing, read the file. The existing exports include `AuthMode`, `LogLevel`, `StoredDittoConfig`, `SecretSet`, `newConfig()`, `StoredSubscription`, `PeerSnapshot`, `LocalPeer`, `RemotePeer`. The new types coexist with the old ones for now (Task 4 will remove `PeerSnapshot`/`LocalPeer`/`RemotePeer`).

- [ ] **Step 2: Add the new types**

Append to the END of `src/models/DittoConfig.ts` (after the existing `RemotePeer` interface):

```ts
// ─── v2 typed presence model ─────────────────────────────────
// SDK 5.0 presence graph types — matches `Peer` and `Connection`
// from @dittolive/ditto/types/ditto.d.ts. The legacy `LocalPeer` /
// `RemotePeer` / `PeerSnapshot` above are scheduled for removal in
// the v2 cutover (see plan task 4).

export type PeerOSv2 = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';

export type ConnectionTypeV2 = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';

export type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected' | 'Unknown';

export interface ConnectionInfo {
  id: string;
  connectionType: ConnectionTypeV2;
  peer1: string;
  peer2: string;
}

export interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOSv2;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
}

export interface LocalPeerInfo {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}
```

(Suffixes `V2` on `PeerOS` and `ConnectionType` are temporary to avoid name collision with Ditto SDK types imported elsewhere; Task 4 renames them to `PeerOS` / `ConnectionType` after the legacy types are removed.)

- [ ] **Step 3: Verify build is clean**

Run:
```bash
npm run build
```

Expected: `[esbuild] build finished.` No type errors.

- [ ] **Step 4: Verify tests still pass**

Run:
```bash
npm test
```

Expected: 22 pass / 0 fail (no new tests yet).

- [ ] **Step 5: Commit**

```bash
git add src/models/DittoConfig.ts
git commit -m "feat(models): add v2 PeerInfo/LocalPeerInfo/PeerListSnapshot types"
```

---

## Task 2: TDD `peer-info.ts` merge logic

**Goal:** Pure-logic merge function that takes presence graph + sync status rows + local peer info and produces a `PeerListSnapshot`. Plus `dominantConnectionType` for the gradient picker. Six TDD tests.

**Files:**
- Create: `src/test/peer-info.test.ts`
- Create: `src/ditto/peer-info.ts`

- [ ] **Step 1: Write the failing tests**

Create file `src/test/peer-info.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePeerList,
  dominantConnectionType,
  parseSyncStatusRow,
} from '../ditto/peer-info.js';
import type { PeerInfo, ConnectionInfo } from '../models/DittoConfig.js';

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
    { localPeer: makePeer(), remotePeers: [] } as any,
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snapshot.remote, []);
});

test('each remote peer becomes a PeerInfo with id/deviceName/os/sdkVersion mapped', () => {
  const remote = makePeer({ peerKey: 'k1', deviceName: 'phone', os: 'Android', dittoSdkVersion: '4.10.0' });
  const snapshot = mergePeerList(
    { localPeer: makePeer(), remotePeers: [remote] } as any,
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
  const r1 = makePeer({ peerKey: 'k1' });
  const r2 = makePeer({ peerKey: 'k2' });
  const syncMap = new Map();
  syncMap.set('k1', {
    _id: 'k1',
    is_ditto_server: false,
    sync_session_status: 'Connected' as const,
    synced_up_to_local_commit_id: 42,
    last_update_received_time: 1700000000000,
  });
  const snapshot = mergePeerList(
    { localPeer: makePeer(), remotePeers: [r1, r2] } as any,
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
  const peer = makePeer({ peerKey: 'k1', isConnectedToDittoServer: false });
  const syncMap = new Map();
  syncMap.set('k1', {
    _id: 'k1',
    is_ditto_server: true,
    sync_session_status: 'Connected' as const,
  });
  const snapshot = mergePeerList(
    { localPeer: makePeer(), remotePeers: [peer] } as any,
    syncMap,
    null,
    [],
  );
  assert.equal(snapshot.remote[0].isDittoServer, true);
});

test('order preservation: existing peers keep position, new peers append, absent peers drop', () => {
  // First emission: peers a, b, c.
  let snap = mergePeerList(
    { localPeer: makePeer(), remotePeers: [makePeer({ peerKey: 'a' }), makePeer({ peerKey: 'b' }), makePeer({ peerKey: 'c' })] } as any,
    new Map(),
    null,
    [],
  );
  assert.deepEqual(snap.remote.map(p => p.id), ['a', 'b', 'c']);
  // Second emission: b drops, d appears. Expected: a, c, d.
  snap = mergePeerList(
    { localPeer: makePeer(), remotePeers: [makePeer({ peerKey: 'a' }), makePeer({ peerKey: 'c' }), makePeer({ peerKey: 'd' })] } as any,
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
```

- [ ] **Step 2: Run tests — verify failure (RED phase)**

Run:
```bash
npm test
```

Expected: tests fail with `ERR_MODULE_NOT_FOUND` for `../ditto/peer-info.js`. The existing 22 tests continue to pass.

- [ ] **Step 3: Implement `peer-info.ts`**

Create file `src/ditto/peer-info.ts`:
```ts
import type {
  ConnectionInfo,
  ConnectionTypeV2,
  PeerInfo,
  PeerListSnapshot,
  PeerOSv2,
  SyncSessionStatus,
  LocalPeerInfo,
} from '../models/DittoConfig.js';

// ─── Sync status row (parsed from __sync_status DQL emissions) ──

export interface SyncStatusRow {
  _id: string;
  is_ditto_server: boolean;
  sync_session_status: SyncSessionStatus;
  synced_up_to_local_commit_id?: number;
  last_update_received_time?: number;
}

const SYNC_SESSION_STATUSES: readonly SyncSessionStatus[] = [
  'Connected',
  'Connecting',
  'Disconnected',
  'Unknown',
];

function coerceSessionStatus(raw: unknown): SyncSessionStatus {
  if (typeof raw === 'string' && (SYNC_SESSION_STATUSES as readonly string[]).includes(raw)) {
    return raw as SyncSessionStatus;
  }
  return 'Unknown';
}

export function parseSyncStatusRow(raw: unknown): SyncStatusRow | null {
  if (!raw || typeof raw !== 'object') { return null; }
  const r = raw as Record<string, any>;
  if (typeof r._id !== 'string') { return null; }
  const docs = (r.documents && typeof r.documents === 'object') ? r.documents as Record<string, any> : {};
  return {
    _id: r._id,
    is_ditto_server: r.is_ditto_server === true,
    sync_session_status: coerceSessionStatus(docs.sync_session_status),
    synced_up_to_local_commit_id: typeof docs.synced_up_to_local_commit_id === 'number'
      ? docs.synced_up_to_local_commit_id
      : undefined,
    last_update_received_time: typeof docs.last_update_received_time === 'number'
      ? docs.last_update_received_time
      : undefined,
  };
}

// ─── Presence graph adapter ──────────────────────────────────────

interface PresencePeerLike {
  peerKey: string;
  deviceName: string;
  os?: PeerOSv2;
  dittoSdkVersion?: string;
  connections: Array<{ id: string; connectionType: ConnectionTypeV2; peer1: string; peer2: string }>;
  peerMetadata: Record<string, unknown>;
  identityServiceMetadata: Record<string, unknown>;
  isConnectedToDittoServer: boolean;
}

interface PresenceGraphLike {
  localPeer: PresencePeerLike;
  remotePeers: PresencePeerLike[];
}

function toConnections(raw: PresencePeerLike['connections']): ConnectionInfo[] {
  return raw.map(c => ({
    id: c.id,
    connectionType: c.connectionType,
    peer1: c.peer1,
    peer2: c.peer2,
  }));
}

function toPeerInfo(peer: PresencePeerLike, syncRow: SyncStatusRow | undefined): PeerInfo {
  const isDittoServer = syncRow?.is_ditto_server ?? peer.isConnectedToDittoServer;
  const peerMetadata = Object.keys(peer.peerMetadata).length > 0 ? peer.peerMetadata : undefined;
  const identityMetadata = Object.keys(peer.identityServiceMetadata).length > 0
    ? peer.identityServiceMetadata
    : undefined;
  return {
    id: peer.peerKey,
    isDittoServer,
    deviceName: peer.deviceName,
    os: peer.os,
    dittoSdkVersion: peer.dittoSdkVersion,
    peerMetadata,
    identityMetadata,
    connections: toConnections(peer.connections),
    syncSessionStatus: syncRow?.sync_session_status ?? 'Unknown',
    syncedUpToLocalCommitId: syncRow?.synced_up_to_local_commit_id,
    lastUpdateReceivedTime: syncRow?.last_update_received_time,
  };
}

export function mergePeerList(
  presence: PresenceGraphLike,
  syncStatusByPeerKey: Map<string, SyncStatusRow>,
  local: LocalPeerInfo | null,
  previousOrder: readonly string[],
): PeerListSnapshot {
  const byId = new Map<string, PeerInfo>();
  for (const peer of presence.remotePeers) {
    byId.set(peer.peerKey, toPeerInfo(peer, syncStatusByPeerKey.get(peer.peerKey)));
  }

  // Order preservation:
  // 1. previous peers still present, in original order.
  // 2. new peers (not in previousOrder) appended.
  const ordered: PeerInfo[] = [];
  for (const id of previousOrder) {
    const info = byId.get(id);
    if (info) {
      ordered.push(info);
      byId.delete(id);
    }
  }
  for (const info of byId.values()) {
    ordered.push(info);
  }

  return { local, remote: ordered };
}

// ─── Connection-type priority (drives card gradient) ─────────────

export type DominantType = 'cloud' | 'WebSocket' | 'AccessPoint' | 'P2PWiFi' | 'Bluetooth' | 'unknown';

const TYPE_PRIORITY: ConnectionTypeV2[] = ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'];

export function dominantConnectionType(peer: PeerInfo): DominantType {
  if (peer.isDittoServer) { return 'cloud'; }
  for (const t of TYPE_PRIORITY) {
    if (peer.connections.some(c => c.connectionType === t)) { return t; }
  }
  return 'unknown';
}
```

- [ ] **Step 4: Run tests — verify pass (GREEN phase)**

Run:
```bash
npm test
```

Expected: 29 pass / 0 fail (22 existing + 7 new from this task).

- [ ] **Step 5: Commit**

```bash
git add src/ditto/peer-info.ts src/test/peer-info.test.ts
git commit -m "feat(ditto): TDD merge logic for v2 peer-info snapshot"
```

---

## Task 3: Codicons asset pipeline

**Goal:** Bring `@vscode/codicons` into the build so webview bundles can use VS Code-native icons. Asset copy step, no UI change yet.

**Files:**
- Modify: `package.json`
- Modify: `esbuild.config.mjs`

- [ ] **Step 1: Install `@vscode/codicons`**

Run:
```bash
npm install --save-dev @vscode/codicons
```

Expected: `@vscode/codicons` added to `devDependencies`. The package contains `dist/codicon.css` and `dist/codicon.ttf`.

Verify:
```bash
ls node_modules/@vscode/codicons/dist/codicon.*
```

Expected output includes `codicon.css` and `codicon.ttf`.

- [ ] **Step 2: Update `esbuild.config.mjs` to copy codicon assets**

Read the current `esbuild.config.mjs`. After the existing `dist/package.json` writer block (the line `fs.writeFileSync(path.join(distDir, 'package.json'), '{"type":"commonjs"}\n');`), insert:

```js
// Copy @vscode/codicons assets to dist/webview-ui/ for webview consumption.
const codiconSrc = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
const webviewUiDir = path.join(distDir, 'webview-ui');
fs.mkdirSync(webviewUiDir, { recursive: true });
fs.copyFileSync(path.join(codiconSrc, 'codicon.css'), path.join(webviewUiDir, 'codicon.css'));
fs.copyFileSync(path.join(codiconSrc, 'codicon.ttf'), path.join(webviewUiDir, 'codicon.ttf'));
```

Place this BEFORE the `if (watch) { ... } else { ... }` block. The copy runs unconditionally each build (watch and one-shot).

- [ ] **Step 3: Verify build**

Run:
```bash
npm run build
ls dist/webview-ui/codicon.*
```

Expected:
```
dist/webview-ui/codicon.css
dist/webview-ui/codicon.ttf
```

The .css file references `./codicon.ttf` via `@font-face` — relative paths resolve correctly inside the webview.

- [ ] **Step 4: Verify tests still pass**

Run:
```bash
npm test
```

Expected: 29 pass / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json esbuild.config.mjs
git commit -m "build(codicons): copy @vscode/codicons font + css to dist/webview-ui"
```

---

## Task 4: DittoManager — three real SDK sources + IPC cutover

**Goal:** Wire `presence.observe` (typed), `__sync_status` (DQL subscription + observer), and `__small_peer_info` (one-shot DQL execute) into `DittoManager`. Drop `(any)` casts. Update IPC `PeerOut` to carry the new `PeerListSnapshot`. Update `PeerListingPanel` to push the new state. Replace the peer-listing webview with a temporary JSON-dump stub (Task 5 ships the real UI). Remove legacy `LocalPeer`/`RemotePeer`/`PeerSnapshot` types and rename `PeerOSv2`/`ConnectionTypeV2` to `PeerOS`/`ConnectionType`.

**Files:**
- Modify: `src/ditto/DittoManager.ts`
- Modify: `src/ipc/messages.ts`
- Modify: `src/panels/PeerListingPanel.ts`
- Modify: `src/models/DittoConfig.ts`
- Modify: `webview-ui/peers/peers-element.ts` (temporary JSON-dump stub)

- [ ] **Step 1: Rename `PeerOSv2` → `PeerOS`, `ConnectionTypeV2` → `ConnectionType`; remove legacy types**

Open `src/models/DittoConfig.ts`. Replace the entire file with:

```ts
export type AuthMode = 'server' | 'smallPeersOnly';
export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';

export interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: AuthMode;
  authUrl: string;
  websocketUrl: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: LogLevel;
  isStrictModeEnabled: boolean;
}

export interface SecretSet {
  token: string;
  secretKey?: string;
  httpApiKey?: string;
}

export function newConfig(): StoredDittoConfig {
  return {
    id: '',
    name: '',
    databaseId: '',
    mode: 'server',
    authUrl: '',
    websocketUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false
  };
}

export interface StoredSubscription {
  id: string;
  name: string;
  query: string;
}

// ─── v2 typed presence model ─────────────────────────────────

export type PeerOS = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';

export type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';

export type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected' | 'Unknown';

export interface ConnectionInfo {
  id: string;
  connectionType: ConnectionType;
  peer1: string;
  peer2: string;
}

export interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOS;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
}

export interface LocalPeerInfo {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}
```

- [ ] **Step 2: Update `peer-info.ts` import names**

Edit `src/ditto/peer-info.ts`. Change the import from `'../models/DittoConfig.js'` from:
```ts
import type {
  ConnectionInfo,
  ConnectionTypeV2,
  PeerInfo,
  PeerListSnapshot,
  PeerOSv2,
  SyncSessionStatus,
  LocalPeerInfo,
} from '../models/DittoConfig.js';
```
to:
```ts
import type {
  ConnectionInfo,
  ConnectionType,
  PeerInfo,
  PeerListSnapshot,
  PeerOS,
  SyncSessionStatus,
  LocalPeerInfo,
} from '../models/DittoConfig.js';
```

Then update `PeerOSv2` → `PeerOS` and `ConnectionTypeV2` → `ConnectionType` everywhere in the file (4 occurrences total: 2 in `PresencePeerLike` interface, 1 in `TYPE_PRIORITY`, 1 in `DominantType`'s type union — verify with grep).

Run:
```bash
grep -n 'OSv2\|TypeV2' src/ditto/peer-info.ts
```

Expected: no matches after edit.

- [ ] **Step 3: Update `peer-info.test.ts` import**

Edit `src/test/peer-info.test.ts`. The current import is correct (`ConnectionInfo` from `../models/DittoConfig.js`); no change needed. Verify by running:

```bash
npm test 2>&1 | grep -E "(pass|fail)"
```

Expected: 29 pass / 0 fail. (If anything fails, look at the import name change in step 2.)

- [ ] **Step 4: Update `src/ipc/messages.ts`**

Replace the entire file with:
```ts
import type {
  StoredDittoConfig,
  SecretSet,
  PeerListSnapshot,
} from '../models/DittoConfig.js';

// ─── Database editor panel ─────────────────────────────────────
export type EditorIn =
  | { type: 'editor.save'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.cancel' };

export type EditorOut =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.validationError'; message: string };

// ─── Subscription editor panel ─────────────────────────────────
export type SubIn =
  | { type: 'sub.save'; id?: string; name: string; query: string }
  | { type: 'sub.cancel' };

export type SubOut =
  | { type: 'sub.init'; id?: string; name: string; query: string };

// ─── Peer listing panel ────────────────────────────────────────
export type PeerIn =
  | { type: 'peer.toggleSync' };

export type PeerOut =
  | { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };
```

(The previous version imported `PeerSnapshot` and `StoredSubscription`. `PeerSnapshot` is gone; `StoredSubscription` is unused in IPC and the import is dropped.)

- [ ] **Step 5: Replace `src/ditto/DittoManager.ts`**

Replace the ENTIRE file with the v2 implementation:

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  Ditto,
  DittoConfig,
  Authenticator,
  type Peer as SdkPeer,
  type PresenceGraph,
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

  async connect(
    config: StoredDittoConfig,
    secrets: SecretSet,
    initialSubs: StoredSubscription[] = []
  ): Promise<void> {
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
          this.output.appendLine(`Failed to register subscription "${sub.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.setSyncState('active', config.id);
      this.setStatus('active', config.id);
      this.firePresence();
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

  /** Run a one-shot DQL query against the active database. Used by QueryEditorPanel. */
  async executeQuery(query: string): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    if (!this.session) { throw new Error('No active database.'); }
    const start = performance.now();
    const result = await this.session.ditto.store.execute(query);
    const rows = (result as any).items.map((i: any) => i.value as Record<string, unknown>);
    const durationMs = Math.round(performance.now() - start);
    return { rows, durationMs };
  }

  // ─── private ─────────────────────────────────────────────────

  private attachPresenceObserver(ditto: Ditto) {
    let coalesceTimer: NodeJS.Timeout | null = null;
    let pending: PresenceGraph | null = null;
    const flush = () => {
      coalesceTimer = null;
      if (pending) {
        this.latestPresence = pending;
        pending = null;
        this.firePresence();
      }
    };
    const observer = ditto.presence.observe((graph: PresenceGraph) => {
      pending = graph;
      if (!coalesceTimer) { coalesceTimer = setTimeout(flush, 250); }
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
      this.output.appendLine(`__sync_status subscription failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const obs = ditto.store.registerObserver(query, (result: any) => {
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
      this.output.appendLine(`__sync_status observer failed: ${err instanceof Error ? err.message : String(err)}`);
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
      this.output.appendLine(`__small_peer_info query failed: ${err instanceof Error ? err.message : String(err)}`);
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
```

(Note: the legacy `toSnapshot` adapter and `RemotePeer` import are gone. The `(any)` casts on `c.peerToPeer.*` in `updateTransportConfig` are dropped — the SDK types accept the typed callback. Some `as any` casts remain on SDK return values where the SDK's TypeScript types lag the runtime; these are isolated to `result as any` boundaries. The `_ peer` parameter is unused — that's fine, removed; reading `SdkPeer` type is also unused but kept as documentation.)

Remove the unused `SdkPeer` import (if TS errors complain) — only `Peer` and `Connection` in `peer-info.ts` are needed. Confirm with `grep SdkPeer src/ditto/DittoManager.ts` — if no usage, drop the import line.

- [ ] **Step 6: Replace `webview-ui/peers/peers-element.ts` with a temporary JSON-dump stub**

This is intentional: Task 5 ships the real UI. For now the cards must render *something* for the build to compile cleanly and for manual smoke-testing.

Replace `webview-ui/peers/peers-element.ts` with:

```ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface ConnectionInfo {
  id: string; connectionType: string; peer1: string; peer2: string;
}
interface PeerInfo {
  id: string; isDittoServer: boolean; deviceName: string; os?: string; dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>; identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[]; syncSessionStatus: string;
  syncedUpToLocalCommitId?: number; lastUpdateReceivedTime?: number;
}
interface LocalPeerInfo {
  deviceName: string; sdkLanguage: string; sdkPlatform: string; sdkVersion: string;
}
interface PeerListSnapshot { local: LocalPeerInfo | null; remote: PeerInfo[]; }
type In = { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerListSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';

  static styles = css`
    :host { display: block; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }
    button { padding: 4px 10px; font: inherit; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; }
    pre { background: var(--vscode-editor-background); padding: 12px; border-radius: 6px; overflow: auto; max-height: 70vh; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') { this.snapshot = msg.snapshot; this.sync = msg.sync; }
    });
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  render() {
    return html`
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex:1"></span>
        <button @click=${this.toggleSync}>${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}</button>
      </div>
      <p style="color: var(--vscode-descriptionForeground); margin: 8px 0;">
        Real-data preview (UI rewrite ships next):
      </p>
      <pre>${JSON.stringify(this.snapshot, null, 2)}</pre>
    `;
  }
}
```

- [ ] **Step 7: Verify build & tests**

Run:
```bash
npm run build
npm test
```

Expected: build succeeds; tests 29/29.

- [ ] **Step 8: Commit**

```bash
git add src/ditto/DittoManager.ts src/ditto/peer-info.ts src/ipc/messages.ts src/models/DittoConfig.ts src/test/peer-info.test.ts webview-ui/peers/peers-element.ts
git commit -m "feat(ditto): wire real presence + __sync_status + __small_peer_info; cut over IPC"
```

> The peer listing visually shows JSON for now. Full UI rewrite is the next task.

---

## Task 5: Peer Listing UI rewrite — full SwiftUI parity

**Goal:** Replace the JSON-dump stub with the real card grid: gradient backgrounds keyed off dominant connection type, codicon-iconed rows, status indicator dots, connection badges, collapsible metadata, animations, double-click-to-copy peer IDs, real "last update" relative-time formatting, no truncation glitches.

**Files:**
- Modify: `webview-ui/peers/peers-element.ts`
- Modify: `webview-ui/peers/main.ts` (no change — still imports `./peers-element.js`)

- [ ] **Step 1: Replace `webview-ui/peers/peers-element.ts` with the full UI**

Replace the entire file with:

```ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

// ─── Types (mirror src/models/DittoConfig.ts; can't import from ext host) ──

type PeerOS = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';
type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';
type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected' | 'Unknown';

interface ConnectionInfo {
  id: string;
  connectionType: ConnectionType;
  peer1: string;
  peer2: string;
}

interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOS;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
}

interface LocalPeerInfo {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}

type In = { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };

// ─── Visual mappings ─────────────────────────────────────────────

type DominantType = 'cloud' | 'WebSocket' | 'AccessPoint' | 'P2PWiFi' | 'Bluetooth' | 'unknown';

const GRADIENTS: Record<DominantType, [string, string]> = {
  cloud:       ['rgb(115, 38, 184)', 'rgb(71, 18, 122)'],
  WebSocket:   ['rgb(217, 122, 0)',  'rgb(153, 77, 0)'],
  AccessPoint: ['rgb(13, 133, 64)',  'rgb(5, 82, 36)'],
  P2PWiFi:     ['rgb(199, 26, 56)',  'rgb(128, 10, 31)'],
  Bluetooth:   ['rgb(0, 102, 217)',  'rgb(0, 51, 153)'],
  unknown:     ['rgb(89, 89, 102)',  'rgb(51, 51, 64)'],
};

const LOCAL_GRADIENT: [string, string] = ['rgb(20, 20, 20)', 'rgb(0, 0, 0)'];

function dominantType(peer: PeerInfo): DominantType {
  if (peer.isDittoServer) { return 'cloud'; }
  for (const t of ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'] as const) {
    if (peer.connections.some(c => c.connectionType === t)) { return t; }
  }
  return 'unknown';
}

function osIcon(os: PeerOS | undefined): string {
  switch (os) {
    case 'iOS': case 'macOS': case 'Generic': return 'codicon-device-mobile';
    case 'Android': return 'codicon-device-mobile';
    case 'Windows': case 'Linux': case 'tvOS': return 'codicon-terminal';
    default: return 'codicon-question';
  }
}

function osDisplay(os: PeerOS | undefined): string {
  return os ?? 'Unknown';
}

function connectionIcon(type: ConnectionType): string {
  switch (type) {
    case 'Bluetooth': return 'codicon-radio-tower';
    case 'AccessPoint': return 'codicon-broadcast';
    case 'P2PWiFi': return 'codicon-circuit-board';
    case 'WebSocket': return 'codicon-cloud';
  }
}

function connectionDisplay(type: ConnectionType): string {
  switch (type) {
    case 'Bluetooth': return 'Bluetooth';
    case 'AccessPoint': return 'WiFi AP';
    case 'P2PWiFi': return 'P2P WiFi';
    case 'WebSocket': return 'WebSocket';
  }
}

function statusDotColor(status: SyncSessionStatus): string {
  switch (status) {
    case 'Connected': return 'var(--vscode-charts-green)';
    case 'Connecting': return 'var(--vscode-charts-orange)';
    case 'Disconnected': return 'var(--vscode-charts-red)';
    default: return 'var(--vscode-descriptionForeground)';
  }
}

function formatLastUpdate(ms: number | undefined): string {
  if (!ms) { return 'Never'; }
  const now = Date.now();
  const delta = now - ms;
  if (delta < 60_000) { return 'just now'; }
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerListSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';
  @state() private tab: 'list' | 'graph' = 'list';
  @state() private copiedId: string | null = null;
  @state() private nowTick = 0;

  private tickInterval: number | null = null;

  static styles = css`
    @import url('./codicon.css');

    :host {
      display: block;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }

    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }

    .toolbar-button {
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }

    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tabs button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
    }
    .tabs button.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
    }

    .card {
      min-height: 280px;
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 3px 6px rgba(0, 0, 0, 0.25);
      color: white;
      display: flex;
      flex-direction: column;
      animation: card-in 350ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes card-in {
      from { transform: scale(0.88); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .card-title-block {
      min-width: 0;
      flex: 1;
    }

    .card-name {
      font-size: 15px;
      font-weight: 600;
      margin: 0 0 4px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-os, .card-row {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.85);
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 4px 0;
    }
    .card-os .codicon, .card-row .codicon {
      font-size: 12px;
    }

    .card-id {
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      color: rgba(255, 255, 255, 0.80);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      margin-top: 4px;
    }
    .card-id.copied {
      color: var(--vscode-charts-green);
    }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      flex-shrink: 0;
    }
    .status .dot {
      width: 8px;
      height: 8px;
    }

    .divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.25);
      margin: 12px 0;
    }

    .card-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }

    .badges {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .badge {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.20);
      border-radius: 6px;
      font-size: 12px;
    }

    details summary {
      cursor: pointer;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.85);
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary::before {
      content: '\\25B6';
      font-size: 9px;
      transition: transform 150ms;
    }
    details[open] summary::before {
      transform: rotate(90deg);
    }
    details pre {
      margin: 6px 0 0 0;
      padding: 8px;
      background: rgba(0, 0, 0, 0.25);
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      color: rgba(255, 255, 255, 0.85);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow: auto;
    }

    .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 32px;
      text-align: center;
    }

    .placeholder {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
    }

    /* Local Peer card layout — same shell, different gradient applied inline */
    .local-card .card-name { font-size: 14px; }
    .local-card .card-row .label { color: rgba(255,255,255,0.70); flex: 1; }
    .local-card .card-row .value { color: white; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') { this.snapshot = msg.snapshot; this.sync = msg.sync; }
    });
    this.tickInterval = window.setInterval(() => { this.nowTick++; }, 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.tickInterval !== null) { window.clearInterval(this.tickInterval); }
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  private async copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      this.copiedId = id;
      setTimeout(() => { if (this.copiedId === id) { this.copiedId = null; } }, 1500);
    } catch { /* clipboard may be unavailable; silently fail */ }
  }

  render() {
    return html`
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex: 1"></span>
        <button class="toolbar-button" @click=${this.toggleSync}>
          ${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}
        </button>
      </div>

      <div class="tabs" role="tablist">
        <button class=${this.tab === 'list' ? 'active' : ''} @click=${() => this.tab = 'list'}>Connected Peers</button>
        <button class=${this.tab === 'graph' ? 'active' : ''} @click=${() => this.tab = 'graph'}>Presence Graph</button>
      </div>

      ${this.tab === 'list' ? this.renderList() : this.renderGraphPlaceholder()}
    `;
  }

  private renderList() {
    const { local, remote } = this.snapshot;
    if (!local && remote.length === 0) {
      return html`<div class="empty">No sync status available. Connect to see peers.</div>`;
    }
    return html`
      <div class="grid">
        ${local ? this.renderLocalCard(local) : nothing}
        ${remote.map(p => this.renderRemoteCard(p))}
      </div>
    `;
  }

  private renderLocalCard(local: LocalPeerInfo) {
    const [start, end] = LOCAL_GRADIENT;
    const style = `background: linear-gradient(135deg, ${start}, ${end});`;
    return html`
      <div class="card local-card" style=${style}>
        <div class="card-header">
          <div class="card-title-block">
            <div class="card-row"><i class="codicon codicon-globe"></i><span>Local Peer</span></div>
            <h3 class="card-name" title=${local.deviceName}>${local.deviceName || '(unnamed)'}</h3>
          </div>
        </div>
        <div class="divider"></div>
        <div class="card-body">
          <div class="card-row"><span class="label">Device Name</span><span class="value">${local.deviceName}</span></div>
          <div class="card-row"><span class="label">SDK Language</span><span class="value">${local.sdkLanguage || '—'}</span></div>
          <div class="card-row"><span class="label">SDK Platform</span><span class="value">${local.sdkPlatform || '—'}</span></div>
          <div class="card-row"><span class="label">SDK Version</span><span class="value">${local.sdkVersion || '—'}</span></div>
        </div>
      </div>
    `;
  }

  private renderRemoteCard(peer: PeerInfo) {
    const dt = dominantType(peer);
    const [start, end] = GRADIENTS[dt];
    const style = `background: linear-gradient(135deg, ${start}, ${end});`;
    const idCopied = this.copiedId === peer.id;
    const idDisplay = peer.id.length > 32 ? peer.id.slice(0, 32) + '…' : peer.id;
    void this.nowTick; // re-read nowTick so relative-time refreshes every 30s
    return html`
      <div class="card" style=${style}>
        <div class="card-header">
          <div class="card-title-block">
            <h3 class="card-name" title=${peer.deviceName}>${peer.deviceName || '(unnamed)'}</h3>
            <div class="card-os">
              <i class="codicon ${osIcon(peer.os)}"></i>
              <span>${osDisplay(peer.os)}</span>
            </div>
            <div class="card-id ${idCopied ? 'copied' : ''}"
                 title="Double-click to copy: ${peer.id}"
                 @dblclick=${() => this.copyId(peer.id)}>
              ${idDisplay}
            </div>
          </div>
          <div class="status">
            <div class="dot" style="background: ${statusDotColor(peer.syncSessionStatus)}"></div>
            <span>${peer.syncSessionStatus}</span>
          </div>
        </div>

        <div class="divider"></div>

        <div class="card-body">
          ${peer.dittoSdkVersion ? html`
            <div class="card-row">
              <i class="codicon codicon-package"></i>
              <span>Ditto SDK: ${peer.dittoSdkVersion}</span>
            </div>
          ` : nothing}

          ${peer.identityMetadata ? html`
            <details>
              <summary><i class="codicon codicon-info"></i><span>Identity Metadata</span></summary>
              <pre>${JSON.stringify(peer.identityMetadata, null, 2)}</pre>
            </details>
          ` : nothing}

          ${peer.peerMetadata ? html`
            <details>
              <summary><i class="codicon codicon-info"></i><span>Peer Metadata</span></summary>
              <pre>${JSON.stringify(peer.peerMetadata, null, 2)}</pre>
            </details>
          ` : nothing}

          ${peer.connections.length > 0 ? html`
            <div class="card-row">
              <i class="codicon codicon-link"></i>
              <span>Active Connections (${peer.connections.length})</span>
            </div>
            <div class="badges">
              ${peer.connections.map(c => html`
                <div class="badge">
                  <i class="codicon ${connectionIcon(c.connectionType)}"></i>
                  <span>${connectionDisplay(c.connectionType)}</span>
                </div>
              `)}
            </div>
          ` : nothing}

          ${peer.syncedUpToLocalCommitId !== undefined ? html`
            <div class="card-row">
              <i class="codicon codicon-check"></i>
              <span>Synced to commit: ${peer.syncedUpToLocalCommitId}</span>
            </div>
          ` : nothing}

          <div class="card-row">
            <i class="codicon codicon-clock"></i>
            <span>Last update: ${formatLastUpdate(peer.lastUpdateReceivedTime)}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderGraphPlaceholder() {
    return html`<div class="placeholder">Presence Graph — coming soon.<br><br>The force-directed network visualization is planned for a future release.</div>`;
  }
}
```

- [ ] **Step 2: Build**

Run:
```bash
npm run build
```

Expected: build succeeds. `dist/webview-ui/peers.js` is now larger than before (codicons CSS gets imported).

Verify codicon assets are alongside:
```bash
ls dist/webview-ui/codicon.{ttf,css} dist/webview-ui/peers.js
```

Expected: all three files present.

- [ ] **Step 3: Verify tests**

Run:
```bash
npm test
```

Expected: 29/29.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/peers/peers-element.ts
git commit -m "feat(peers): SwiftUI-parity card grid with codicons, gradients, animations"
```

> Manual F5 verification (T9 recipe in Task 9) requires another peer to actually exercise the visual.

---

## Task 6: Add Query Editor tree leaf + open command

**Goal:** Extend the tree to show a `Query Editor` leaf under each active database. Click → fires `dittoVsce.openQueryEditor` with the database id. Panel host stub for now (real panel in next task).

**Files:**
- Modify: `src/tree/DatabaseTreeItem.ts`
- Modify: `src/tree/DatabaseTreeProvider.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Extend the discriminated union**

Replace `src/tree/DatabaseTreeItem.ts` entirely with:

```ts
import type { StoredDittoConfig, StoredSubscription } from '../models/DittoConfig.js';

export type DatabaseTreeNode =
  | { kind: 'database'; config: StoredDittoConfig; status: 'idle' | 'activating' | 'active' | 'error' }
  | { kind: 'subscriptionsParent'; databaseId: string }
  | { kind: 'subscription'; databaseId: string; sub: StoredSubscription }
  | { kind: 'peerListing'; databaseId: string }
  | { kind: 'queryEditor'; databaseId: string };
```

- [ ] **Step 2: Update tree provider to render the leaf**

Open `src/tree/DatabaseTreeProvider.ts`. Find the `getNodeChildren` method's `database` branch — currently returns `[subscriptionsParent, peerListing]`. Replace with three children:

```ts
  async getNodeChildren(node: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    if (node.kind === 'database') {
      if (node.status !== 'active') { return []; }
      return [
        { kind: 'subscriptionsParent', databaseId: node.config.id },
        { kind: 'peerListing', databaseId: node.config.id },
        { kind: 'queryEditor', databaseId: node.config.id },
      ];
    }
    // ... rest unchanged
```

In the same file, find the `getTreeItem` switch. Add a new case for `queryEditor` before the closing brace of the switch:

```ts
      case 'queryEditor': {
        const item = new vscode.TreeItem('Query Editor');
        item.iconPath = new vscode.ThemeIcon('terminal');
        item.contextValue = 'queryEditor';
        item.id = `query.${node.databaseId}`;
        item.command = { command: 'dittoVsce.openQueryEditor', title: 'Open Query Editor', arguments: [node.databaseId] };
        return item;
      }
```

- [ ] **Step 3: Update existing tree-provider test to expect 3 children for an active database**

Open `src/test/DatabaseTreeProvider.test.ts`. Find the test:
```ts
test('active database has Subscriptions parent and Peer Listing as children', async () => {
```

Replace its body's assertions. The current test asserts `children.length === 2` and checks `[0].kind === 'subscriptionsParent'`, `[1].kind === 'peerListing'`. Update to:

```ts
test('active database has Subscriptions parent, Peer Listing, and Query Editor as children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', emptySubs());
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.equal(children.length, 3);
  assert.equal(children[0].kind, 'subscriptionsParent');
  assert.equal(children[1].kind, 'peerListing');
  assert.equal(children[2].kind, 'queryEditor');
});
```

(The test name changed; that's intentional.)

- [ ] **Step 4: Add `openQueryEditor` command to `package.json`**

In `package.json`, find the `contributes.commands` array. Add a new entry (after the existing `dittoVsce.editSubscription`):
```json
{ "command": "dittoVsce.openQueryEditor", "title": "Open Query Editor" }
```

(No menu binding — the command fires from the tree leaf click.)

- [ ] **Step 5: Wire stub command in `src/extension.ts`**

Find the existing `vscode.commands.registerCommand('dittoVsce.openPeerListing', ...)` block. After it (still inside the `context.subscriptions.push(...)` call), add:

```ts
vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
  if (!databaseId) { return; }
  vscode.window.showInformationMessage('Query Editor — not implemented yet (Task 7).');
}),
```

(Task 7 replaces the toast with the real panel.)

- [ ] **Step 6: Run tests + build**

```bash
npm test
npm run build
```

Expected: 29/29 tests, build succeeds. (No new tests — the existing tree test is updated.)

- [ ] **Step 7: Commit**

```bash
git add src/tree/DatabaseTreeItem.ts src/tree/DatabaseTreeProvider.ts src/test/DatabaseTreeProvider.test.ts src/extension.ts package.json
git commit -m "feat(tree): add Query Editor leaf and openQueryEditor command stub"
```

---

## Task 7: QueryEditorPanel host (extension-host side)

**Goal:** Singleton webview panel host. Replaces the Task 6 toast with a real panel that opens `Query — <db>`, sends `query.run` IPC to the host, runs `manager.executeQuery(query)`, posts `query.result` or `query.error`. Webview UI in next task.

**Files:**
- Create: `src/panels/QueryEditorPanel.ts`
- Modify: `src/ipc/messages.ts`
- Modify: `src/extension.ts`
- Modify: `esbuild.config.mjs` (add `query` webview entry)
- Create: `webview-ui/query/main.ts` (placeholder bundle)

- [ ] **Step 1: Add IPC types**

Open `src/ipc/messages.ts`. After the `PeerOut` type, append:

```ts
// ─── Query editor panel ────────────────────────────────────────
export type QueryIn =
  | { type: 'query.run'; query: string };

export type QueryOut =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number }
  | { type: 'query.error'; message: string };
```

- [ ] **Step 2: Create the placeholder webview entry**

Create file `webview-ui/query/main.ts`:
```ts
// Stub — real UI implemented in Task 8.
const root = document.getElementById('root');
if (root) { root.textContent = 'Query Editor — UI under construction.'; }
```

- [ ] **Step 3: Update `esbuild.config.mjs` to bundle the new entry**

Open `esbuild.config.mjs`. Find the `webviewCtx = await esbuild.context({ entryPoints: { editor: ..., subscription: ..., peers: ... }, ... })` block. Add `query` to `entryPoints`:

```js
  entryPoints: {
    editor: 'webview-ui/editor/main.ts',
    subscription: 'webview-ui/subscription/main.ts',
    peers: 'webview-ui/peers/main.ts',
    query: 'webview-ui/query/main.ts',
  },
```

- [ ] **Step 4: Create `src/panels/QueryEditorPanel.ts`**

```ts
import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { QueryIn, QueryOut } from '../ipc/messages.js';

function computeColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) { keys.add(k); }
  }
  const all = Array.from(keys);
  const hasId = keys.has('_id');
  const sorted = all.filter(k => k !== '_id').sort();
  return hasId ? ['_id', ...sorted] : sorted;
}

export class QueryEditorPanel {
  private static current: QueryEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    configs: ConfigStore,
    databaseId: string
  ) {
    if (QueryEditorPanel.current) {
      QueryEditorPanel.current.panel.reveal();
      QueryEditorPanel.current.refreshTitle(databaseId, configs);
      return;
    }
    QueryEditorPanel.current = new QueryEditorPanel(context, manager, configs, databaseId);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly configs: ConfigStore,
    databaseId: string
  ) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoQueryEditor',
      `Query — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'query.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Query Editor',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.onDidReceiveMessage((msg: QueryIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private refreshTitle(databaseId: string, configs: ConfigStore) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel.title = `Query — ${cfg?.name ?? 'Unknown'}`;
  }

  private post(msg: QueryOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: QueryIn) {
    if (msg.type !== 'query.run') { return; }
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      this.post({ type: 'query.error', message: 'No active database. Connect first.' });
      return;
    }
    try {
      const { rows, durationMs } = await this.manager.executeQuery(msg.query);
      const columns = computeColumns(rows);
      this.post({ type: 'query.result', rows, columns, durationMs });
    } catch (err) {
      this.post({ type: 'query.error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private dispose() {
    QueryEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
```

- [ ] **Step 5: Replace the toast in `src/extension.ts`**

Replace the `dittoVsce.openQueryEditor` toast (added in Task 6) with the real call:

```ts
vscode.commands.registerCommand('dittoVsce.openQueryEditor', (databaseId: string) => {
  if (!databaseId) { return; }
  QueryEditorPanel.show(context, manager, configStore, databaseId);
}),
```

Add the import at the top of `src/extension.ts`, alongside the other panel imports:
```ts
import { QueryEditorPanel } from './panels/QueryEditorPanel.js';
```

- [ ] **Step 6: Build & test**

```bash
npm run build
npm test
```

Expected: build succeeds (`dist/webview-ui/query.js` created); 29/29 tests.

- [ ] **Step 7: Commit**

```bash
git add src/panels/QueryEditorPanel.ts src/ipc/messages.ts src/extension.ts esbuild.config.mjs webview-ui/query/main.ts
git commit -m "feat(panels): add QueryEditorPanel host wired to executeQuery"
```

---

## Task 8: Query Editor Lit UI

**Goal:** Replace the placeholder bundle with the real query editor: monospace textarea, Run button + Cmd-Enter shortcut, table view with column-per-key, JSON view toggle, error banner, empty state.

**Files:**
- Create: `webview-ui/query/query-element.ts`
- Modify: `webview-ui/query/main.ts`

- [ ] **Step 1: Create the Lit element**

Create file `webview-ui/query/query-element.ts`:
```ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

type In =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number }
  | { type: 'query.error'; message: string };

type View = 'table' | 'json';
type RunState = 'idle' | 'running' | 'success' | 'error';

const TRUNCATE_AT = 120;

function renderCell(value: unknown): { display: string; full: string; nullish: boolean } {
  if (value === null) { return { display: 'null', full: 'null', nullish: true }; }
  if (value === undefined) { return { display: 'undefined', full: 'undefined', nullish: true }; }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return {
      display: json.length > TRUNCATE_AT ? json.slice(0, TRUNCATE_AT) + '…' : json,
      full: json,
      nullish: false,
    };
  }
  const s = String(value);
  return {
    display: s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT) + '…' : s,
    full: s,
    nullish: false,
  };
}

@customElement('ditto-query-editor')
export class QueryEditor extends LitElement {
  @state() private query = '';
  @state() private state: RunState = 'idle';
  @state() private rows: Record<string, unknown>[] = [];
  @state() private columns: string[] = [];
  @state() private durationMs = 0;
  @state() private errorMessage: string | null = null;
  @state() private view: View = 'table';

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 16px;
      gap: 12px;
      box-sizing: border-box;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .editor-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: 8px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      resize: vertical;
    }
    .editor-toolbar {
      display: flex;
      justify-content: flex-end;
    }
    button.run {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      font: inherit;
      cursor: pointer;
    }
    button.run[disabled] { opacity: 0.5; cursor: not-allowed; }

    .results-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .results-meta {
      flex: 1;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .view-toggle {
      display: flex;
      gap: 2px;
    }
    .view-toggle button {
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .view-toggle button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .results-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    .empty {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      vertical-align: top;
    }
    th {
      background: var(--vscode-editorWidget-background);
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      font-size: 11px;
      position: sticky;
      top: 0;
    }
    td {
      font-family: var(--vscode-editor-font-family);
      max-width: 480px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    td.nullish {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    pre.json {
      margin: 0;
      padding: 8px;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .error-banner {
      padding: 12px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 2px;
      font-size: 13px;
    }
    .error-banner pre {
      margin: 8px 0 0 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'query.result') {
        this.rows = msg.rows;
        this.columns = msg.columns;
        this.durationMs = msg.durationMs;
        this.errorMessage = null;
        this.state = 'success';
      } else if (msg.type === 'query.error') {
        this.errorMessage = msg.message;
        this.rows = [];
        this.columns = [];
        this.state = 'error';
      }
    });
  }

  private run() {
    if (!this.query.trim() || this.state === 'running') { return; }
    this.state = 'running';
    this.errorMessage = null;
    postToHost({ type: 'query.run', query: this.query });
  }

  private handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      this.run();
    } else if (e.key === 'Escape') {
      this.errorMessage = null;
    }
  }

  render() {
    return html`
      <div class="editor-pane">
        <textarea
          .value=${this.query}
          placeholder="Type a DQL query, e.g. SELECT * FROM __small_peer_info"
          @input=${(e: Event) => this.query = (e.target as HTMLTextAreaElement).value}
          @keydown=${this.handleKeydown}
        ></textarea>
        <div class="editor-toolbar">
          <button class="run" ?disabled=${!this.query.trim() || this.state === 'running'} @click=${this.run}>
            ${this.state === 'running' ? 'Running…' : '▶ Run'}
          </button>
        </div>
      </div>

      ${this.errorMessage ? html`
        <div class="error-banner">
          <strong>Query failed</strong>
          <pre>${this.errorMessage}</pre>
        </div>
      ` : nothing}

      ${this.state === 'success' ? html`
        <div class="results-header">
          <div class="results-meta">${this.rows.length} ${this.rows.length === 1 ? 'row' : 'rows'} · ${this.durationMs} ms</div>
          <div class="view-toggle">
            <button class=${this.view === 'table' ? 'active' : ''} @click=${() => this.view = 'table'}>Table</button>
            <button class=${this.view === 'json' ? 'active' : ''} @click=${() => this.view = 'json'}>JSON</button>
          </div>
        </div>
      ` : nothing}

      <div class="results-body">
        ${this.state === 'idle' ? html`<div class="empty">Run a query to see results.</div>` : nothing}
        ${this.state === 'success' && this.view === 'table' ? this.renderTable() : nothing}
        ${this.state === 'success' && this.view === 'json' ? this.renderJson() : nothing}
      </div>
    `;
  }

  private renderTable() {
    if (this.rows.length === 0) {
      return html`<div class="empty">Query returned no rows.</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map(c => html`<th>${c}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(row => html`
            <tr>
              ${this.columns.map(c => {
                const cell = renderCell(row[c]);
                return html`<td class=${cell.nullish ? 'nullish' : ''} title=${cell.full}>${cell.display}</td>`;
              })}
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }

  private renderJson() {
    return html`<pre class="json">${JSON.stringify(this.rows, null, 2)}</pre>`;
  }
}
```

- [ ] **Step 2: Replace the entry point**

Replace `webview-ui/query/main.ts`:
```ts
import './query-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-query-editor');
  root.appendChild(el);
}
```

- [ ] **Step 3: Build & test**

```bash
npm run build
npm test
```

Expected: build succeeds, `dist/webview-ui/query.js` is now Lit-bundled (~30+ KB), 29/29 tests pass.

- [ ] **Step 4: Commit**

```bash
git add webview-ui/query/main.ts webview-ui/query/query-element.ts
git commit -m "feat(query): implement Lit-based Query Editor with table/JSON views"
```

---

## Task 9: Manual test recipes (T9 + T10)

**Goal:** Document the manual verification recipes in `docs/MANUAL_TESTING.md`. Final commit of the v2 work.

**Files:**
- Modify: `docs/MANUAL_TESTING.md`

- [ ] **Step 1: Append T9 and T10 to `docs/MANUAL_TESTING.md`**

Append to the end of `docs/MANUAL_TESTING.md` (after T8, before the existing `## Troubleshooting` section if present):

```markdown
### T9 · Peer Listing — real data, SwiftUI parity

**Pre-conditions:** A database connected (T5). For full verification, run the SwiftUI Ditto Edge Studio against the same database concurrently, or have another peer (mobile app, second machine) sync.

**Steps:**

1. Click `Peer Listing` tree leaf.
2. **Local Peer card** (black gradient, top-left of grid):
   - `Device Name = "VS Code"`.
   - `SDK Language`, `SDK Platform`, `SDK Version` — populated with real values from `__small_peer_info`. No "unknown" anywhere.
3. **Remote peer cards** (with at least one other peer reachable):
   - Card gradient color matches dominant connection type:
     - Cloud (purple) when connected via Ditto Server / WebSocket.
     - Orange for WebSocket-only.
     - Green for AccessPoint (LAN).
     - Red for P2P WiFi.
     - Blue for Bluetooth.
     - Gray for unknown.
   - `Ditto SDK: <version>` row shows real version, NOT "unknown".
   - At least one connection badge with a real type (`Bluetooth` / `WebSocket` / `WiFi AP` / `P2P WiFi`), NOT "unknown".
   - Status dot is green (or orange/red per actual session state).
   - "Last update" timestamp updates as data flows. Stays "just now" / "3:49 PM" / "Mar 5, 3:49 PM" depending on staleness.
4. Stop the SwiftUI peer (or other peer) → its card animates away within ~250ms.
5. Restart it → card animates back in. Position is preserved across re-renders for already-known peers.
6. Click Stop Sync → sync session status transitions through `Disconnected`. Cards stay visible (presence still observed). Click Start Sync → resumes.
7. Double-click any peer ID → it briefly flashes green (copied to clipboard).

### T10 · DQL Query Editor

**Pre-conditions:** A database connected (T5).

**Steps:**

1. Click `Query Editor` tree leaf → panel opens with empty textarea and "Run a query to see results." empty state.
2. Type `SELECT * FROM __small_peer_info` → press `Cmd+Enter` (or click Run).
3. Confirm: results header shows `"1 row · <n> ms"`. Table renders with columns including `ditto_sdk_language`, `ditto_sdk_platform`, `ditto_sdk_version` and one row populated.
4. Click the `JSON` toggle → same data as a JS array.
5. Type a malformed query (`SELECT * FORM books`) → press Run. Confirm red error banner with the SDK's parse error. Textarea content preserved. Press `Escape` → banner clears.
6. Type `SELECT * FROM tasks` (or any collection where you've inserted data via the SwiftUI app or another peer) → confirm real document rows back.
7. Run a query with heterogeneous documents (e.g., nested objects). Confirm columns reflect the union of keys; missing-key cells render empty; nested values render as `JSON.stringify` strings truncated at 120 chars with full value in tooltip.
```

- [ ] **Step 2: Verify the file**

Run:
```bash
grep -c "^### T" docs/MANUAL_TESTING.md
```

Expected: `10` (T1 through T10).

- [ ] **Step 3: Commit**

```bash
git add docs/MANUAL_TESTING.md
git commit -m "docs: T9 and T10 manual recipes for v2 real-data work"
```

---

## Done

After Task 9 ships:
- `npm test` reports 29 passing (22 baseline + 7 from peer-info merge logic).
- The Peer Listing UI shows real data on every field with full SwiftUI gradient/codicon/animation parity.
- The Query Editor runs DQL against the active database and renders table or JSON.
- Three SDK read paths proven: continuous presence push, DQL observer subscription, one-shot DQL execute.
- T9 and T10 verify success criteria.
