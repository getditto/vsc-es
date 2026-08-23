# Developer Guide

This guide is for engineers joining the Ditto Edge Studio VS Code extension.
It explains what the product is, how the codebase is organized, how to run
and extend it, and the conventions worth knowing before opening a PR.

If you only want to *run* the extension as a user, read [`README.md`](../README.md)
and [`MANUAL_TESTING.md`](MANUAL_TESTING.md) instead.

AI coding agents should start with [`AGENTS.md`](../AGENTS.md). Codex also
discovers the repo-local `develop-ditto-edge-studio` skill under
`.agents/skills/`; invoke it explicitly as `$develop-ditto-edge-studio` when
you want the full feature, debugging, testing, or review workflow.

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
├── .agents/skills/              # repo-local Codex workflows
├── AGENTS.md                    # durable agent conventions and verification
├── docs/
│   ├── Developer.md            # ← this file
│   └── MANUAL_TESTING.md       # Extension Development Host recipes
└── dist/                       # build output (gitignored)
```

`docs/superpowers/` contains original Claude-era design specs and implementation
plans. They are historical: current code, `AGENTS.md`, and this guide are the
source of truth. Do not follow old agent directives or commit snippets from
those plans unless a task explicitly asks you to reproduce that history.

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

Before `sync.start()`, `DittoManager.connect()` applies configured collection
sync scopes through `src/ditto/sync-scopes.ts`. Keep that call after the SDK is
opened and authenticated/licensed, but before sync starts and before persisted
subscriptions are registered. Ditto resets this system setting on every new
instance, so it must be reapplied on every connection.

The same pre-sync boundary applies startup system settings stored in
`advancedConfig.systemSettings`. Each entry is a typed parameter/value pair;
parameter names are validated before being interpolated and values are passed
as DQL query arguments. The database editor uses `SHOW ALL` to offer typed
choices only when editing the active connection. New and disconnected
connections use the same structured rows with a manually selected type. Saving
changes for an active connection never mutates the live SDK instance: the UI
and save notification direct the user to disconnect and reconnect.

System-setting names and values are stored with the database config in
`globalState`, not `SecretStorage`. They must never contain tokens, keys,
passwords, or other credentials.

### 4.3 Storage layers

| Key | Where | Why |
|---|---|---|
| Database configs | `globalState['dittoConfigs.v1']` | Non-secret metadata |
| Secrets (token, secret key, http API key) | `SecretStorage`, key `ditto.<configId>.<which>` | OS-native vault |
| Subscriptions | `globalState['dittoSubscriptions.v1.<dbId>']` | Per-database list |
| Ditto local persistence | `globalStorageUri/dittoData/<configId>/` | Per-config isolation; deleted with the config |

Versioning is handled by the `.v1` suffix on the keys — bump it and add a
migration function inside the relevant store if the shape ever changes.

Connection records may include an optional `advancedConfig`. Collection sync
scopes live there as an ordered list of collection/scope pairs so the database
editor can add and remove rows without losing the user's ordering. The field is
optional for backward compatibility; an absent value means the SDK default
(`AllPeers`) applies to every collection.

Startup system settings are another optional ordered list under
`advancedConfig`. Supported value types are boolean, integer, string, and JSON.
An absent list means no user overrides. `USER_COLLECTION_SYNC_SCOPES` and
`DQL_STRICT_MODE` are reserved because dedicated editor controls own them.

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

npm run validate           # typecheck + lint + unit tests (what CI runs)
npm run typecheck          # tsc --noEmit
npm run lint               # eslint . (add --fix via `npm run lint:fix`)
```

**`npm run build` does not typecheck.** esbuild strips types without checking
them, so a build can succeed on code `tsc` rejects. `npm run typecheck` is a
separate gate, not a redundant one.

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

This runs `node --test` over `src/test/*.test.ts` and
`src/test/webview/*.test.ts` with two import shims:

- `tsx` — TypeScript execution (no compile step). Note that it does **not**
  typecheck; `npm run typecheck` is what does.
- `scripts/register-vscode-stub.mjs` — makes `import 'vscode'` resolve to
  `scripts/vscode-stub.mjs` so extension-host code can be exercised without an
  Extension Development Host.

### 6.2 What the stub covers

`scripts/vscode-stub.mjs` fakes `Memento`, `SecretStorage`, `EventEmitter`,
`TreeItem`, `Uri`, `workspace.getConfiguration`, `window.showXMessage`,
`commands.executeCommand`, and **webview panels**.

The webview-panel fake is the interesting one. `window.createWebviewPanel`
returns a recorder, and every panel it creates is pushed onto the exported
`createdWebviewPanels` array. A test reads the panel its subject created and
drives it:

```ts
const panel = createdWebviewPanels[0];
panel.fireMessage({ type: 'query.run', text: 'SELECT 1' }); // webview → host
panel.fireViewState(true);                                  // focus change
panel.dispose();                                            // the user's X button
assert.deepEqual(panel.webview.posted, [ /* host → webview */ ]);
```

