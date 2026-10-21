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
│   │   └── peer-info.ts        # pure merge logic (presence + sync metrics → snapshot)
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
│   ├── mcp/
│   │   ├── McpServerController.ts  # lifecycle: per-connection on/off, port moves, status cmd
│   │   ├── McpServerService.ts     # loopback HTTP, sessions, body cap, DNS-rebinding guard
│   │   ├── define-tool.ts          # a tool is a data record over the shared service graph
│   │   ├── registry.ts             # registerAllTools: ToolDef → MCP SDK registrations
│   │   ├── tools-*.ts              # the 31 tools, one file per domain
│   │   └── resources.ts            # the 6 read-only ditto:// resources
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
2. **Sync metrics refresh** — a one-shot `SELECT * FROM
   system:data_sync_info` inside every presence flush
   (`refreshSyncMetrics`). Drives status dots, "synced to commit", "last
   update". This is deliberately not a live observer: `system:*`
   collections don't accept sync subscriptions, and the earlier
   `__sync_status` observer was silently failing.
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
the Lit element subscribe through the `HostMessages` controller in
`webview-ui/shared/messaging.ts` — never a hand-written
`window.addEventListener('message', ...)`: VS Code re-parents webview
panels between editor groups, and an undisposed listener means every later
message is handled once per past mount. Both sides should pattern-match on
`msg.type`, with the host-side handler wrapped in `webviewMessageHandler`
(`src/panels/webview-utils.ts`) so a rejected promise surfaces as an error
toast instead of a silent no-op.

The shared webview receiver validates the message's exact origin against
`window.origin`. Do not compare `event.source` to `window.parent`: VS Code's
injected API sets `window.parent = window`, while messages come from the
outer frame. That comparison broke all host-to-webview messages during 0.9.5 validation.
The jsdom harness models these distinct windows, and the load integration
suite exercises the bundled registration form over the real VS Code transport.

### 4.5 Tree

`DatabaseTreeProvider` implements `TreeDataProvider<DatabaseTreeNode>`.
Nodes are a discriminated union over `kind` (database, per-feature leaf
rows, and parent grouping rows — the union lives in
`src/tree/DatabaseTreeItem.ts` and is the source of truth; don't copy it
into docs). Children only exist
under an `active` database — idle databases render as a single collapsed
row with no expand chevron. `getChildren()` switches on `kind`.

Inline / contextual menus live in `package.json` under `contributes.menus`,
keyed by `viewItem` regex (e.g. `viewItem == database.active`).

### 4.6 The embedded MCP server

Edge Studio can expose the active database to AI agents over the Model
Context Protocol. The split of responsibilities:

- **`McpServerController`** owns policy and lifecycle. The on/off switch is
  **per connection** (`advancedConfig.mcpServerEnabled`, default off) — it
  follows the active connection through connect/switch/disconnect and editor
  saves, and restarts when the machine-scoped `dittoVsce.mcpServer.port`
  setting moves. Every transition is serialized through an internal promise
  queue (`enqueue`), because lifecycle beats, config events, and the
  Start/Stop commands can all land inside one async bind window. A
  `disposed` latch plus a post-bind re-check make `dispose()` safe against
  an in-flight bind.
- **`McpServerService`** owns the wire: loopback-only HTTP (`127.0.0.1` +
  best-effort `::1`), Streamable HTTP at `/mcp` plus the legacy HTTP+SSE
  pair (`/sse`, `/messages`) for SwiftUI-client parity, and `/health` for
  liveness. Sessions are stateful (`initialize` first, then the
  `Mcp-Session-Id` header); unknown/expired sessions are 404 before any tool
  runs so a retry after restart can't double-apply a mutation. Invariants
  that must not regress: 4 MiB body cap enforced pre-read and during the
  stream, a `Host`-header allowlist against DNS rebinding, tracked sockets +
  a 2 s bound so `stop()` drains without hanging, and no credentials in any
  tool output (metadata flags only; presence data ships as key counts, and
  `fetch_attachment` downloads stay inside the workspace / extension
  storage / OS temp with an atomic overwrite guard).
- **Tools are data records** (`define-tool.ts`): each `ToolDef` is
  `{name, description, zod schema, handler}`, and the handler receives the
  same service graph the panels use (`McpToolContext`) — a tool body is
  composition, not new machinery. `registry.ts` registers the records and
  forwards the SDK's abort `signal` so long-running tools (`watch_query`)
  honour client cancellation and session close. Handler throws become
  `isError` results at two layers. `src/test/mcp-tools.test.ts` locks the
  tool count and names — adding or removing a tool fails that suite on
  purpose, so surface changes are deliberate.
