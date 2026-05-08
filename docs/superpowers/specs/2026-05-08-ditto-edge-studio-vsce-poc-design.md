# Ditto Edge Studio — VS Code Extension POC

**Date:** 2026-05-08
**Status:** Draft (pending review)

## 1. Overview

A POC Visual Studio Code extension that mimics the core debugging features of the existing Ditto Edge Studio SwiftUI app, targeting macOS / Windows / Linux via the Ditto NodeJS SDK. POC scope: register Ditto database configurations, securely store credentials, connect to one database at a time, register subscriptions, and view connected peers.

### 1.1 Reference

- SwiftUI app: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/`
- NodeJS quickstart used for SDK integration: `/Users/labeaaa/Developer/quickstart/javascript-tui/`
- Ditto NodeJS SDK: `@dittolive/ditto` 5.0.0+, ESM, Node ≥ 20

### 1.2 Goals

- Demonstrate that the Ditto NodeJS SDK functions inside a VS Code extension host.
- Provide a usable end-to-end developer workflow: register → connect → subscribe → observe peers.
- Idiomatic VS Code UX (TreeView-driven nav; webview panels for rich content).
- TypeScript codebase, lightweight runtime, easy to maintain.

### 1.3 Non-goals (for POC)

- No multiple concurrent active databases.
- No Presence Graph implementation (placeholder only).
- No collections viewer, query editor, observers tab, attachment tools, log viewer, metrics, or other features from the SwiftUI app's MainStudioView.
- No iCloud / cross-device sync of stored configs.
- No Marketplace publication pipeline (manual `vsce package` only).

## 2. Architecture

### 2.1 Project layout

```
ditto-vsc-es/
├── package.json                    # extension manifest (contributes, activation)
├── tsconfig.json
├── esbuild.config.mjs              # extension host bundle
├── src/                            # extension host (Node)
│   ├── extension.ts                # activate / deactivate
│   ├── ditto/
│   │   └── DittoManager.ts         # singleton: lifecycle, sync, subs, presence
│   ├── tree/
│   │   ├── DatabaseTreeProvider.ts
│   │   └── DatabaseTreeItem.ts
│   ├── panels/
│   │   ├── DatabaseEditorPanel.ts
│   │   ├── SubscriptionEditorPanel.ts
│   │   └── PeerListingPanel.ts
│   ├── storage/
│   │   ├── ConfigStore.ts
│   │   └── SecretStore.ts
│   ├── ipc/
│   │   └── messages.ts
│   └── models/
│       └── DittoConfig.ts
├── webview-ui/                     # Lit-based webview UI (separate Vite build)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── editor/                 # database registration form
│       ├── subscription/           # subscription form
│       ├── peers/                  # peer listing webview
│       └── shared/
│           └── messaging.ts        # typed postMessage helpers
└── resources/                      # icons, etc.
```

### 2.2 Tech choices

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript | User requirement |
| UI toolkit (webviews) | **Lit** | ~5 KB runtime, web-component-based, used by Microsoft's first-party VS Code samples |
| Bundler (extension host) | esbuild | Fast, official VS Code recommendation |
| Bundler (webview UI) | Vite | First-class Lit support, fast HMR during dev |
| Secret storage | `vscode.SecretStorage` | OS-native (Keychain / Credential Manager / libsecret) |
| Non-secret config | `context.globalState` | User-scoped, no extra deps |
| Ditto persistence | `context.globalStorageUri.fsPath/dittoData/<configId>/` | Per-config isolation |
| Active database model | Singleton (one at a time) | Matches SwiftUI app; avoids transport contention |

### 2.3 Active database lifecycle

```
[no active] ──click DB A──> [activating A] ──ready──> [active A]
[active A]  ──click DB B──> [stopping A]  ──> [activating B] ──> [active B]
[active A]  ──disconnect──> [stopping A]  ──> [no active]
```

The tree view shows a status dot per database: ○ idle, ◐ activating, ● active, ⊗ error.

## 3. Storage

### 3.1 Data shape

```ts
// context.globalState['dittoConfigs.v1']: StoredDittoConfig[]
type StoredDittoConfig = {
  id: string;                       // uuid
  name: string;
  databaseId: string;
  mode: 'server' | 'smallPeersOnly';
  authUrl: string;                  // server mode only
  websocketUrl: string;             // server mode only
  httpApiUrl: string;               // server mode optional
  allowUntrustedCerts: boolean;
  logLevel: 'error'|'warning'|'info'|'debug'|'verbose';
  isStrictModeEnabled: boolean;
  // Note: BLE/AWDL not stored — never available in VS Code host.
  // LAN + Cloud sync are forced-on defaults at runtime.
};

