# ditto-edge-studio-vscode MCP integration

Gives Claude Code, Codex, Cursor, Copilot agent mode, and compatible clients
access to the [Ditto Edge Studio VS Code extension](../../README.md)'s MCP
server for querying and automating Ditto databases directly from AI coding
sessions.

## Setup

### 1. Enable the server (per connection; off by default)

1. In VS Code, **Connections** tree → right-click the connection → **Edit
   Configuration** → expand **Advanced Configuration** → **MCP Server (AI
   Access)**.
2. Check **Start MCP server while this connection is active**, save, connect.
3. The status bar shows `⎇ plug Ditto MCP :65270` while it runs.

The server stops on disconnect and never runs without an active, flagged
connection.

### 2. Connect your agent

**Copilot agent mode:** nothing to configure — tools appear automatically
while the server runs.

**Claude Code:** run **Ditto: Copy MCP Client Config** in the VS Code Command
Palette and paste into your project's `.mcp.json`, or:

```bash
claude mcp add ditto-edge-studio-vscode --transport http http://127.0.0.1:65270/mcp
```

**Codex** (`.codex/config.toml`):

```toml
[mcp_servers.ditto-edge-studio-vscode]
url = "http://127.0.0.1:65270/mcp"
enabled = true
```

### 3. Smoke test

```bash
curl http://127.0.0.1:65270/health     # → OK
```

## The skill

Share [`skills/use-edge-studio-vscode/SKILL.md`](./skills/use-edge-studio-vscode/SKILL.md)
with your agent (Claude Code: this repo's plugin layout is auto-discovered; or
paste the file contents into the session). It documents all 31 tools, the
resources, the system:metrics delta contract, and the safety rules.

## Validating the server against any agent

Follow the scripted acceptance run in
[`docs/MCP_VALIDATION.md`](../../docs/MCP_VALIDATION.md) — it drives every
part of the surface with a deterministic dataset
([`fixtures/mcp-validation-data.json`](./fixtures/mcp-validation-data.json))
and gives you agent-independent verification steps for each stage.

## Notes

- Default port **65270**; the SwiftUI Edge Studio app uses 65269, so both can
  run at once. Change it in Settings (`dittoVsce.mcpServer.port`,
  machine-scoped).
- All tools act on the **active connection**; `connect_database` switches
  databases headlessly (with automatic rollback on failure).
- `execute_dql` writes data. The server is loopback-only but unauthenticated:
  while it runs, treat any local process as able to read+write the active
  database.
- Full reference: [`docs/MCP_SERVER.md`](../../docs/MCP_SERVER.md).