- **`resources.ts`** exposes read-only snapshots agents can fetch cheaply:
  `ditto://schema`, `ditto://peers`, `ditto://sync-status`,
  `ditto://subscriptions`, `ditto://observers`, `ditto://system-metrics`.
- **Copilot** picks the server up automatically via
  `registerCopilotMcpProvider` (`mcpServerDefinitionProviders` contribution)
  while it runs; other clients use the snippet from
  **Ditto: Copy MCP Client Config**.

Operator documentation lives in [`MCP_SERVER.md`](MCP_SERVER.md); the
scripted acceptance playbook is [`MCP_VALIDATION.md`](MCP_VALIDATION.md);
the agent-facing skill bundle ships under
`plugins/ditto-edge-studio-vscode/`.

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

This runs `node --test --expose-gc` over `src/test/*.test.ts` and
`src/test/webview/*.test.ts` with two import shims (`--expose-gc` backs the
leak-validation layer in §6.4):

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
- MCP layer — against `src/test/fixtures/mcp-fakes.ts`: every tool handler
  (`mcp-tools*.test.ts`), the controller's flag/port/dispose lifecycle
  against the shared vscode stub (`mcp-controller.test.ts`), real-SDK
  transports over loopback HTTP (sessions, 404-before-dispatch, body caps,
  DNS-rebinding 403s, stop-with-open-session port release in
  `mcp-server.test.ts`), and the per-connection Log Analyzer registry
  (`log-analyzer-registry.test.ts`).
- Lit components under `src/test/webview/` via jsdom, including a recording
  canvas 2D context (`src/test/webview/setup.ts`) that tracks the affine
  transform, so the presence graph's paint positions are assertable rather
  than merely reached.

The SDK-touching parts of `DittoManager` — anything needing a live `Ditto`
instance — are still covered by the recipes in
[`MANUAL_TESTING.md`](MANUAL_TESTING.md) and the integration suites.

### 6.4 Memory & lifecycle leak validation

Leak discipline is enforced in layers, cheapest first:

1. **Structural** — `panel-lifecycle-contract.test.ts` proves per panel that
   disposing removes every webview listener, that static teardown closes the
   webview, that dispose is idempotent, and that re-`show()` after dispose
   builds a fresh panel (stale-singleton check). A new panel `show()` without
   a contract entry fails the suite, so the layer can't silently skip a panel.
2. **Timer accounting** — `lifecycle-leaks.test.ts` patches the global timer
   functions per test and asserts construct→use→dispose leaves *zero*
   outstanding `setTimeout`/`setInterval` handles. Covers the recurring
   timers (`SystemMetricsService` poll, `ObserverPanel` flush coalescing,
   `LogAnalyzerService` trailing flush) — a leaked interval pins its closure
   forever and re-fires against dead objects.
3. **GC proofs** — same file, WeakRef assertions that a disposed
   `DebugSocketClient` / `ObserverPanel` / `LogAnalyzerService` is actually
   collected, not merely "dispose-called". Includes a negative control (an
   object rooted in a live `Set` must NOT be reported collected) so the
   harness can't degrade into vacuity.
4. **Heap flattening** — 400 real socket connect/query/disconnect cycles
   against an in-process server assert the post-warmup heap stays flat,
   catching accumulation leaks (reachable-but-growing containers) that the
   layers above can't see.

Layers 2–4 need `--expose-gc`, wired into both `npm test` and
`scripts/check-coverage.mjs`; without it the GC/heap tests skip cleanly.
Known benign retentions these tests work around rather than fail on: the
50 ms deferred-init timer every panel schedules (retains the panel until it
fires) and the `unref`'d ≤10 s timeout arms on `Ditto.close()` races — both
self-release; the assertions wait them out rather than forbid them.

### 6.5 Adding a test

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

The current three (presence push, the `system:data_sync_info` refresh inside
the presence flush, and `__small_peer_info`) all live in `DittoManager`. To
add a fourth:

1. Add a new private observer/handle field. Initialize in `connect()` after
   `sync.start()`. Cancel and null-out in `disconnect()`'s `finally` block —
   leaks are easy here.