Those recorders are module-global, mirroring the real editor's panel registry —
call `__resetStub()` at the top of each test so panels from an earlier test
don't leak into your assertions.

### 6.3 What's tested

- Stores (`ConfigStore`, `SecretStore`, `SubscriptionStore`, `OpenPanelsTracker`)
  — full CRUD against the in-memory `Memento`/`SecretStorage`.
- `DatabaseTreeProvider` — node-tree shapes for idle / active databases.
- `peer-info` — presence + sync_status merge, order preservation,
  dominant-connection-type priority.
- Lifecycle: `switch-orchestrator`, and `QueryEditorPanel`'s dispose/tracker-slot
  semantics against the webview fake.
- Safety-critical pure layers extracted for exactly this purpose:
  `query-projection` (the `MAX_QUERY_ROWS` cap and the dematerialize
  discipline), `HttpQueryService`'s response cap / status classification /
  settle-once guard, `dql-identifier`, `secrets`, `PatternEngine`.
- Lit components under `src/test/webview/` via jsdom, including a recording
  canvas 2D context (`src/test/webview/setup.ts`) that tracks the affine
  transform, so the presence graph's paint positions are assertable rather
  than merely reached.

The SDK-touching parts of `DittoManager` — anything needing a live `Ditto`
instance — are still covered by the recipes in
[`MANUAL_TESTING.md`](MANUAL_TESTING.md) and the integration suites.

### 6.4 Adding a test

Add a `*.test.ts` file under `src/test/` (or `src/test/webview/` for a Lit
component), import from the relative source path with the `.js` extension (TS
NodeNext convention), and use `node:test`.

If your code touches `vscode` APIs not yet in the stub, extend
`scripts/vscode-stub.mjs` rather than mocking ad-hoc.

When SDK-dependent logic needs coverage, prefer extracting the decision into a
pure module over mocking the SDK — `src/ditto/query-projection.ts` is the
worked example: the row cap and the profile-envelope handling moved out of
`DittoManager` specifically so they could be tested without a store.

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
  fix the call site. Detection (`containsSecret`) and redaction
  (`redactSecrets`) live in `src/logging/secrets.ts` and must cover the same
  patterns: a detected-but-unredacted secret still reaches the sinks and the
  log export.
- **Quote identifiers going into DQL.** DQL has bind parameters for values but
  not for identifiers, so collection/field/index names get concatenated into
  the statement. Route them through `quoteIdentifier` / `quoteFieldPath` in
  `src/ditto/dql-identifier.ts`, which backtick-quotes and doubles embedded
  backticks. Do not write a character whitelist: Ditto permits any name once
  quoted, so a whitelist locks users out of collections they legitimately have
  (`order-items`) while still admitting names that are invalid *unquoted*
  (a leading digit).
- **Never `throw` from a `finally` block.** It replaces whatever exception was
  already propagating instead of deferring to it. Record the error, run the
  cleanup, then decide what to rethrow — see
  `DittoManager.applyTransportConfigLocked`, which had exactly this bug: a
  failing recovery `sync.start()` discarded the real cause.
- **Async webview handlers go through `webviewMessageHandler`**
  (`src/panels/webview-utils.ts`). `onDidReceiveMessage` discards the
  listener's return value, so both `(msg) => this.handle(msg)` and
  `(msg) => { void this.handle(msg); }` drop the rejection — the user sees the
  action silently do nothing and nothing reaches the log.
- **Webview host subscriptions use the `HostMessages` controller**
  (`webview-ui/shared/messaging.ts`). Lit owns its connect/disconnect hooks, so
  there is no way to write the subscribe half and forget the dispose half. VS
  Code re-parents webview panels between editor groups, which makes that
  omission a real leak rather than a theoretical one.
- **CSP nonces come from a CSPRNG.** `nonce()` in
  `src/panels/webview-utils.ts` uses `crypto.randomBytes`. `script-src
  'nonce-…'` is the only thing standing between injected markup and script
  execution, and `Math.random()` is guessable.

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

- **Connection address & approximate distance** — SwiftUI shows these; the
  Node SDK's `Connection` type doesn't currently expose them. Revisit when
  the SDK does.
- **Live-observe Query Editor mode** — currently one-shot `execute` only.
  Adding `registerObserver` would be ~10 host lines + a Lit toggle.
- **Identity webhook config from the IDE** — not implemented; SwiftUI app
  doesn't have it either.
- **Marketplace publication pipeline** — manual `vsce package` only.
- **No marketplace icon.** `package.json` has no top-level `icon`, so `vsce`
  warns and the listing renders without one. It needs a 128×128 PNG;
  `resources/ditto-icon.svg` is `fill="currentColor"` and themed by the
  activity bar, so rasterising it gives a mark that is invisible on one
  background or the other. This is a design task, not a build one.