// context.secrets keys (one per secret per config):
//   `ditto.${id}.token`
//   `ditto.${id}.secretKey`     (small peers mode only)
//   `ditto.${id}.httpApiKey`    (server mode only, optional)
```

Subscriptions are persisted separately, keyed per-database:

```ts
// context.globalState['dittoSubscriptions.v1.${dbId}']: StoredSubscription[]
type StoredSubscription = {
  id: string;                       // uuid
  name: string;
  query: string;
};
```

### 3.2 Why not SQLCipher

The SwiftUI app uses SQLCipher because it persists ~8 repositories (history, favorites, observables, etc.). The POC's storage scope is config metadata + a handful of secrets — `SecretStorage` + `globalState` is the right size. Skipping SQLCipher avoids: another native module, key management code, and schema-migration boilerplate.

## 4. Tree view

### 4.1 Hierarchy

```
DATABASES                                                    [＋]
├─ ○ database-name-1   (Server, idle)
├─ ◐ database-name-2   (SmallPeers, activating)
└─ ● database-name-3   (Server, active)
   ├─ Subscriptions                                          [＋]
   │   ├─ subscription-name-1    SELECT * FROM tasks
   │   └─ subscription-name-2    SELECT * FROM comments
   └─ Peer Listing
```

- A database row only has children (`Subscriptions`, `Peer Listing`) when **active**. Idle databases render as a single collapsed row with no expand chevron.
- Clicking an **idle** database row → activates it (same as right-click → Connect). On success the row gains children and auto-expands.
- Clicking an **active** database row → standard tree expand/collapse behavior.
- Inline action [＋] on `DATABASES` root → "Register Database…"
- Inline action [＋] on `Subscriptions` parent → "New Subscription…"
- Right-click on database row: Connect (if idle) / Disconnect (if active), Edit Configuration, Delete
- Right-click on subscription leaf: Edit, Delete
- Click on `Peer Listing` leaf: opens `PeerListingPanel` (or refocuses if open)
- Subscription leaves: name as label, query as `description` (right-aligned subtitle), full query in tooltip
- Subscriptions are persisted even when the database is idle; they are only **rendered in the tree** while active. On (re)connect, all stored subscriptions for that DB are re-registered with the SDK.

### 4.2 Implementation note

A single `DatabaseTreeProvider` implements `TreeDataProvider<DatabaseTreeItem>` with a discriminated union of item kinds: `Database`, `SubscriptionsParent`, `Subscription`, `PeerListing`. `getChildren(item?)` switches on kind.

## 5. Webview panels

### 5.1 `DatabaseEditorPanel`

Registration / edit form, opens in editor area. Lit components.

- Auth Mode segmented picker: Server / Small Peers Only (top)
- Section: **Basic Information** → Name
- Section: **Authorization Information** → Database ID, Token (label changes by mode; "Offline Token" in small peers mode, with helper text linking to portal.ditto.live)
- Server-mode-only section: **Ditto Server (BigPeer) Information** → Auth URL, Websocket URL
- Server-mode-only section: **Ditto Server — HTTP API (Optional)** → URL, Key, "Allow untrusted certificates" toggle + warning text
- Small Peers Only-only section: **Optional Shared Secret Key** + helper text
- Section: **Developer Options** → SDK Log Level menu, "Enable DQL Strict Mode" toggle + caution text
- Footer: **Save** (disabled until name + databaseId + token filled), **Cancel**

### 5.2 `SubscriptionEditorPanel`

Small webview panel for create / edit. Opens in editor area. Lit.

- Field: Name (single-line input)
- Field: Query (multi-line textarea, monospace font, helper text "Ex: SELECT * FROM collectionName")
- Footer: **Save** (disabled until both filled), **Cancel**
- Closing the panel without clicking Save discards changes. No "unsaved changes" prompt for POC.

### 5.3 `PeerListingPanel`

Opens in editor area when the `Peer Listing` tree node is clicked. Lit.

- Header: database name + sync status indicator + Stop / Start Sync button
- Segmented control: `Connected Peers` | `Presence Graph`
- **Connected Peers tab (POC):**
  - `LocalPeerInfoCard`: device name, SDK language, SDK platform, SDK version
  - Adaptive grid of remote peer cards: peer ID, OS info, Ditto SDK version, connection type, address, last update timestamp
  - Driven by `ditto.presence.observe(...)` (snapshot pushed via IPC)
- **Presence Graph tab (POC):** "Coming soon" placeholder

## 6. IPC contract

Typed `postMessage` between extension host and each webview.

```ts
// editor panel
type EditorIn  = { type: 'editor.save'; config: StoredDittoConfig; secrets: SecretSet }
              | { type: 'editor.cancel' };
