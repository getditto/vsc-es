# Ditto Edge Studio VS Code — POC v2: Real Data Wiring

**Date:** 2026-05-08
**Status:** Draft (pending review)
**Builds on:** `2026-05-08-ditto-edge-studio-vsce-poc-design.md` (the original POC, fully shipped)

## 1. Overview

The original 17-task POC shipped a working VS Code extension with a Lit-based Database Editor, a singleton `DittoManager` wrapping the NodeJS SDK, a Peer Listing panel, a Subscription Editor, and end-to-end persistence. The Task 2 spike confirmed the SDK loads in VS Code's Electron Node host.

However, the production-code path through `ditto.presence.observe` was never visually verified against real fields, and the extension exposes no end-user-driven DQL query path. The Peer Listing panel renders cards using a "best-guess" adapter that maps several presence-graph fields incorrectly: SDK Version reads `sdkVersion` (actual: `dittoSdkVersion`), Connection Type reads `type`/`kind` (actual: `connectionType`), and addresses don't exist on the SDK's `Connection` type at all. The result, in the screenshot at `vscode-peer-list.png`, is a card grid where ~30% of the fields say "unknown" or render empty.

This v2 spec wires real SDK data end-to-end and adds a query path. The goal is to **prove the SDK is usable for the broader project** by replicating the SwiftUI Edge Studio's connected-peers experience exactly — same visual treatment, same behavioral parity (peers appearing/disappearing in lockstep with the SwiftUI app) — and by adding a DQL Query Editor that runs ad-hoc queries against the active database.

### 1.1 References

- SwiftUI peer card source: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/EdgeStudio/Views/StudioView/Details/ConnectedPeersView.swift`
- SwiftUI sync-status data layer: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/EdgeStudio/Views/StudioView/ViewModels/SyncStatusViewModel.swift`
- SwiftUI models: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/EdgeStudio/Models/SyncStatus.swift`
- Ditto NodeJS SDK presence types: `node_modules/@dittolive/ditto/types/ditto.d.ts` (lines 1551–1750)

### 1.2 Goals

- **Prove the SDK works** in the VS Code extension host across three independent read paths:
  1. Continuous presence push (`ditto.presence.observe`).
  2. DQL observer subscription against the system collection `__sync_status`.
  3. One-shot DQL execute (`ditto.store.execute`).
- **Match SwiftUI Edge Studio 1:1** visually for the peer cards: gradient backgrounds keyed off dominant connection type, status indicator dots, codicon-iconed rows, connection badges, collapsible metadata, animations.
- **Match SwiftUI Edge Studio behaviorally**: a peer joining or leaving the SwiftUI app's presence graph appears or disappears in the VS Code panel within the SDK's coalescing window.
- **Provide a Query Editor** as a second SDK proof-point for the read path.

### 1.3 Non-goals

- Full SpriteKit-style force-directed presence graph (the SwiftUI app's `PresenceViewerSK`). The "Presence Graph" tab keeps its "Coming soon" placeholder — listed as a future task in the original spec § 10.
- Network interface diagnostics (the SwiftUI app's `NetworkInterfaceCard` grid below the peers).
- Live observer mode in the Query Editor. The user explicitly chose one-shot execute only (option (a) during brainstorming).
- Query history persistence, multi-tab queries, query templates.
- Identity webhook configuration / setting peer metadata from VS Code.
- Distance display on connection badges (the SDK's `Connection` type does not carry an `approximateDistanceInMeters` field — that's a SwiftUI-side enrichment from a separate API path. Out of scope.)

## 2. Architecture

### 2.1 File map

```
src/
├── ditto/
│   ├── DittoManager.ts           ~ wires three SDK sources, drops (any) casts
│   └── peer-info.ts              + pure merge logic — TDD-able
├── panels/
│   ├── PeerListingPanel.ts       ~ pushes the new richer state shape
│   └── QueryEditorPanel.ts       + new singleton webview host
├── tree/
│   ├── DatabaseTreeProvider.ts   ~ adds 'queryEditor' leaf rendering
│   └── DatabaseTreeItem.ts       ~ extends discriminated union
├── ipc/messages.ts               ~ revised PeerOut shape; adds QueryIn/Out
├── models/DittoConfig.ts         ~ new PeerInfo / LocalPeerInfo types
└── test/
    └── peer-info.test.ts         + ~6 TDD tests for merge logic

