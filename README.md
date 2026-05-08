# Ditto Edge Studio (VS Code) — POC

A POC VS Code extension to debug and inspect [Ditto](https://docs.ditto.live) databases.
Mimics the core flows of the SwiftUI Ditto Edge Studio: register a database, connect,
register subscriptions, and view connected peers.

## Features (POC scope)

- Register database configurations (Server / Small Peers Only modes)
- Securely store credentials via `vscode.SecretStorage`
- Connect to one Ditto database at a time
- Register subscriptions (persisted across reconnect)
- View connected peers in a card grid

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in Ditto credentials (only required if running the legacy spike — registered databases use the in-app form).
3. `npm run build` (or `npm run watch` for HMR-style iteration).
4. Press `F5` in VS Code to launch the Extension Development Host.

See `docs/MANUAL_TESTING.md` for end-to-end test recipes.

## Architecture

- Extension host (Node, CJS via esbuild): tree provider, panel hosts, DittoManager.
- Webview UI (Lit, IIFE bundles via esbuild): `editor`, `subscription`, `peers`.
- Storage: `vscode.SecretStorage` (tokens / keys) + `globalState` (config metadata + subscriptions).

See `docs/superpowers/specs/2026-05-08-ditto-edge-studio-vsce-poc-design.md` for the design spec.
