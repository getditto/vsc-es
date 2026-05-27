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
- **Peer Listing** — live grid of connected peers with gradient-coded cards by
  dominant connection type, sync status, SDK info, and animated insert/remove
  driven by `ditto.presence.observe` and the `__sync_status` system collection.
- **Query Editor** — run ad-hoc DQL against the active database. Results in
  table or JSON view, with column union across heterogeneous documents.
- **Query profiling** — visualize Ditto's `PROFILE` execution plan as nested
  cards or a top-down tree, with per-operator timing, doc throughput, and
  bottleneck highlighting.
- **Two auth modes** — Server (Big Peer with URL) and
  Small Peers Only (offline token + optional shared-secret key).
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

## Requirements

- VS Code ≥ 1.95
- Node.js ≥ 20 (the extension runs in VS Code's Electron Node host)
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
