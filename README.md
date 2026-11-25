# Ditto Edge Studio

Inspect, query, and troubleshoot Ditto databases from your editor.

## What you can do

- **Explore data.** Run DQL, browse results as tables or JSON, and manage indexes. Profile local queries to see where they spend time.
- **Watch sync and changes.** Manage sync subscriptions, see connected peers, and watch live query results.
- **Troubleshoot.** Inspect logs and metrics, preview or download attachments, and export support bundles.
- **Encrypt local storage.** During registration, choose **Encrypt local database** under **Advanced Configuration**. Use a generated key or supply a Base64-encoded 32-byte key.
- **Use AI tools.** Enable the local MCP server to query and manage the active database. MCP is off by default.
- **Try a sample app.** Use **Ditto: Get Quickstarts…** to download and configure an official sample. This command requires Git.

## Requirements and limits

- **Desktop VS Code 1.106 or later.** Packages cover macOS on Apple silicon, Linux x64 and arm64, and Windows x64.
- **Existing Ditto database and credentials.** Have your database ID and token ready. Cloud users can find them in the [Ditto Portal](https://portal.ditto.live/).
- **A native extension host with a real filesystem.** Database connections are unavailable in browser-only editors and virtual workspaces.
- **Encryption at registration.** Applying encryption to an existing local store or changing its key requires a new store.

## Installation

1. In your editor’s extension marketplace, search for **Ditto Edge Studio** (`DittoLive.ditto-vsce`). If you have a VSIX file, use **Extensions → … → Install from VSIX…**.
2. Run **Ditto: Register Connection…** and enter your database ID and token. For **Server** mode, also enter your Ditto Server URL.
3. In the **Ditto** activity bar view, right-click the connection and select **Connect**. Open **Query Editor** to run a query.

[Ditto documentation](https://docs.ditto.live/sdk/latest/tools/vsc-es)