webview-ui/
├── peers/peers-element.ts        ~ full visual rewrite (codicons, gradients, badges)
├── peers/main.ts                 (unchanged — bootstrap stays same)
├── query/                        + new directory
│   ├── main.ts                   +
│   └── query-element.ts          +
└── shared/
    ├── messaging.ts              (unchanged)
    └── codicons.css              + symlink/copy from @vscode/codicons

dist/webview-ui/codicon.ttf       + asset copy at build time
package.json                      ~ add @vscode/codicons devDep
esbuild.config.mjs                ~ copy codicon.{ttf,css} to dist/webview-ui/
docs/MANUAL_TESTING.md            ~ T9 + T10 recipes
```

### 2.2 Tech choices

| Concern | Choice | Rationale |
|---|---|---|
| Icon font | `@vscode/codicons` | VS Code-native, already loaded in the parent webview, ~95% intent parity with SwiftUI's FontAwesome use; no FontAwesome bundling cost. |
| Status indicator | 8×8 colored circle div | No icon — matches SwiftUI's bare `Circle()`. |
| Gradient backgrounds | CSS `linear-gradient(135deg, …)` | Matches SwiftUI's `topLeading → bottomTrailing` direction. |
| Animations | CSS `@keyframes` + Lit re-render | Spring-style insert (cubic-bezier), opacity-fade remove. Avoids motion library. |
| Local peer card | Black gradient | Mirrors SwiftUI's `[trafficBlack, jetBlack]` dark-mode treatment. |
| Query result rendering | HTML `<table>` + `<pre>` JSON toggle | Plain DOM, themed via CSS variables. No data-grid dependency. |
| Query parser | None | Send the raw string to `ditto.store.execute`; surface SDK errors verbatim. |
| Local peer device name | Hardcoded `"VS Code"` | Mirrors SwiftUI's `"Edge Studio"` hardcoding in `loadLocalPeerInfo()`. |

## 3. Data flow

### 3.1 Three SDK sources

**Source A — Presence graph (continuous, push)**

```ts
const observer: PresenceObserver = ditto.presence.observe(
  (graph: PresenceGraph) => { /* coalesce 250ms, then merge */ }
);
```

`PresenceGraph` (from `ditto.d.ts:1649`) carries `localPeer: Peer` and `remotePeers: Peer[]`. Each `Peer` has:
- `peerKey: string`
- `deviceName: string`
- `os?: 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic'`
- `dittoSdkVersion?: string`
- `connections: Connection[]` where `Connection` has `id`, `connectionType: 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth'`, `peer1`, `peer2`
- `peerMetadata: Record<string, any>`
- `identityServiceMetadata: Record<string, any>`
- `isConnectedToDittoServer: boolean`
- `isCompatible?: boolean`

Coalesced 250ms (already implemented in `attachPresenceObserver`).

**Source B — `__sync_status` (continuous, push via DQL observer + sync subscription)**

```ts
ditto.sync.registerSubscription('SELECT * FROM __sync_status');
ditto.store.registerObserver(
  'SELECT * FROM __sync_status',
  (result) => { /* update sync-status snapshot, trigger merge */ }
);
```

Each result row is a document with shape:
```
{
  _id: string,                              // peer key
  is_ditto_server: boolean,
  documents: {
    sync_session_status: 'Connected' | 'Connecting' | 'Disconnected' | string,
    synced_up_to_local_commit_id?: number,
    last_update_received_time?: number      // epoch ms or seconds — coerce to ms
  }
}
```

Drives the green/orange/red status dot, the "Synced to commit" line, and the "Last update" timestamp. Subscription is registered alongside other persisted subscriptions in `connect()`.

**Source C — `__small_peer_info` (one-shot at connect)**

```ts
const result = await ditto.store.execute(
  'SELECT ditto_sdk_language, ditto_sdk_platform, ditto_sdk_version FROM __small_peer_info'
);
```

Issued exactly once after `sync.start()`, cached for the session, cleared on disconnect. The presence graph's `localPeer` does not carry SDK language/platform — only `dittoSdkVersion`. This query fills the gap. Device name is hardcoded `"VS Code"` (mirrors SwiftUI's hardcoding).

### 3.2 Type contracts

In `src/models/DittoConfig.ts` (replaces the existing `LocalPeer`/`RemotePeer`/`PeerSnapshot`):