- **`retainContextWhenHidden: true` on every panel.** The VS Code docs call
  this expensive and recommend serialising state instead. It is deliberate
  here: no `WebviewPanelSerializer` is registered, and panel state is instead
  persisted per-database through `OpenPanelsTracker` and replayed by the switch
  orchestrator's restore path. That covers reconnect but not a window reload,
  and the memory cost is real and paid per open panel. Revisiting means moving
  each panel to `getState`/`setState` (the API is already declared in
  `webview-ui/shared/messaging.ts` and unused) — a per-panel migration with no
  current test coverage of panel state, so it wants doing deliberately.
- **ReDoS on user-supplied log patterns is mitigated heuristically.**
  `PatternEngine` rejects over-long patterns and nested quantifiers from *user*
  pattern files, because `scan()` runs on the extension host's only thread
  against every log line and a RegExp cannot be time-bounded there. A
  determined pathological pattern that dodges the heuristic would still stall
  the host. A worker thread is the real fix.

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

---

## 11. Get Quickstarts feature

The implementation lives in `src/quickstart/`:

- `quickstart-projects.ts` is the single source of truth for what we know
  about the upstream `getditto/quickstart` repo: the project list, the three
  hard-coded `.env` destinations (root, `flutter_app/`, `go-tui/`), and the
  edge-server YAML path. Update this file when upstream restructures or
  adds a new per-project `.env` destination. Mirrors SwiftUI Edge Studio's
  `QuickstartDownloadService.swift` — keep the two lists in sync.

- `QuickstartService.ts` does git ops via an injected `GitRunner`. The
  default `createNodeGitRunner()` is backed by `child_process.spawn` using
  the argument-array form (no shell). Tests inject a stub `GitRunner` so
  the suite never spawns a real subprocess.

- The flow controller is the `dittoVsce.getQuickstarts` registration in
  `src/extension.ts`. It owns the dialog tree and the `withProgress`
  notification; the service stays UI-free.

### 11.1 Why we emit `DITTO_APP_ID` and `DITTO_PLAYGROUND_TOKEN`

The upstream quickstart code still reads the old env-var names even after
Edge Studio's UI rename to "Database ID" / "Development Token". A file
using the new names would not be loaded by any quickstart project. When
upstream renames, update the template in `QuickstartService.ts:renderEnvContent`
and bump the comment.

### 11.2 Future iteration: auto-discovery

If the hard-coded list of `.env` destinations stops scaling (e.g. upstream
adds many new per-project envs at once), switch the resolution to scan for
every `.env.sample` in the cloned tree and write a sibling `.env` next to
each one. The single `renderEnvContent` template plus the destination
list are the only things that need to change — the rest of the service
keeps the same shape.

---

## 12. Query Profile (PROFILE)

The Query Editor's "Profile" view tab captures Ditto's `PROFILE` execution-plan envelope for SELECT statements on the **Local** run path.

- Triggered automatically: when the user runs a SELECT on Local that doesn't already start with `PROFILE`, `DittoManager.executeQuery` prefixes `PROFILE ` and pops the trailing `~request_profile` item before projecting rows.
- HTTP mode never profiles (PROFILE is local-only for v1).
- Envelope parsing lives in `src/ditto/QueryProfileParser.ts`. Parser is forgiving: missing fields default to zero/empty so the viewer renders something for partial envelopes.
- Time formatting (`ms`/`µs`/`ns` auto-scale) lives in `src/util/profileTimeFormatter.ts`.
- The Profile tab has two sub-modes: **Card** (recursive nested operator cards) and **Plan** (top-down boxes-and-lines tree). Both consume the same parsed `QueryProfile`.
- Hotspot tint threshold: an operator's box turns orange when its `execNs` share of the plan-total exec exceeds 50% (see `HOTSPOT_THRESHOLD` in `webview-ui/query/profile-plan-tree.ts`).
- See `docs/profile-card.png` and `docs/profile-plan.png` for the expected visual layout.

---

## 13. Observers

The Observers feature lets users register a DQL query and watch it fire in real time, showing diffs (insertions / updates / moves / deletes) between firings.

- **Persistence:** observer metadata (name + query) lives in `ObserverStore`, a per-database VS Code memento (`dittoObservers.v1.<databaseId>`). Live SDK observers are NOT persisted — observers always start inactive when a panel opens.
- **SDK integration:** `DittoManager.registerObserver(query, callback)` wraps `ditto.store.registerObserver` and the SDK's `Differ` to produce `{rows, insertions, updates, deletions, moves}` per firing.
- **Panel:** `ObserverPanel` owns the SDK observer's lifetime — disposing the panel cancels the observer. Each panel maintains an `ObserverEventStore` ring buffer (500 events, FIFO eviction).
- **Coalescing:** events are batched on the host with a 100ms flush window before being posted to the webview. Matches the SwiftUI app's `observedEventFlushInterval`.
- **UI reuse:** the bottom-pane detail view uses the existing `<json-viewer>` and the new shared `<ditto-result-table>` (also consumed by the Query Editor). No bespoke detail-view code.
- **Help:** `resources/help/observe.md` → rendered to `dist/webview-ui/help/observe.html` → loaded into the Inspector via `inspector.helpHtml`.
