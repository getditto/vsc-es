# Ditto Edge Studio for VS Code

A Visual Studio Code extension to debug and inspect [Ditto](https://docs.ditto.live)
databases. Register a database, connect from inside the editor, register
subscriptions, watch peers in real time, and run ad-hoc DQL queries — all
without leaving VS Code.

## Features

- **Database management** — register, edit, and delete Ditto database
  configurations. Credentials are stored via `vscode.SecretStorage` (Keychain
  on macOS, Credential Manager on Windows, libsecret on Linux).
- **One-click connect** — open a database from the tree; status dot reflects
  idle / activating / active / error.
- **Subscriptions** — create, edit, and delete DQL sync subscriptions.
  Persisted across reconnects and re-registered automatically.
- **Observers** — register a DQL `SELECT` query against your local store and activate it on demand to see a live stream of events with insertion / update / move / delete diffs. Each event's documents are inspectable as JSON or in a flat table view, reusing the Query Editor's existing viewers. Observers are intentionally inactive at panel open — they're expensive, so activation is explicit.
- **Peer Listing** — live grid of connected peers with gradient-coded cards by
  dominant connection type, sync status, SDK info, and animated insert/remove
  driven by `ditto.presence.observe` and the `__sync_status` system collection.
- **Query Editor** — run ad-hoc DQL against the active database. Results in
  JSON, Table, or Profile view, with column union across heterogeneous
  documents.
- **Query profiling** — visualize Ditto's `PROFILE` execution plan as nested
  cards or a top-down tree, with per-operator timing, doc throughput, and
  bottleneck highlighting. Renders the SDK 5.1/5.2 fields too: store-backend
  wait time (`stor`), scheduler yield counters, skipped-document counts, and
  JOIN inner subplans as labeled subtrees. Captured automatically on local
  SELECTs when enabled.
- **Profiling + metrics gates** — a settings cog (⚙) in the Query Editor
  toolbar toggles profiling and metrics collection on or off. When off, the
  matching tabs disappear and the per-query SDK overhead is skipped. Bound
  to user-scope settings, so the choice travels across workspaces.
- **Right-click index management** — add an index via the **Add Index…**
  context-menu (or inline `＋`), and remove one via right-click → **Delete
  Index** (or inline trash icon) on any index row. Both flows confirm
  before mutating.
- **Log Analyzer** — live problem detection over the SDK + extension log
  stream. Opens from a connected database's **Features → Log Analyzer**
  row. On
  open, the panel backfills history from `ditto-edge-studio.log` and then
  subscribes to new lines. A bundled regex catalog (`problem_patterns.json`)
  flags known issues — deadlocks, expired certificates, OOM kills, query
  size limits, auth failures — and surfaces a recommendation per match,
  severity-ranked. Includes a stacked log-volume histogram, a
  problems-over-time histogram, a log-binned connection-duration histogram,
  a per-peer connection timeline (SVG lanes colored by transport with
  `ditto_init` markers), and a live tail. Pause / Clear / Manage Patterns
  toolbar.
- **Manage Log Patterns** — the **Logging** sidebar → **Manage Log
  Patterns** opens a dedicated editor for user-defined patterns. Bundled
  patterns are listed read-only (lock icon, no edit/delete affordance);
  user patterns get full CRUD with live regex validation, a test-line
  field, and severity (1–5) + optional level / tag filters. Saved to
  `<globalStorage>/log-analyzer/user_patterns.json` by default, or to the
  path in the `dittoVsce.logAnalyzer.customPatternsFile` setting if set
  (useful for sharing patterns via version control). On-disk format
  matches the bundled catalog, so power users can edit by hand and the
  editor will read it correctly.
- **Two auth modes** — Server (Big Peer with URL) and
  Small Peers Only (offline token + optional shared-secret key).
- **MCP server (AI access)** — an embedded Model Context Protocol server lets
  AI assistants (Claude Code, Cursor, Copilot agent mode, …) automate the
  active database: DQL against the local store or the HTTP API, index and
  subscription management, bounded live watches, system/database metrics,
  presence, logs and the Log Analyzer, attachments to disk, and one-shot DQL
  against a running app's debug socket. **Off by default**; enabled per
  connection in Edit Configuration → Advanced Configuration → MCP Server.
  Loopback-only on `127.0.0.1:65270`. See [docs/MCP_SERVER.md](docs/MCP_SERVER.md)
  for the full tool reference and client setup snippets,
  [plugins/ditto-edge-studio-vscode/](plugins/ditto-edge-studio-vscode/) for the
  agent skill bundle, and [docs/MCP_VALIDATION.md](docs/MCP_VALIDATION.md) for a
  scripted acceptance run you can hand to any agent to prove the surface works.
- **Get Quickstarts** — one click clones the official
  [Ditto quickstart repo](https://github.com/getditto/quickstart) into a
  folder you choose and pre-fills `.env` files for every quickstart project
  (plus the Edge Server YAML) using the Database ID, Development Token, and
  URLs from your currently active connection. If no connection is active,
  the command offers a code-only download — open a connection and re-run to
  configure the `.env` files later. Available from the **Help** tree → **Get
  Quickstarts**, the **Welcome** view → **Get Quickstarts** card, and the
  Command Palette → **Ditto: Get Quickstarts…**. Requires `git` on your
  PATH.
- **Support bundle collection (dial9)** — Command Palette → **Ditto:
  Collect Support Bundle (dial9)…** captures the SDK's diagnostic bundle
  over the active connection: Tokio task traces (`dial9`), SDK logs, and
  store diagnostics, delivered as a single `.tar.gz` you can attach to a
  Ditto support ticket. For a slow-query investigation, run the query
  first so the trace window covers it. Requires Ditto SDK 5.2+.
- **SDK log export** — Command Palette → **Ditto: Export SDK Logs
  (gzip)…** writes the Ditto SDK's own internal ring-buffer logs (Debug
  level and up, independent of the configured SDK log level) to a
  compressed `.jsonl.gz` file — the payload support asks for when the
  extension's own logs aren't deep enough. Requires an active connection;
  Ditto SDK 5.2+.

## Requirements

- VS Code ≥ 1.106
- Node.js ≥ 22 (the extension runs in VS Code's Electron Node host)
- A Ditto account at [portal.ditto.live](https://portal.ditto.live) for
  credentials

## Installation

Download the `.vsix` for your platform from the latest GitHub Release:
**<https://github.com/getditto/vsc-es/releases/latest>**

| Platform              | Asset filename                        |
| --------------------- | ------------------------------------- |
| macOS (Apple silicon) | `ditto-vsce-darwin-arm64-<ver>.vsix`  |
| Linux (x86_64)        | `ditto-vsce-linux-x64-<ver>.vsix`     |
| Linux (ARM64)         | `ditto-vsce-linux-arm64-<ver>.vsix`   |
| Windows (x86_64)      | `ditto-vsce-win32-x64-<ver>.vsix`     |

All three editors share VS Code's extension format, so the steps are nearly
identical — only the CLI binary name differs.

### VS Code

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `code --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Cursor

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `cursor --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Google Antigravity

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `agy --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`
  *(verify exact binary name against your Antigravity install — some Linux builds install as `antigravity` instead; see the [Antigravity docs](https://antigravity.google/docs/command) for the latest)*

### Reload and verify

After installing, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
and run **Developer: Reload Window**. The Ditto icon should appear in the
activity bar.

### Not supported

- **Intel Mac (`darwin-x64`)** — the `@dittolive/ditto` SDK does not ship a binary for this target.
- **Windows on ARM (`win32-arm64`)** — same reason.

## Build from source

```sh
npm install
npm run build
TARGET=darwin-arm64 npm run package    # produces ditto-vsce-darwin-arm64-<version>.vsix; substitute your platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64)
code --install-extension ditto-vsce-darwin-arm64-<version>.vsix
```

## Usage

1. Open the **Ditto** view in the activity bar.
2. Click the `＋` button on the Databases title bar → fill in the registration
   form → Save.
3. Right-click the new row → **Connect**. The status dot turns green when
   sync is active and the row expands to show **Subscriptions**, **Peer
   Listing**, and **Query Editor**.
4. Hover **Subscriptions** → click `＋` to register a DQL subscription.
5. Click **Peer Listing** to watch peers join and leave in real time.
6. Click **Query Editor** to run ad-hoc DQL. `Cmd+Enter` runs the query.
7. To drive it all from an AI assistant instead: Edit Configuration →
   Advanced → **Start MCP server while this connection is active**, connect,
   then point your client at `http://127.0.0.1:65270/mcp` (Command Palette →
   **Ditto: Copy MCP Client Config** copies a ready-made snippet; in VS Code's
   own Copilot agent mode the tools appear automatically).

For end-to-end test recipes, see [`docs/MANUAL_TESTING.md`](docs/MANUAL_TESTING.md).

## Development

Press `F5` in VS Code to launch the Extension Development Host with the
extension loaded. Run `npm run watch` in a separate terminal for incremental
rebuilds.

For architecture, source layout, and contribution guidance, see
[`docs/Developer.md`](docs/Developer.md).

## Architecture (one-liner)

Extension host (Node, CJS via esbuild) hosts a singleton `DittoManager`
wrapping `@dittolive/ditto`. Webview panels (Lit, IIFE bundles) talk to the
host over typed `postMessage`. Storage uses `SecretStorage` for credentials
and `globalState` for non-secret config + subscriptions.