```ts
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
  id: string;                           // peer key
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOS;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, any>;
  identityMetadata?: Record<string, any>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;      // epoch ms
}

export interface LocalPeerInfo {
  deviceName: string;                   // "VS Code"
  sdkLanguage: string;                  // from __small_peer_info
  sdkPlatform: string;
  sdkVersion: string;
}

export interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}
```

The legacy `LocalPeer`/`RemotePeer`/`PeerSnapshot` types are removed (their consumers all live in code we're rewriting in this work). The IPC `PeerOut` is updated to carry the new `PeerListSnapshot`:

```ts
export type PeerOut =
  | { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };
```

### 3.3 Merge — `src/ditto/peer-info.ts`

Pure logic, no `vscode` import, fully unit-testable.

```ts
interface SyncStatusRow {
  _id: string;
  is_ditto_server: boolean;
  sync_session_status: SyncSessionStatus;
  synced_up_to_local_commit_id?: number;
  last_update_received_time?: number;
}

export function parseSyncStatusRow(raw: any): SyncStatusRow | null { ... }

export function mergePeerList(
  presence: PresenceGraph,
  syncStatusByPeerKey: Map<string, SyncStatusRow>,
  local: LocalPeerInfo | null,
  previousOrder: string[]
): PeerListSnapshot {
  // 1. For each remote peer in presence, build PeerInfo:
  //    - id ← peer.peerKey
  //    - presence fields directly
  //    - sync fields from syncStatusByPeerKey.get(peer.peerKey), defaulting:
  //        syncSessionStatus = 'Unknown'
  //        syncedUpToLocalCommitId = undefined
  //        lastUpdateReceivedTime = undefined
  //    - isDittoServer = syncStatus?.is_ditto_server ?? peer.isConnectedToDittoServer
  //
  // 2. Order preservation (mirrors SwiftUI's mergeStatusItems):
  //    a. Walk previousOrder; keep peers still present in same position.
  //    b. Append peers new to this snapshot (not in previousOrder) at the end.
  //    c. Drop peers absent from this snapshot.
  //
  // 3. Return { local, remote: orderedPeerInfos }.
}

export function dominantConnectionType(peer: PeerInfo): 'cloud' | 'WebSocket' | 'AccessPoint' | 'P2PWiFi' | 'Bluetooth' | 'unknown' {
  if (peer.isDittoServer) return 'cloud';
  for (const t of ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'] as const) {
    if (peer.connections.some(c => c.connectionType === t)) return t;
  }
  return 'unknown';
}
```

The `previousOrder` parameter is the `id`-array from the prior emission. `DittoManager` keeps it as a private field and threads it on each merge.

### 3.4 `DittoManager` changes

- Drops the `(any)` casts on `presence`, `sync.isActive`, `c.peerToPeer.*`. Where SDK types are missing fields, narrow `as` casts at the use site instead of `as any` on the whole object.
- Adds private state: `latestPresence: PresenceGraph | null`, `syncStatusByPeerKey: Map<string, SyncStatusRow>`, `localPeerInfo: LocalPeerInfo | null`, `previousOrder: string[]`.
- Adds `private async loadLocalPeerInfo(): Promise<void>` called once after `sync.start()` in `connect()`, populating `localPeerInfo`.
- Adds `private attachSyncStatusObserver(ditto: Ditto): void` called in `connect()` after presence is attached. Registers a subscription + observer; on each emission, parses rows and updates `syncStatusByPeerKey`, then triggers `firePresence(buildSnapshot())`.
- The presence observer's coalesce-flush also calls `firePresence(buildSnapshot())`.
- `private buildSnapshot(): PeerListSnapshot` calls `mergePeerList(latestPresence, syncStatusByPeerKey, localPeerInfo, previousOrder)`, updates `previousOrder` from the result, returns the snapshot.
- `getLatestSnapshot(): PeerListSnapshot` returns the cached `latestSnapshot`.
- `disconnect()` clears all four new fields in the existing `finally` block.

The `__sync_status` system subscription is stored in `subscriptionHandles` under the reserved id `'__sync_status'` so the existing `disconnect()` cleanup walks all handles uniformly. The `__sync_status` *observer* (separate handle, returned by `ditto.store.registerObserver`) is held in a new private field `syncStatusObserver: { cancel: () => void } | null`, cancelled in `disconnect()` alongside the presence observer.

### 3.5 Disconnect cleanup

The existing `disconnect()` already cancels all subscription handles, stops presence observer, stops sync, and closes Ditto. Additions:
- Clear `latestPresence`, `syncStatusByPeerKey`, `localPeerInfo`, `previousOrder`.

The order observer cancellation happens before `ditto.close()` (already true today).

## 4. Peer card visuals

### 4.1 Color palette — gradient by dominant connection type

| Type | Trigger | Start RGB | End RGB |
|---|---|---|---|
| Cloud | `isDittoServer === true` | `rgb(115, 38, 184)` | `rgb(71, 18, 122)` |
| WebSocket | any `connectionType === 'WebSocket'` | `rgb(217, 122, 0)` | `rgb(153, 77, 0)` |
| AccessPoint (LAN) | any `connectionType === 'AccessPoint'` | `rgb(13, 133, 64)` | `rgb(5, 82, 36)` |
| P2P WiFi | any `connectionType === 'P2PWiFi'` | `rgb(199, 26, 56)` | `rgb(128, 10, 31)` |
| Bluetooth | any `connectionType === 'Bluetooth'` | `rgb(0, 102, 217)` | `rgb(0, 51, 153)` |
| Unknown | none of the above | `rgb(89, 89, 102)` | `rgb(51, 51, 64)` |

Priority: cloud → WebSocket → AccessPoint → P2PWiFi → Bluetooth → unknown. Card uses `linear-gradient(135deg, var(--card-start), var(--card-end))` (matches SwiftUI's `topLeading → bottomTrailing`). All text rendered white on colored backgrounds.

The Local Peer card uses `linear-gradient(135deg, rgb(20, 20, 20), rgb(0, 0, 0))` — mirrors SwiftUI's dark-mode `[trafficBlack, jetBlack]`. White text.

### 4.2 Card structure (remote peer)

Matches SwiftUI's `syncStatusCard(for:)`. From top to bottom:

```
┌───────────────────────────────────────────────┐
│ <DeviceName>                  ● <Status>      │  header
│  <os-icon> Android 13                         │
│ pAAoCcgkMCFokYjJuixja...                      │
├───────────────────────────────────────────────┤  divider (white 25%)
│ <pkg-icon> Ditto SDK: 4.10.0                  │  body
│ ▶ Identity Metadata                           │
│ ▶ Peer Metadata                               │
│ <link-icon> Active Connections (4)            │
│   ┌─────────────────────────────────────────┐ │
│   │ <type-icon> Bluetooth                   │ │  connection badge
│   ├─────────────────────────────────────────┤ │
│   │ <type-icon> WebSocket                   │ │
│   └─────────────────────────────────────────┘ │
│ <check-icon> Synced to commit: 12345          │  (only if present)
│ <clock-icon> Last update: 11/8/26, 3:49:25 PM │
└───────────────────────────────────────────────┘
```

- **Header**: deviceName as `<h3>` (~14px headline weight). OS row as `<div>` with codicon + `<displayName>` (e.g., `Android 13` from `peer.os` plus `peerMetadata.os_version` if available, falling back to `peer.os` alone). Peer ID as monospace `<code>` truncated with title-tooltip and double-click-to-copy. Status section right-aligned: 8×8 colored circle + status label.
- **Divider**: 1px solid `rgba(255,255,255,0.25)`.
- **Body**: rows of `<div class="row">` with codicon + label/value. `Identity Metadata` and `Peer Metadata` rendered as `<details>` (HTML native disclosure with chevron). Disabled when corresponding field is empty.
- **Connections**: heading row, then a vertical stack of badges. Each badge: rounded `rgba(255,255,255,0.12)` fill with `rgba(255,255,255,0.20)` 1px stroke, codicon + connection display name. (No distance — SDK doesn't expose it; non-goal.)
- **Footer**: synced-commit row (rendered only if `syncedUpToLocalCommitId` is defined) + last-update row (always rendered; shows `"Never"` if `lastUpdateReceivedTime` is undefined).

### 4.3 Local Peer card structure

Matches SwiftUI's `LocalPeerInfoCard`:

```
┌───────────────────────────────────────────────┐
│ <globe-icon> Local Peer                       │  header
├───────────────────────────────────────────────┤  divider
│ Device Name      <deviceName>                 │
│ SDK Language     <sdkLanguage>                │
│ SDK Platform     <sdkPlatform>                │
│ SDK Version      <sdkVersion>                 │
└───────────────────────────────────────────────┘
```

Black gradient. Same dimensions as remote peer cards (`min-height: 280px`).

### 4.4 Codicon mapping

| Use | Codicon class |
|---|---|
| OS — iOS / macOS / Generic | `.codicon-device-mobile` |
| OS — Android | `.codicon-device-mobile` |
| OS — Windows / Linux / tvOS | `.codicon-terminal` |
| OS — Unknown | `.codicon-question` |
| Bluetooth | `.codicon-radio-tower` |
| AccessPoint / WiFi AP | `.codicon-broadcast` |
| P2P WiFi | `.codicon-circuit-board` |
| WebSocket / Cloud | `.codicon-cloud` |
| Sync OK | `.codicon-check` |
| Last update / Clock | `.codicon-clock` |
| SDK | `.codicon-package` |
| Connection link | `.codicon-link` |
| Metadata info | `.codicon-info` |
| Local peer header | `.codicon-globe` |

The codicon font and CSS ship via `@vscode/codicons` (added to `devDependencies`). Build step copies `codicon.css` and `codicon.ttf` from `node_modules/@vscode/codicons/dist/` to `dist/webview-ui/`. The `peers.js` and `query.js` bundles `@import` the CSS file. CSP `font-src ${cspSource}` already permits the font.

### 4.5 Status indicator dot colors

| `syncSessionStatus` | Color |
|---|---|
| `Connected` | `var(--vscode-charts-green)` |
| `Connecting` | `var(--vscode-charts-orange)` |
| `Disconnected` | `var(--vscode-charts-red)` |
| `Unknown` | `var(--vscode-descriptionForeground)` |

### 4.6 Readability fixes

- Device name truncation: CSS `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;` on `<h3>`. Full name in `title` attribute. Drop the always-appended `…` literal.
- Peer ID: monospace, `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` on the parent. Full ID in `title` and on double-click copies to clipboard via `navigator.clipboard.writeText(id)`. Brief 1.5s green flash via state field on the element.
- Last update: derived from `__sync_status.last_update_received_time` (real). Display logic:
  - Within last 60s → `"just now"`.
  - Within last 24 hours → `"3:49 PM"` (local time).
  - Older → `"Mar 5, 3:49 PM"` (locale short-date + time).
  - `undefined` / null → `"Never"`.
  - Re-rendered every 30s (a single panel-level `setInterval` triggers `requestUpdate()`) so the relative-time string stays fresh.

### 4.7 Animations

- Card insert: `@keyframes` `transform: scale(0.88); opacity: 0` → `scale(1); opacity: 1` over 350ms `cubic-bezier(0.34, 1.56, 0.64, 1)` (springy). Applied via `animation:` on first render of a new card.
- Card remove: `opacity: 1` → `opacity: 0` over 250ms. Implemented via a "leaving set": when an id present in the previous render is absent in the current, the element stays mounted with `removing` class for one frame then unmounts.
- Reorder: cards keep their grid position when one is removed (the merge algorithm guarantees stable positions; CSS grid handles reflow with default smooth-ish behavior).

### 4.8 Layout

`display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px;`. Matches SwiftUI's `GridItem(.adaptive(minimum: 260, maximum: 520))` (we drop the maximum constraint — VS Code panels are typically narrower; `1fr` lets cards grow naturally to fill available width).

Card defaults: `min-height: 280px`, `padding: 16px`, `border-radius: 12px`, `box-shadow: 0 3px 6px rgba(0,0,0,0.25)`.

## 5. Query Editor

### 5.1 Tree leaf

`DatabaseTreeNode` discriminated union gains:
```ts
| { kind: 'queryEditor'; databaseId: string }
```

Rendered when a database is `active`, alongside `subscriptionsParent` and `peerListing`. TreeItem: codicon `terminal`, label `"Query Editor"`, command `dittoVsce.openQueryEditor` with `databaseId` argument.

### 5.2 Panel host (`src/panels/QueryEditorPanel.ts`)

Singleton, same shape as `PeerListingPanel`: static `current`, `show(...)`, private constructor, `dispose()` clearing the singleton, `setTimeout(..., 50)` deferred init.

### 5.3 IPC contract (`src/ipc/messages.ts`)

```ts
export type QueryIn =
  | { type: 'query.run'; query: string };

export type QueryOut =
  | { type: 'query.result'; rows: Record<string, any>[]; columns: string[]; durationMs: number }
  | { type: 'query.error'; message: string };
```

The host's `handle('query.run')` does:
```ts
const start = performance.now();
try {
  const result = await ditto.store.execute(msg.query);
  const rows = result.items.map(i => i.value);
  const columns = computeColumns(rows);
  const durationMs = Math.round(performance.now() - start);
  this.post({ type: 'query.result', rows, columns, durationMs });
} catch (err) {
  this.post({ type: 'query.error', message: err instanceof Error ? err.message : String(err) });
}
```

`computeColumns(rows)` returns the union of top-level keys across rows, with `_id` first if present, then alphabetical.

### 5.4 Webview UI (`webview-ui/query/query-element.ts`)

Lit element `ditto-query-editor`. State:
- `query: string` (textarea content)
- `state: 'idle' | 'running' | 'success' | 'error'`
- `lastResult: { rows, columns, durationMs } | null`
- `view: 'table' | 'json'`
- `errorMessage: string | null`

### 5.5 UI layout

- **Top half**: `<textarea>` monospace, min-height 120px, full width, themed via VS Code variables. Right-aligned `Run` button (codicon `play`). Disabled while `state === 'running'`.
- **Results header strip**: when `lastResult` is set, shows `"<n> rows · <ms> ms"` on the left, segmented `[Table] [JSON]` toggle on the right. Hidden when no result.
- **Results body**:
  - Empty state: centered `"Run a query to see results."` in `--vscode-descriptionForeground`.
  - Table view: HTML `<table>` with `<thead>` (column names, monospace, smaller font) and `<tbody>` (rows). Cell content: `JSON.stringify(value)` for arrays/objects, `String(value)` otherwise. Truncate display to 120 chars, full value in `title`. `null`/`undefined` rendered as italicized `null` / `undefined` in `--vscode-descriptionForeground`.
  - JSON view: `<pre>` with `JSON.stringify(rows, null, 2)`.
- **Error state**: red-tinted banner with `errorMessage`. Textarea content preserved.

### 5.6 Keyboard

- `Cmd+Enter` / `Ctrl+Enter` in textarea → triggers Run.
- `Escape` clears `errorMessage` (banner dismisses).

## 6. Testing & verification

### 6.1 Unit tests (TDD)

Only `peer-info.ts` is pure logic worth testing. `src/test/peer-info.test.ts` extends the existing 22-test suite by ~6 tests:

1. `mergePeerList` produces empty `remote[]` when presence has no remote peers.
2. Each remote peer becomes a `PeerInfo` with id/deviceName/os/sdkVersion mapped from the SDK fields.
3. Sync status matched by peer key — `Connected` flows through; missing sync row defaults to `Unknown`.
4. `isDittoServer` precedence: `__sync_status.is_ditto_server` overrides `peer.isConnectedToDittoServer` when both present.
5. Order preservation: peers in `previousOrder` keep position; new peers append; absent peers drop. Verify with three successive merges.
6. `dominantConnectionType` priority: cloud (server) > WebSocket > AccessPoint > P2PWiFi > Bluetooth > unknown. Test each tier.

The merge logic has no `vscode` import, so the existing `vscode-stub.mjs` loader is unaffected.

Total tests after: 28 (22 existing + 6 new).

### 6.2 Manual test recipes

Append to `docs/MANUAL_TESTING.md`:

**T9 · Peer Listing — real data, SwiftUI parity**

Pre-conditions: connected database (T5). For full verification, run the SwiftUI Ditto Edge Studio against the same database concurrently, or have another peer (mobile app, second machine) sync.

1. Click `Peer Listing` tree leaf.
2. **Local Peer card**: black gradient, real `Device Name = "VS Code"`, real `SDK Language` (e.g., `js`), `SDK Platform` (e.g., `node`), `SDK Version` (e.g., `5.0.0`). No "unknown" anywhere.
3. **Remote peer cards** (with at least one other peer reachable):
   - Card gradient color matches dominant connection type (cloud → purple, WebSocket → orange, etc.).
   - `Ditto SDK: <version>` row shows real version, NOT "unknown".
   - At least one connection badge with a real type (`Bluetooth` / `WebSocket` / `AccessPoint` / `P2PWiFi`), NOT "unknown".
   - Status dot is green (or orange/red per actual session state).
   - "Last update" timestamp updates as data flows.
4. Stop the SwiftUI peer (or other peer) → its card animates away within 250ms.
5. Restart it → card animates back in. Position is preserved across re-renders for already-known peers.
6. Click Stop Sync → cards stay visible (presence still observed) but sync session status transitions through `Disconnected`. Click Start Sync → resumes.

**T10 · DQL Query Editor**

Pre-conditions: connected database (T5).

1. Click `Query Editor` tree leaf → panel opens with empty textarea and "Run a query to see results." empty state.
2. Type `SELECT * FROM __small_peer_info` → press `Cmd+Enter` (or click Run).
3. Confirm: results header shows `"1 row · <n> ms"`. Table renders with columns including `ditto_sdk_language`, `ditto_sdk_platform`, `ditto_sdk_version` and one row populated. Toggle JSON view — same data as a JS array.
4. Type a malformed query (`SELECT * FORM books`) → press Run. Confirm red error banner with the SDK's parse error. Textarea content preserved.
5. Type `SELECT * FROM tasks` (or any collection where you've inserted data via the SwiftUI app or another peer) → confirm real document rows back.
6. Run a query with heterogeneous documents (e.g., nested objects). Confirm columns reflect the union of keys; missing-key cells render empty; nested values render as `JSON.stringify` strings truncated at 120 chars with full value in tooltip.

### 6.3 Regression coverage

T1–T8 must still pass after this work. The touched recipes are T6 (Peer Listing visuals are rewritten) and indirectly T8 (the existing presence observer is replaced — verify subscriptions still re-register on reconnect).

## 7. Risks

| Risk | Mitigation |
|---|---|
| `__sync_status` schema differs from SwiftUI's documented shape (e.g., field names changed in SDK 5.0). | Add a defensive `parseSyncStatusRow` that returns `null` on unrecognized shape; log to output channel; UI gracefully shows `Unknown` status. Verify against actual emission during T9 manual test; amend parser if shapes differ. |
| `__small_peer_info` query fails on small-peers-only mode or very early in connect. | Wrap `loadLocalPeerInfo()` in try/catch; on failure, log and leave `localPeerInfo = null` (UI renders Local Peer card with empty/dash placeholders, but remote cards still work). Mirrors SwiftUI's failure handling. |
| `presence.observe` returns a different `PresenceObserver` shape than the typedef suggests at runtime (the old `(any).stop?.()` pattern). | Read SDK's `Presence` class typedef at lines 1676+ for the actual return type; use it strictly. Existing `(any)` cast is the bug to fix, not preserve. |
| Codicon font fails to load (CSP, path). | Verify in T9: codicon characters render, not boxes/glyph-not-found. If broken, fall back to Unicode emoji per-icon as a hotfix. |
| Card animations cause layout thrash on rapid presence churn. | Coalescing already throttles to 250ms; CSS grid + transform-only animations are GPU-cheap. If churn is real, add a `prefers-reduced-motion` opt-out. |
| Query results are large (10k+ rows) and freeze the webview. | For POC, no virtualization; document a hard limit ("results truncated above 1000 rows") in the table footer. Slice `rows` before sending over IPC. |

## 8. Open questions / future work

- **Connection address rendering**: SwiftUI shows `addressInfo: PeerAddressInfo?` per peer (e.g., `"WiFi: 192.168.1.10"`). The NodeJS SDK's `Connection` type doesn't expose this. If a future SDK release exposes it, add to `ConnectionInfo` and to the connection-badge subline.
- **Peer distance**: Same — `approximateDistanceInMeters` is on SwiftUI's `ConnectionInfo` but not the NodeJS SDK's `Connection`. Future SDK addition would extend the badge.
- **Live-observe mode for Query Editor**: out of scope per user choice. Adding later is ~10 lines on the host (swap `execute` for `registerObserver`) plus a Lit toggle.
- **Peer card double-click-to-copy peer ID**: implemented in v2 via `navigator.clipboard.writeText`. SwiftUI uses NSPasteboard; equivalent UX.
- **Query Editor history**: out of scope. Persist last N queries in `globalState` if the broader project wants it.
- **Network interface diagnostics card grid** below peers (SwiftUI's `NetworkInterfaceCard`s): out of scope for this v2; would require a Node-side network introspection layer.
- **Presence Graph tab (force-directed visualization)**: stays a "Coming soon" placeholder. SwiftUI uses SpriteKit; web equivalent would be vis-network or D3 force layout, separate spec.