type EditorOut = { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
              | { type: 'editor.validationError'; message: string };

// subscription editor
type SubIn  = { type: 'sub.save'; id?: string; name: string; query: string }
            | { type: 'sub.cancel' };
type SubOut = { type: 'sub.init'; id?: string; name: string; query: string };

// peer listing
type PeerIn  = { type: 'peer.toggleSync' };
type PeerOut = { type: 'peer.state'; local: LocalPeer; remote: RemotePeer[]; sync: 'active'|'idle' };
```

## 7. Ditto SDK integration

### 7.1 Connection flow (server mode)

Lifted from `quickstart/javascript-tui/source/cli.js`:

1. `new DittoConfig(databaseId, { mode: 'server', url: authUrl }, persistenceDir)`
2. `await Ditto.open(config)` → instance
3. `ditto.updateTransportConfig(c => { c.peerToPeer.bluetoothLE.isEnabled = false; c.peerToPeer.awdl.isEnabled = false; c.peerToPeer.lan.isEnabled = true; c.peerToPeer.lan.isMdnsEnabled = true; c.peerToPeer.lan.isMulticastEnabled = true; })`
4. `await ditto.auth.setExpirationHandler(...)` (re-login on expiry)
5. `await ditto.auth.login(token, Authenticator.DEVELOPMENT_PROVIDER)`
6. `ditto.sync.start()`

### 7.2 Connection flow (Small Peers Only mode)

Same lifecycle as server mode minus auth login. Wiring of the optional shared-secret key into `DittoConfig` is to be confirmed during the SDK loadability spike (the quickstart only exercises server mode); design will be amended if the API differs from expectations.

### 7.3 Subscriptions

Per-DB `Map<subscriptionId, registeredSub>` in `DittoManager`. On register, call `ditto.sync.registerSubscription(query)` and store the handle. On unregister, call `sub.cancel()`. Persisted metadata in `globalState['dittoSubscriptions.v1.${dbId}']`. On reconnect, all stored subscriptions for that DB are re-registered.

### 7.4 Peer presence

Use `ditto.presence.observe(callback)` to drive the peer listing panel. The callback delivers a `PresenceGraph` snapshot containing local peer info + remote peers with connection arrays. Snapshot is throttled (e.g., 250 ms coalesce) before being pushed to the webview to avoid render storms.

### 7.5 Constraints

- BLE and AWDL are **always off** in VS Code host (entitlement requirements).
- LAN (TCP + mDNS + multicast) and Cloud sync are **always on**.
- Persistence directory is per-config: deleting a database config also deletes its persistence directory (`fs.rm(..., { recursive: true })`).

## 8. POC milestones

| # | Milestone | Notes |
|---|---|---|
| 1 | **Spike: SDK loadability** | Minimal extension activation that opens Ditto with quickstart credentials, INSERTs to a `vsce_smoke` collection, reads back via observer, logs to output channel. **Hard gate before any UI work.** |
| 2 | Extension skeleton | esbuild config, tsconfig, package.json contributes, empty TreeView, "Register Database" command stub |
| 3 | Storage layer | `ConfigStore`, `SecretStore`, unit tests, tree refresh on save / delete |
| 4 | `DatabaseEditorPanel` | Lit form, both auth modes, IPC save flow, validation |
| 5 | `DittoManager` | Singleton: open/close, login, sync lifecycle, per-config persistence dirs |
| 6 | `PeerListingPanel` (Connected Peers tab) | LocalPeerInfoCard + remote peer cards from presence observer; "Coming soon" placeholder for graph tab |
| 7 | Subscriptions | Tree leaves + `SubscriptionEditorPanel` + register/cancel via SDK + persistence |
| 8 | Polish & demo README | Error handling pass, README, manual `vsce package` |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Ditto NodeJS SDK native modules don't load in Electron Node | Spike (milestone 1) is a hard gate. Fallback: prebuilt-electron rebuilt binaries, or a documented postinstall step. |
| Native `.node` files break esbuild bundling | Mark `@dittolive/ditto` as `external`; copy native files as assets; require by absolute path. |
| LAN multicast permission prompt or block on Windows / Linux | Document; cloud-only sync remains as fallback. |
| Token expiration handler edge cases | Lift quickstart code verbatim during spike, refine in `DittoManager` later. |
| Presence observer payload shape unknown | Confirmed during milestone 6; design amended if needed. |

## 10. Open questions / future work

- Confirm `ditto.presence.observe` API surface and `RemotePeer` shape during DittoManager implementation (milestone 6).
- Confirm Small Peers shared-secret-key wiring through `DittoConfig` during the spike (milestone 1).
- Future: implement Presence Graph (force-directed network viz, e.g. vis-network or D3).
- Future: collections viewer, query editor, observers tab, log viewer.
- Future: Marketplace publication pipeline.