2. If the new source feeds the peer snapshot, extend `peer-info.ts` and add
   tests there, not in `DittoManager`. Keep merge logic pure.
3. Re-emit through whatever onChange/event mechanism the consumer panel
   uses. `firePresence(buildSnapshot())` for peer listing.
4. Guard against late callbacks after `disconnect()` — the SDK can deliver
   one more emission while teardown is in flight. The pattern in
   `DittoManager` is an identity check against the session, not a
   truthiness check: `if (this.session?.ditto !== ditto) return;` both at
   callback entry AND after every `await`. During disconnect→reconnect a
   callback in flight resumes with `this.session` being the NEW session,
   so `if (!this.session) return;` alone would write the old DB's data
   into it.

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
- **Indexes are composite.** SDK 5.1 supports `CREATE INDEX … ON c (a ASC, b
  DESC)`. `DittoIndex.fields` is an ordered `IndexField[]` (`{ name, ascending }`),
  and the order is what decides which queries the optimizer can serve it with —
  it only uses a composite index from its leading key onwards. Never reorder or
  deduplicate it. All statement construction and `system:indexes` parsing lives
  in `src/ditto/index-builder.ts`; the generated name matches the SwiftUI Edge
  Studio app (`idx_<collection>_<field…>`, with `.`/space/`-` mapped to `_`) so
  an index made in one client is recognisable in the other. Note that
  `IF NOT EXISTS` compares names only, so creating an index whose name collides
  with a different definition would silently do nothing — `createIndex` queries
  `system:indexes` first and raises instead.
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
- **Download streams natively.** The Inspector's save-to-disk action
  goes through `DittoManager.saveAttachmentToPath`
  (`Attachment.copyToPath` under the hood), a native store-to-disk
  copy — the blob never becomes a JS `Uint8Array` in the extension
  host. Download is intentionally uncapped, so the old `att.data()` +
  `fs.writeFile` route (full blob in heap for the duration of the
  write) was a real memory spike for big attachments. The inline
  preview path keeps `att.data()` + the byte cache, bounded by
  `ATTACHMENT_PREVIEW_LIMIT` — see `src/inspector/InspectorViewProvider.ts`.

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
  and the memory cost is real and paid per open panel — bounded for the Query
  Editor by `MAX_OPEN_QUERY_TABS` (20 live tabs; the next `show()` refuses
  with a toast instead of growing memory without limit). Revisiting means moving
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
- **Payload cap:** the host ships at most `OBSERVER_ROW_CAP` (1000) rows per event (`data`), with the uncapped count in `totalRows`; the webview shows a "showing first N of M" banner when capped. The DQL subscription and the `Differ` still see the full result set — only the shipped payload is capped.
- **UI reuse:** the bottom-pane detail view uses the existing `<json-viewer>` and the new shared `<ditto-result-table>` (also consumed by the Query Editor). No bespoke detail-view code.
- **Help:** `resources/help/observe.md` → rendered to `dist/webview-ui/help/observe.html` → loaded into the Inspector via `inspector.helpHtml`.

---

## 14. SDK 5.1/5.2: system:metrics, ADVISE, debug socket, support bundles

### 14.1 System metrics (system:metrics)

System Metrics is its own screen (`src/panels/SystemMetricsPanel.ts`, `webview-ui/systemMetrics/`), fed by SDK 5.1's `system:metrics` DQL virtual collection. It split out of the Database Metrics panel in 0.9.5 because its data model is the inverse of that panel's: Database Metrics is an on-demand point snapshot (expensive filesystem walk behind an explicit Refresh), while `system:metrics` must poll continuously to mean anything. The two therefore sit as separate rows in the database tree — Database Metrics, then System Metrics, then Log Analyzer.

