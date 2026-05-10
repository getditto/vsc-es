# Developer Guide

This guide is for engineers joining the Ditto Edge Studio VS Code extension.
It explains what the product is, how the codebase is organized, how to run
and extend it, and the conventions worth knowing before opening a PR.

If you only want to *run* the extension as a user, read [`README.md`](../README.md)
and [`MANUAL_TESTING.md`](MANUAL_TESTING.md) instead.

---

## 1. What this is

A VS Code extension that hosts the `@dittolive/ditto` Node SDK inside VS
Code's Electron Node runtime, exposing a developer UX modeled on the macOS
SwiftUI Ditto Edge Studio. From the user's perspective: register a database,
connect, subscribe, see peers, run queries.

The extension is published as a `.vsix` (built via `npm run package`).

### Reference apps

When in doubt about intended UX or data shape, two existing apps are the
source of truth:

- **SwiftUI Ditto Edge Studio**: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/`
  — peer card visuals, sync-status semantics, overall layout.
- **Ditto NodeJS quickstart**: `/Users/labeaaa/Developer/quickstart/javascript-tui/`
  — canonical SDK lifecycle (open → transport config → login → sync.start).

The Ditto SDK type definitions live in
`node_modules/@dittolive/ditto/types/ditto.d.ts`. They are the most
authoritative reference for SDK surface area.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict, NodeNext, ES2022 target) |
| Extension host bundle | esbuild → CJS, `dist/extension.js` |
| Webview UI | [Lit 3](https://lit.dev) — web components in shadow DOM |
| Webview bundles | esbuild → IIFE per panel, `dist/webview-ui/<panel>.js` |
| Secret storage | `vscode.SecretStorage` (OS keychain) |
| Non-secret state | `vscode.ExtensionContext.globalState` |
| Per-database SDK persistence | `globalStorageUri/dittoData/<configId>/` |
| Icon font | `@vscode/codicons` (copied into `dist/webview-ui/`) |
| Tests | Node's built-in test runner (`node --test`) + a `vscode` API stub |

The root `package.json` is `"type": "module"` so source files can use ESM
imports during dev. `esbuild.config.mjs` writes a `dist/package.json`
declaring `"type": "commonjs"` to keep VS Code's loader happy with the CJS
extension bundle.

---

## 3. Source layout

```
ditto-vsc-es/
├── src/                        # extension host (Node)
│   ├── extension.ts            # activate(): wires stores, manager, tree, commands
│   ├── ditto/
│   │   ├── DittoManager.ts     # singleton wrapping the Ditto SDK lifecycle
│   │   └── peer-info.ts        # pure merge logic (presence + sync_status → snapshot)
│   ├── tree/
│   │   ├── DatabaseTreeProvider.ts
│   │   └── DatabaseTreeItem.ts # discriminated union of node kinds
│   ├── panels/
│   │   ├── DatabaseEditorPanel.ts
│   │   ├── SubscriptionEditorPanel.ts
│   │   ├── PeerListingPanel.ts
│   │   ├── QueryEditorPanel.ts
│   │   └── webview-utils.ts    # shared HTML scaffold + CSP for panels
│   ├── storage/
│   │   ├── ConfigStore.ts      # database configs in globalState
│   │   ├── SecretStore.ts      # token/key/api-key in SecretStorage
│   │   └── SubscriptionStore.ts# subscriptions in globalState
│   ├── ipc/messages.ts         # typed postMessage contracts (one section per panel)
│   ├── models/DittoConfig.ts   # shared types: StoredDittoConfig, PeerInfo, etc.
│   └── test/                   # *.test.ts — node:test + register-vscode-stub
├── webview-ui/                 # Lit components (shipped to webviews)
│   ├── editor/                 # database registration form
│   ├── subscription/           # subscription form
│   ├── peers/                  # peer listing grid (codicons, gradients, animations)
│   ├── query/                  # DQL query editor + table/JSON results
│   └── shared/messaging.ts     # acquireVsCodeApi() wrapper
├── scripts/register-vscode-stub.mjs # makes `import 'vscode'` work in node:test
├── esbuild.config.mjs          # two contexts: extension + webview-ui
├── package.json                # contributes (commands, views, menus)
├── docs/
│   ├── Developer.md            # ← this file
│   └── MANUAL_TESTING.md       # T1–T10 end-to-end recipes
└── dist/                       # build output (gitignored)
```

`docs/superpowers/` (gitignored) contains the original design specs and
implementation plans the project was built from. They are historical — the
code is the source of truth now.

---

## 4. Architecture

### 4.1 Two processes

VS Code extensions split into two runtimes:

- **Extension host** — Node.js. Long-lived. Owns the Ditto SDK instance, all
  state, and all I/O. Code under `src/`.
- **Webviews** — sandboxed browser pages. One per visible panel. Talk to the
  host only via `postMessage`. Code under `webview-ui/`.

Webviews **never** import the SDK or `vscode`. They render and emit messages.
The host receives messages, mutates state, and pushes new state back.

### 4.2 The state machine

`DittoManager` (in `src/ditto/DittoManager.ts`) is a singleton owned by the
extension. At most one Ditto instance is open at a time. Status transitions:

```
idle ──connect()──▶ activating ──ready──▶ active
active ──disconnect()──▶ stopping ──▶ idle
{activating, active} ──failure──▶ error ──▶ idle (after disconnect)
```

`onStatusChange` fires on every transition; the tree provider subscribes and
calls `refresh()` so the dot icon and child visibility track state.

When a database becomes `active`, three SDK read paths spin up in parallel:

1. **Presence push** — `ditto.presence.observe(callback)` with 250 ms
   coalescing. Drives the peer grid.
2. **Sync status observer** — DQL subscription + observer on
   `__sync_status`. Drives status dots, "synced to commit", "last update".
3. **One-shot small-peer info** — `ditto.store.execute('SELECT ... FROM
   __small_peer_info')` once, cached for the session. Fills SDK
   language/platform/version on the local peer card.

The merge of these three sources into a `PeerListSnapshot` is pure logic in
`src/ditto/peer-info.ts` — fully unit-testable, no `vscode` import. See
`mergePeerList()` and `dominantConnectionType()`.

### 4.3 Storage layers

| Key | Where | Why |
|---|---|---|
| Database configs | `globalState['dittoConfigs.v1']` | Non-secret metadata |
| Secrets (token, secret key, http API key) | `SecretStorage`, key `ditto.<configId>.<which>` | OS-native vault |
| Subscriptions | `globalState['dittoSubscriptions.v1.<dbId>']` | Per-database list |
| Ditto local persistence | `globalStorageUri/dittoData/<configId>/` | Per-config isolation; deleted with the config |

Versioning is handled by the `.v1` suffix on the keys — bump it and add a
migration function inside the relevant store if the shape ever changes.

### 4.4 IPC contract

All host ↔ webview traffic is typed in `src/ipc/messages.ts`. Each panel has
its own `*In` (webview → host) and `*Out` (host → webview) discriminated
union. The webview-side wrapper is `webview-ui/shared/messaging.ts`
(`acquireVsCodeApi()` and a typed `postMessage`).

Pattern when adding a new panel: add the message types to `messages.ts`,
have the host call `webview.postMessage` with the typed payload, and have
the Lit element listen on `window.addEventListener('message', ...)`. Both
sides should pattern-match on `msg.type`.

### 4.5 Tree

`DatabaseTreeProvider` implements `TreeDataProvider<DatabaseTreeNode>`.
Nodes are a discriminated union (`kind: 'database' | 'subscriptionsParent'
| 'subscription' | 'peerListing' | 'queryEditor'`). Children only exist
under an `active` database — idle databases render as a single collapsed
row with no expand chevron. `getChildren()` switches on `kind`.

Inline / contextual menus live in `package.json` under `contributes.menus`,
keyed by `viewItem` regex (e.g. `viewItem == database.active`).

---

## 5. Build & dev loop

```sh
npm install                # one-time
npm run build              # full build → dist/
npm run watch              # incremental rebuilds (preferred during dev)
```

Then in VS Code: press `F5`. A second VS Code window (the Extension
Development Host) launches with the extension loaded. To pick up code
changes: focus that window and `Cmd+R` (macOS) / `Ctrl+R` reloads it.

The build does two things in parallel:

1. Extension host bundle: `src/extension.ts` → `dist/extension.js` (CJS).
   `vscode` and `@dittolive/ditto` are external — VS Code provides the
   former; the SDK's native binary is loaded from `node_modules/` at
   runtime.
2. Webview bundles: `webview-ui/<panel>/main.ts` → `dist/webview-ui/<panel>.js`
   (IIFE, browser target). Codicons CSS + TTF are copied alongside them.

Output is visible in the host's `View → Output → Ditto Edge Studio` channel.

---

## 6. Testing

### 6.1 Running tests

```sh
npm test
```

This runs `node --test src/test/**/*.test.ts` with two import shims:

- `tsx` — TypeScript execution (no compile step).
- `scripts/register-vscode-stub.mjs` — makes `import 'vscode'` resolve to a
  hand-rolled stub so storage/tree code can be exercised without an
  Extension Host. The stub mocks `Memento`, `SecretStorage`, `EventEmitter`,
  `TreeItem`, etc. Add to it as new APIs are needed.

### 6.2 What's tested

The existing suite covers the pure / decoupled layers:

- `ConfigStore`, `SecretStore`, `SubscriptionStore` — full CRUD against
  in-memory stub `Memento`/`SecretStorage`.
- `DatabaseTreeProvider` — node-tree shapes for idle / active databases.
- `peer-info` — merge logic between presence + sync_status, order
  preservation, dominant-connection-type priority.

Webview Lit components and the SDK-touching parts of `DittoManager` are
exercised manually via the recipes in [`MANUAL_TESTING.md`](MANUAL_TESTING.md).

### 6.3 Adding a test

Pure functions and stores: add a `*.test.ts` file under `src/test/`, import
from the relative source path with the `.js` extension (TS NodeNext
convention), use `node:test`'s `describe`/`it`.

If your code touches `vscode` APIs not yet in the stub, extend
`scripts/register-vscode-stub.mjs` rather than mocking ad-hoc.

---

## 7. How to add a feature

The cookbook below covers the most common extension points.

### 7.1 A new command

1. Add a `contributes.commands` entry to `package.json`.
2. If it shows in the tree's context/inline menu, add a
   `contributes.menus.view/item/context` entry with the right `when` clause.
3. In `src/extension.ts`, register the handler with
   `vscode.commands.registerCommand(...)` and push it onto
   `context.subscriptions`.

### 7.2 A new tree node kind

1. Extend the discriminated union in `src/tree/DatabaseTreeItem.ts`.
2. Update `getChildren()` in `DatabaseTreeProvider.ts` to return it under
   the right parent.
3. Update `getTreeItem()` to render its label, icon, `contextValue` (used
   by menu `when` clauses), and `command` (the click action).
4. Add a tree provider test for the new kind under `src/test/`.

### 7.3 A new webview panel

1. Create `src/panels/<Name>Panel.ts` modeled on `QueryEditorPanel.ts`.
   Use `webview-utils.ts` for the HTML scaffold and CSP.
2. Add IPC types to `src/ipc/messages.ts` (`<Name>In` / `<Name>Out`).
3. Create `webview-ui/<name>/main.ts` and `webview-ui/<name>/<name>-element.ts`.
4. Add the bundle entry to `esbuild.config.mjs`'s webview context.
5. Add a tree node + command to open the panel (see 7.1, 7.2).

### 7.4 A new SDK read path

The current three (presence, `__sync_status`, `__small_peer_info`) all live
in `DittoManager`. To add a fourth:

1. Add a new private observer/handle field. Initialize in `connect()` after
   `sync.start()`. Cancel and null-out in `disconnect()`'s `finally` block —
   leaks are easy here.
2. If the new source feeds the peer snapshot, extend `peer-info.ts` and add
   tests there, not in `DittoManager`. Keep merge logic pure.
3. Re-emit through whatever onChange/event mechanism the consumer panel
   uses. `firePresence(buildSnapshot())` for peer listing.
4. Guard against late callbacks after `disconnect()` — the SDK can deliver
   one more emission while teardown is in flight. The pattern in
   `DittoManager` is `if (this.activeDitto !== ditto) return;` at the top
   of every callback.

---

## 8. Conventions

- **Imports** end in `.js` even for `.ts` files. NodeNext requires it.
- **No `(any)` casts** to plug SDK gaps. Use a narrow `as` at the use site
  with a comment explaining the type-defs vs runtime mismatch. The original
  presence-graph code had broad `any` casts — they were the bug.
- **Keep `peer-info.ts` (and any future merge logic) pure.** No `vscode`
  import. Guarantees node:test can exercise it.
- **One Ditto instance, ever.** Switching active databases goes through
  `disconnect()` first. `DittoManager` enforces this.
- **Coalesce noisy SDK events** before posting to webviews (presence
  observer is 250 ms). Webview re-renders are not free.
- **Use codicons, not emoji or external icon fonts.** The font is already
  bundled via `@vscode/codicons`. Class names are listed at
  https://microsoft.github.io/vscode-codicons/dist/codicon.html.
- **Never log secrets.** The Logger output is user-visible. If you need
  to log a config, log a config ID instead of a token; the runtime guard
  in `src/logging/Logger.ts` throws in `Development`/`Test` mode and
  replaces with `[redacted]` in `Production`. Don't rely on the guard —
  fix the call site.

### Attachments

- Right-click on a row in the Query Editor's results (Table view OR
  JSON view) opens an in-webview context menu with **Add Attachment…**
  and **Delete Attachment…**. The menu is rendered by the Lit element
  itself — VS Code's native context-menu APIs (`menus.editor/context`
  etc.) work at the TreeView/editor level and do NOT reach inside
  webviews, so we paint our own popover styled with the
  `--vscode-menu-*` theme tokens.
