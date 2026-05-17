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
- **Two auth modes** — Server (Big Peer with URL / websocket URL) and
  Small Peers Only (offline token + optional shared-secret key).

## Requirements

- VS Code ≥ 1.95
- Node.js ≥ 20 (the extension runs in VS Code's Electron Node host)
- A Ditto account at [portal.ditto.live](https://portal.ditto.live) for
  credentials

## Install (from VSIX)

```sh
npm install
npm run build
npm run package    # produces ditto-vsce-<version>.vsix
code --install-extension ditto-vsce-<version>.vsix
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