- **Startup-gated exporter.** The `metrics_exporter_virtual_collection_enabled` system parameter defaults to false and runtime `ALTER SYSTEM` changes are ignored — it's read once at open. Since SDK 5.2 the extension passes it through `DittoConfig`'s fourth constructor arg `systemParameters` (validated by the SDK at open); pre-5.2 the extension flipped the `DITTO_METRICS_EXPORTER_VIRTUAL_COLLECTION_ENABLED` env var around `Ditto.open`, and `withSystemMetricsEnv` in `src/ditto/SystemMetricsService.ts` survives as a test-only helper exercising that path. Setting: `dittoVsce.collectSystemMetrics` (default **on**, mirroring `collectProfiling`/`collectMetrics` — this is a dev tool and Info-level metrics are cheap). One accepted caveat, documented at the helper: the exporter is a process-wide `OnceLock`, so once enabled it stays enabled for later opens in the same process.
- **Flush-on-read.** Every `SELECT * FROM system:metrics` FLUSHES the registry: counter rows carry per-read `delta`, histogram rows `dcount`/`dsum`. Last-read rendering is therefore meaningless — `SystemMetricsService` polls (5 s) only while the panel is visible and accumulates deltas into since-connect running totals keyed by metric + sorted labels. Rows with no `key` are the exporter's `{status: "disabled"}` placeholder — `isExporterDisabledRows` detects it so the webview shows "enable the setting and reconnect" guidance instead of a dead table. Server-side GC can drop idle series; our accumulated totals simply stop growing for them.
- **Gauges (SDK 5.2, #NETW-1989).** The exporter emits no kind marker — counters and gauges share the `current`/`updates`/`delta` row shape — so `parseMetricRow` matches keys against the SDK's static `gauge!(…)` declarations (`KNOWN_GAUGE_KEYS`: `network.connections`, `quic.path.rtt/mtu`, the `udp_tx/rx` families, the dsoq callback-queue depths, `multiplexer.phy.last_*_at`, `multiplexer.virt.connections_gauge`, `transport.awdl.interface_up`). Gauge series TRACK the absolute `current` instead of accumulating deltas (a delta-sum of `interface_up` is nonsense), keep the signed `delta` as `periodDelta` (the webview renders negatives as a red ▼), and epoch-timestamp gauges render as an age ("12s ago"). A missed gauge key fails soft — it renders as a counter, cosmetically wrong but harmless. When the SDK adds gauges, add them to `KNOWN_GAUGE_KEYS`.
- **Wire shape.** `SysMetricsOut.sysMetrics.status` carries an explicit `SystemMetricsStatus` union (`working` / `settingDisabled` / `exporterDisabled` / `noConnection` / `unavailable`); `SysMetricsIn.sysMetrics.refresh` forces one immediate poll ahead of the cadence — see `src/ipc/messages.ts`. A mid-switch guard (`isExpectedActive`) discards polls that span a connection switch so another database's deltas never land in this panel's totals.
- **Dashboard** (`webview-ui/systemMetrics/system-metrics-element.ts`): parity with the SwiftUI Edge Studio's System Metrics screen — a centered namespace segment filter (All / Network `ditto.network.*` / Store `ditto.backend.*` / Query `ditto.query.*` (SDK 5.2, #QE-1155) / Sync `ditto.sync.*`+`ditto.replication.*` / Other) over EVERY reported series, each rendered as a row (prefix-stripped key + labels left; since-connect total and last-period delta right), the dsoq opened-vs-closed divergence banner, and a since/updated footer. A per-row info icon expands the series details (description, kind, unit; histograms also average and absolute max), and a per-row pin icon collects the series in a collapsible "Pinned" section above the filter; pins persist per connection in `globalState` (`src/storage/system-metrics-pins.ts`, wholesale `sysMetrics.setPins` replacements) so they survive panel closes and reconnects.
- **Help:** `resources/help/systemMetrics.md` → rendered to `dist/webview-ui/help/systemMetrics.html` → loaded into the Inspector via `inspector.helpHtml`.

### 14.2 ADVISE in the Query Editor

SDK 5.1's `ADVISE <SELECT …>` returns one row with an `advice` object: `{ statement, suggestedIndexes?: [{ collection, reason, statement }] }` where each suggestion's `statement` is a ready-to-run `CREATE INDEX IF NOT EXISTS …`; with nothing to advise on, `suggestedIndexes` is absent and a free-text `outcome` explains why (proved live in `src/test/advise-live.test.ts`).

- **Gating.** `isAdviseStatement` (`src/ditto/QueryProfileParser.ts`) keeps ADVISE out of the EXPLAIN side-trips in `DittoManager.executeQuery` and the Query Editor's HTTP explain path (`EXPLAIN ADVISE …` is not valid syntax). The auto-PROFILE prefix never applies anyway — ADVISE doesn't start with SELECT.
- **Extraction.** `extractQueryAdvice` (`src/ditto/advise.ts`) hoists the advice out of the rows onto `query.result.advice`, forgiving of forward-compatible shapes.

### 14.3 Debug Socket Console (`debug_socket`)

SDK 5.1's `debug_socket` system parameter makes a RUNNING APP's SDK listen on a
Unix domain socket for DQL (`ALTER SYSTEM SET debug_socket = '/path/to.sock'`).
The extension is the client of that socket — the Debug Console
(`Ditto: Open Debug Console`, `src/panels/DebugConsolePanel.ts`) is deliberately
independent of the extension's own Ditto connection: nothing needs to be
connected, or even registered.

- **Wire protocol** (per the SDK's `debug_socket` subsystem docs): newline-delimited
  text over the Unix socket. One DQL statement per line client → server; exactly one
  reply line per statement in order — either a single-line JSON array of result items
  (empty result = `[]`) or a line starting with `ERROR: <message>`. Blank lines are
  ignored; one connection stays open for many queries. `src/ditto/DebugSocketClient.ts`
  pairs replies with requests through a pending FIFO, since replies are positional.
- **Full DQL by default.** `dql_enable_remote_full_syntax` defaults true in 5.1, so
  mutations and `ALTER SYSTEM` run over the socket. The webview therefore renders a
  persistent live-mutation warning banner (not a dismissable tip — do not weaken it).
- **Client-side caps.** The socket bypasses the service-layer 10 MiB remote-query
  cap, so the client caps defensively: replies > 64 MiB close the connection, the
  pending queue is capped at 10, requests time out after 30 s (a timeout closes the
  connection — with positional replies there is no way to realign the FIFO), and the
  panel caps displayed rows at `MAX_QUERY_ROWS` with a truncation indicator, mirroring
  the Query Editor.
- **Path handling.** Absolute paths only. macOS limits Unix socket paths to 104 bytes
  (Linux 108) — the extension cannot fix that from the client side, so an over-long
  path earns a persistent in-panel warning, not a refusal (the bind happens in the
  app, possibly on another platform/container).
- **History is session-only.** The last 50 runs are kept in the webview, newest first;
  nothing is persisted.

### 14.4 Support bundles and SDK log export (SDK 5.2)

Two command-palette diagnostics features ship the data Ditto support asks for.
Both require an active connection and SDK 5.2+.

- **Ditto: Collect Support Bundle (dial9)…** — `SupportBundleService`
  (`src/ditto/SupportBundleService.ts`) mirrors benchy's
  `collect-support-bundle.py` flow:
  1. Optional load generation: loop a DQL query until ≥ 70 s of cumulative
     execution time (`MIN_QUERY_SECONDS`, matches benchy) so the dial9 ring
     buffer holds a meaningful profile of that workload. The command-palette
     flow skips this — the user runs their slow query manually first.
  2. `EXECUTE FUNCTION system_request_support_bundle()` assembles a `.tar`
     (dial9 traces at `dial9/dial9.bin.gz`, device logs, store diagnostics)
     and returns the bundle document; the newest `system:support_bundles`
     row carries the `file` attachment token.
  3. `store.fetchAttachment` (180 s timeout, timer cleared on settle so a
     fast fetch can't leak the event loop) → `copyToPath` into a temp dir
     (never `attachment.data()` — that would double the heap) → read once.
  4. The tar is gzipped to `.tar.gz` and written via `showSaveDialog`.

  Dial9 recording itself is startup-gated (`dial9_observability_level`
  system parameter, default 1 = Lite; env alias
  `DITTO_DIAL9_OBSERVABILITY_LEVEL`) — the service captures whatever is
  already in the ring buffer and never starts/stops the recorder. Note the
  SDK rate-limits `system_request_support_bundle` (~3 requests per 10 min
  per store); surface the SDK's error rather than retrying.
- **Ditto: Export SDK Logs (gzip)…** — `DittoLogger.exportToFile(path)`
  writes the SDK's internal ring buffer (Debug+, ~15 MB / 15-day retention,
  independent of `Logger.enabled`/`minimumLogLevel`) as `.jsonl.gz`. The
  path must not already exist and only the MOST RECENTLY created Ditto
  instance's logs are exported — hence the active-connection gate. Same
  modal document-data warning as Export Logs; both flows offer Reveal in
  Finder on success.

### 14.5 Profiling fields (SDK 5.1/5.2)

The profile parser and views track the SDK's `PROFILE` envelope growth:
`phaseTimes.stor` (store-backend wait, teal badge), `#stats.yields`
(cooperative scheduler yields, zero-dropped), `#stats.documentsSkipped`,
and JOIN inner subplans (`nlJoin.inner`) rendered as labeled subtrees —
`subtreeExecNs`/layout in `src/util/profilePlanLayout.ts` include subplan
descendants so the ≥ 50 % bottleneck flag accounts for them.

---

## 15. Security

Vulnerability reports go to security@ditto.com — see [`SECURITY.md`](../SECURITY.md)
for the disclosure policy. This section is for contributors: the tooling that
checks this codebase, and what to run before cutting a release.

### 15.1 Tooling overview

| Tool | Catches | Runs |
|---|---|---|
| `npm audit` | Known CVEs in production dependencies | `validate.yml` (every PR), local |
| ESLint + `eslint-plugin-security` + `eslint-plugin-no-unsanitized` | Unsafe regex/fs patterns, DOM-sink XSS in `webview-ui/` | `npm run lint` (every PR), local |
| Knip | Unused files, exports, and dependencies | `validate.yml` (every PR), local |
| `license-checker` | Non-allow-listed licenses in production dependencies | `validate.yml` (every PR), local |
| gitleaks | Secrets in a commit | pre-commit hook (staged diff), local full-history scan |
| Semgrep | OWASP Top 10 / security-audit rule packs | `security.yml` (PR + push + weekly), local |
| actionlint | GitHub Actions workflow syntax/logic errors | `security.yml` (PR + push + weekly), local |
| zizmor | GitHub Actions supply-chain issues (unpinned actions, excessive secrets, template injection, cache poisoning) | `security.yml` (PR + push + weekly), local |
| CodeQL (`security-extended`) | Broader static-analysis vulnerability classes | GitHub default setup, weekly |
| Dependabot | CVE alerts (always) + routine version drift (`.github/dependabot.yml`) | GitHub-native |

Config lives in `knip.config.js`, `.gitleaks.toml`, and `eslint.config.mjs`.
Each has inline comments explaining every suppression — if you add one, explain
*why* the finding doesn't apply, the same way the existing ones do.

### 15.2 Running it locally

```sh
npm run security
```

Runs everything from the table above against your working tree in one pass.
The npm-native checks (audit, lint, knip, license-check) always run. The
external-binary checks (gitleaks, semgrep, actionlint, zizmor) run if
installed, and print an install hint and skip otherwise — install what you're
missing:

```sh
brew install gitleaks semgrep actionlint uv   # zizmor runs via `uvx`, from uv
```

Each check also has its own script if you want to run just one:
`npm run audit`, `npm run lint`, `npm run knip`, `npm run license-check`.

The gitleaks pre-commit hook (`.githooks/pre-commit`, wired up automatically
by `npm install` via the `prepare` script) only scans your *staged* diff, so
it stays fast — `npm run security` runs gitleaks against full history instead.

### 15.3 Security release checklist

Run before tagging a release (in addition to the existing steps in
[`docs/releases/TEMPLATE.md`](releases/TEMPLATE.md)):

1. `npm run security` passes clean on `main` at the commit you're about to tag.
2. Check for open [Dependabot alerts](https://github.com/getditto/vsc-es/security/dependabot)
   and [code scanning alerts](https://github.com/getditto/vsc-es/security/code-scanning) —
   both should read zero-open before a release, not just at some earlier point.
3. If `allowUntrustedCerts`, secret redaction (`src/logging/secrets.ts`), or
   anything under `src/storage/SecretStore.ts` changed since the last release,
   re-read the diff adversarially — these are the paths where a subtle bug
   becomes a credential leak, not just a wrong query result.
4. Skim the CycloneDX SBOM the release workflow attaches
   (`ditto-vsce-<tag>.cdx.json`) if a new production dependency was added —
   confirm it was intentional.
5. New GitHub Actions steps or third-party actions since the last release?
   Confirm they're pinned to a commit SHA (`npm run security`'s zizmor/
   actionlint steps catch this, but a human read of the diff is cheap
   insurance on the workflow that publishes the release itself).
- **Apply.** The webview's advisory card renders reason + statement per suggestion with a "Create index" button → `query.createSuggestedIndex` → the host shows a modal confirm, re-checks the active connection after the modal (mid-switch guard, same shape as `CollectionsRepository.createIndex`), runs the statement verbatim through `executeRaw`, then refreshes the index tree via the `dittoVsce.refreshCollections` command (so the panel keeps its existing dependency set). `ADVISE AND PROVISION` is deliberately not surfaced anywhere — nothing runs CREATE INDEX without the modal.