- The host derives the target collection from the last-run DQL via
  `extractCollectionName` and the `_id` from the row JSON. Joins or
  multi-collection queries are refused (single user collection only).
- **File-type allowlist** for `Add Attachment`: images, audio, video,
  PDF, text-like files, and zip archives (see
  `ATTACHMENT_FILE_FILTERS` in `QueryEditorPanel.ts`). Executables
  and shell scripts are explicitly excluded — the picker filters
  them out and the host re-validates the chosen extension as
  defense-in-depth in case a user types a path manually.
- Soft warn at 10 MB, hard refuse at 20 MB (mirrors SwiftUI). Local
  mode uses `ditto.store.newAttachment(path, metadata)` + DQL
  `UPDATE col SET field = :att WHERE _id = :docId`. HTTP-mode upload
  is a follow-up; for now Add/Delete require the connection to be
  active in local mode.
- Viewing attachments — already wired in
  `webview-ui/inspector/attachment-viewer-element.ts`: detects
  `_meta`-shaped tokens in the selected row's JSON, renders inline
  for known image MIME types, otherwise offers a Save action.

### Logging

- Use the project Logger (DI'd from `extension.ts` activate); do NOT call
  `console.*` or instantiate a separate `OutputChannel`.
- Each subsystem creates its own child logger at construction:
  `this.log = parentLogger.withTag('ext:Foo')`.
- Pick the right level per the rubric (see
  `docs/superpowers/specs/2026-05-09-logging-design.md` § 2.4):
  - `error` — failures the user must know about
  - `warn`  — recoverable issues, degraded paths
  - `info`  — lifecycle events
  - `debug` — per-operation detail
  - `trace` — per-event detail
- Webview code uses `webviewLogger` from `webview-ui/shared/logger.ts`;
  messages bridge to the host's logger via the `LogIn` IPC type
  (`src/ipc/messages.ts`).

---

## 9. Known gaps & future work

These are tracked as future work in the original design specs (now
gitignored under `docs/superpowers/`):

- **Presence Graph tab** — currently a "Coming soon" placeholder. SwiftUI
  uses SpriteKit; web equivalent would likely be vis-network or a D3 force
  layout in a webview.
- **Connection address & approximate distance** — SwiftUI shows these; the
  Node SDK's `Connection` type doesn't currently expose them. Revisit when
  the SDK does.
- **Live-observe Query Editor mode** — currently one-shot `execute` only.
  Adding `registerObserver` would be ~10 host lines + a Lit toggle.
- **Query history** — not persisted today. Would live in `globalState`
  with bounded length.
- **Identity webhook config from the IDE** — not implemented; SwiftUI app
  doesn't have it either.
- **Marketplace publication pipeline** — manual `vsce package` only.

---

## 10. Quick reference — touchpoints by task

| If you're changing… | Read first |
|---|---|
| Database registration form | `webview-ui/editor/`, `panels/DatabaseEditorPanel.ts`, `ipc/messages.ts` § Editor |
| Connect lifecycle / SDK calls | `ditto/DittoManager.ts`, quickstart `cli.js` |
| Peer card visuals | `webview-ui/peers/peers-element.ts` |
| Peer data shape / merge | `ditto/peer-info.ts`, `models/DittoConfig.ts`, `test/peer-info.test.ts` |
| Query editor UI / behavior | `webview-ui/query/`, `panels/QueryEditorPanel.ts` |
| Tree view / context menus | `tree/`, `package.json` contributes |
| What gets persisted | `storage/`, `models/DittoConfig.ts` |
| Build / asset pipeline | `esbuild.config.mjs` |
| Test infrastructure | `scripts/register-vscode-stub.mjs`, `package.json` test script |
