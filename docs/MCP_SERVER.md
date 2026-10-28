# MCP Server — AI automation surface

The extension embeds a [Model Context Protocol](https://modelcontextprotocol.io)
server so AI assistants (Claude Code, Cursor, Copilot agent mode, Codex, …) can
drive Ditto Edge Studio from inside VS Code: run DQL, manage indexes and
subscriptions, watch data change, and read metrics/peers/logs. It is the
VS Code counterpart of the SwiftUI Edge Studio app's MCP server and speaks to
the extension host's **live Ditto instance** (the one the panels use), not a
separate process.

Default port: **65270** (the SwiftUI app uses 65269 — both can run at once,
each against its own active database).

## Enabling it (per connection, off by default)

For security the server is **off by default** and is enabled **per
connection**, not globally:

1. Open the connection in the editor (**Connections** tree → right-click →
   **Edit Configuration**) and expand **Advanced Configuration**.
2. Check **"Start MCP server while this connection is active"** (under **MCP
   Server (AI Access)**) and save.
3. Connect. The server starts when the connection becomes active, stops when
   you disconnect, and follows switches (switching to a connection without the
   flag stops it).

While it runs, a status-bar item (`⎇ plug Ditto MCP :65270`) is visible —
click it for a status modal. Command Palette shortcuts:
**Ditto: Start MCP Server** / **Stop MCP Server** flip the flag on the active
connection; **Ditto: Copy MCP Client Config** copies the snippet regardless.

The port is a machine-scoped setting (`dittoVsce.mcpServer.port`).

## Connecting clients

Streamable HTTP (current spec) is served at `POST /mcp`; the legacy HTTP+SSE
transport (spec 2024-11-05, what the SwiftUI app serves on `/mcp`) is at
`GET /sse` + `POST /messages` for older clients. Always loopback-only.

**Agent onboarding bundle** (`plugins/ditto-edge-studio-vscode/`): an
agent-facing [skill](../plugins/ditto-edge-studio-vscode/skills/use-edge-studio-vscode/SKILL.md)
describing every tool, the safety rules, and the system:metrics contract, plus
per-client setup snippets. **Acceptance testing against any agent:** the
scripted run with agent-independent verification lives in
[MCP_VALIDATION.md](./MCP_VALIDATION.md).

Claude Code (project `.mcp.json`):

```json
{
  "mcpServers": {
    "ditto-edge-studio-vscode": {
      "type": "http",
      "url": "http://127.0.0.1:65270/mcp"
    }
  }
}
```

Codex (`.codex/config.toml`):

```toml
[mcp_servers.ditto-edge-studio-vscode]
url = "http://127.0.0.1:65270/mcp"
enabled = true
```

Copilot agent mode: nothing to configure — the extension advertises the
running server via `vscode.lm.registerMcpServerDefinitionProvider`, so its
tools appear in the agent tool picker automatically whenever the server is up.

Smoke test (sessions are stateful — initialize first, then send the
returned `Mcp-Session-Id` header):

```sh
# 1. Initialize; the session id comes back in a response header.
curl -sD - -X POST http://127.0.0.1:65270/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'

# 2. Notify initialized, then call — both with the header from step 1.
curl -X POST http://127.0.0.1:65270/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <id from step 1>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -X POST http://127.0.0.1:65270/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Session-Id: <id from step 1>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Liveness without a client: `curl http://127.0.0.1:65270/health` → `OK`.

### When /health fails

1. **Command Palette → `Ditto: MCP Server Status`** — one modal with
   running state, URL, session count, whether the *active* connection has
   the flag on, and the last start error verbatim.
2. **Log Analyzer** (active database → Features → Log Analyzer) — every
   lifecycle beat is logged under the `[mcp]` tag: `MCP server starting
   / started / stopped`, each client session init
   (`MCP client session initialized`), and failures as ERROR
   (`MCP server failed to start`). A bundled problem pattern flags the
   failure line with a recommendation. Backfill covers the current
   connection, so the lines from *this* connect are already there.
3. **Output channel** — "Ditto Edge Studio", filter `mcp`.
4. Likely candidates when never-started: the port is owned by another
   VS Code window (or the SwiftUI app — it defaults to 65269, we to 65270,
   but check), or the checkbox isn't actually saved on THIS connection.


## Security model

- **Loopback-only** (`127.0.0.1` + `::1`). Unreachable from the LAN.
- **No authentication**: any process on the machine can connect while the
  server runs. That's why enablement is a per-connection opt-in and the
  default is off. Treat "enabled + connected" as "local processes may read
  AND write this database".
- Requests are capped at 4 MiB; unknown/expired session ids are rejected with
  404 **before** the message reaches a tool, so a client retry after a server
  restart cannot double-apply a mutation.
- DNS-rebinding protection: requests whose `Host` header is not the bound
  loopback name/port (`127.0.0.1`, `localhost`, `[::1]`) are refused 403, so a
  browser page on a rebound domain cannot reach the endpoints same-origin.
- Tool output never contains credentials: `list_databases` /
  `get_active_database` return config metadata only (`httpApiConfigured` is a
  boolean, not the key). Log tools read the extension's own log file, which is
  pattern- and value-redacted at write time.
- Peer `peerMetadata`/`identityMetadata` bodies never cross the wire — counts
  only.
- All collection/field/index identifiers are backtick-quoted
  (`quoteIdentifier`/`quoteFieldPath`); nothing is interpolated raw into DQL.
- Attachments never enter the conversation: `fetch_attachment` streams
  store→disk via the SDK's native copy (512 MB cap). Because attachment
  bytes and tool arguments can be steered by synced (untrusted) documents,
  downloads are confined to an open workspace folder, the extension storage
  directory, or the OS temp directory — symlink escapes are resolved away —
  and `overwrite:false` claims the destination atomically.

## Error conventions

Tool failures come back as **successful JSON-RPC responses** with
`result.isError: true` and `content[0].text = "Error: <message>"` — the model
is expected to read and recover from them. JSON-RPC errors are protocol-level
only (parse errors, unknown methods, missing sessions).

Tools that need a connection fail with:

```
Error: No active connection. Connect to a database first (the connect_database
tool, or the Ditto sidebar in VS Code).
```

## Tools (31)

### Connection / automation

| Tool | Notes |
| --- | --- |
| `list_databases` | Registered connections: `id, name, databaseId, mode, status`. Never credentials. |
| `get_active_database` | Active connection detail: identity, URLs, transport toggles, sync state, lifecycle, peer counts. `httpApiConfigured` boolean only. |
| `connect_database` `{id_or_name}` | Connect/switch headlessly. Switching closes the old connection's panels (reopened on next connect). On connect failure it **rolls back to the previously active connection** and says so. |
| `disconnect_database` | Disconnect; reports `wasConnected`. |

### Queries & data

| Tool | Notes |
| --- | --- |
| `execute_dql` `{query, transport?}` | Any DQL (SELECT/INSERT/UPDATE/EVICT/DDL) against the local store. `transport: "http"` posts to the connection's HTTP API (returns a structured `http_not_configured` payload when unset). SELECT rows cap at 10 000 (`truncated` + `totalRowCount`); mutations return `mutatedDocumentIds` + `commitId`. |
| `insert_documents_from_file` `{file_path, collection, mode?}` | Bulk upsert a JSON array (every doc needs `_id`). `mode: "insert_initial"` uses INITIAL DOCUMENTS. Returns `{inserted, failed, errors[]}`. 256 MB file cap. |
| `explain_query` `{query}` | EXPLAIN plan without executing. |
| `profile_query` `{query}` | Executes a SELECT with PROFILE → per-operator timing tree. Runs the real query — tuning tool. |
| `debug_socket_query` `{socket_path, statement}` | One DQL statement against a **running app's** SDK 5.1 debug socket. Needs no extension connection. 15 s timeout, one statement per call. |

### Collections & indexes

| Tool | Notes |
| --- | --- |
| `list_collections` | Names + live counts + indexes (nested). |
| `list_indexes` | Flat index list; `[]` when disconnected. |
| `create_index` `{collection, field? | fields?}` | `field` = single ASC (SwiftUI shape); `fields` = ordered composite `{name, direction?}[]` (SDK 5.1+). The response carries `index` — the generated name — so automation can drop/manage it without a `list_indexes` round-trip. Same-name+same-def → `already-exists`; same-name+different-def → hard error (drop first). |
| `drop_index` `{index_name, collection?}` | Bare name resolving to multiple collections is refused until you pass `collection` (names aren't globally unique). |

### Sync, peers, transports

| Tool | Notes |
| --- | --- |
| `get_sync_status` | Sync on/off, peer count, cloud link, transports. |
| `set_sync` `{enabled}` | Toolbar toggle equivalent. |
| `configure_transport` `{lan?, ble?, awdl?}` | Omit = unchanged. Sync restarts around the apply; change persists to the connection. OS gates drop impossible transports. |
| `get_peers` | Local device info, direct peers (no metadata bodies), raw multi-hop `presenceGraph`. |

### Subscriptions & observers

Definitions persist in the store; live registration exists only while the
target connection is active. All four CRUD tools accept `database`
(id or name, default: active) so an agent can stage definitions pre-connect.

| Tool | Notes |
| --- | --- |
| `list_subscriptions` / `add_subscription` `{name, query, database?}` / `remove_subscription` `{id, database?}` | SELECT-only. Adds register live when the target is active. |
| `list_observers` / `add_observer` `{name, query, database?}` / `remove_observer` `{id, database?}` | Definitions only — activation stays a panel action. |
| `watch_query` `{query, duration_ms?, max_events?, max_rows_per_event?}` | Bounded live capture (≤30 s): change events with diff arrays + capped rows, then auto-cancel. First event = the full initial result set. Use in a loop for "wait until X changes". |

### Metrics & diagnostics

| Tool | Notes |
| --- | --- |
| `get_query_metrics` | Last-200 ring of Query Editor runs (duration, rows, EXPLAIN, PROFILE). `execute_dql` calls don't record here. |
| `get_system_metrics` | Accumulated `system:metrics` series (since-connect totals + latest window delta) with status + remediation guidance. Reads through the **shared** accumulator the System Metrics panel uses — see below. |
| `get_database_metrics` | Disk usage buckets of the working directory + per-collection document counts and CBOR bytes. Expensive on big stores; call sparingly. |
| `get_app_logs` `{lines?, filter?}` | Extension log (all subsystems), newest last. |
| `get_ditto_logs` `{lines?, filter?, level?}` | Ditto-origin tags (`sdk`, `transport`, `connection-request`) with optional minimum severity. |
| `query_log_analyzer` `{level?, source?, search?, limit?, offset?}` | The Log Analyzer engine as a tool: pattern-flagged problems, level/source filters, paged results. First call per connection backfills to connect time. |
| `fetch_attachment` `{token, save_to_path, overwrite?}` | Storage token from a query row → stream to an absolute path inside a workspace folder, extension storage, or the OS temp dir. Atomic existence/`overwrite` guards. |

## Resources (`resources/read`)

Point-in-time JSON snapshots, no arguments. When disconnected they return a
JSON body `{"error": "no_active_connection", …}` rather than a protocol error.

| URI | Content |
| --- | --- |
| `ditto://schema` | Collections + counts + indexes (freshly hydrated). |
| `ditto://peers` | Latest presence snapshot (local, direct peers, multi-hop graph). |
| `ditto://sync-status` | The exact `get_sync_status` contract (sync, `connectedPeers`, `cloudSyncConnected`, transports) — tools and the resource never disagree about peer counts: the synthetic cloud row is a boolean, not a count. |
| `ditto://system-metrics` | Latest accumulated snapshot — **side-effect-free** (no registry read; see below). |
| `ditto://subscriptions` · `ditto://observers` | Persisted definitions for the active connection. |

## The system:metrics delta contract (read this before charting)

`SELECT * FROM system:metrics` **flushes** the SDK's metrics registry: each
row's `delta`/`dcount` covers the window since the previous read *by anyone*.
Two independent accumulators would race — whichever reads second sees nothing.
The extension therefore routes EVERY reader through one per-connection
accumulator (`SystemMetricsHub`):

- at **connect time** the extension pre-reads once, so the accumulator's
  zero point is the connection, not the first consumer's curiosity;
- the System Metrics panel polls every 5 s while visible;
- `get_system_metrics` reads on demand per call;
- `ditto://system-metrics` serves the accumulated state without reading.

Consequences for agents: report `sinceConnect` + the `sinceMs` zero point;
expect `periodDelta` to shrink immediately after any read; if the exporter
wasn't enabled at connect time the status is `exporterDisabled` with guidance
(reconnect with `dittoVsce.collectSystemMetrics` on).

**Gauge series (SDK 5.2)** are the exception to the accumulate-deltas rule:
for known gauge keys (e.g. `ditto.network.connections`,
`ditto.transport.awdl.interface_up`), `kind` is `"gauge"` and
`sinceConnect` carries the exporter's latest absolute `current` value —
report it as-is (a point value, not a total) and expect `periodDelta` to go
negative when the gauge falls.

## Architecture

```
AI client ──HTTP(127.0.0.1:65270)──▶ McpServerService  (src/mcp/, per-session
                                     state map; /mcp + /sse + /messages + /health)
                                        │ registerAllTools / registerAllResources
                                        ▼
                              McpToolContext — the SAME service instances the
                              panels use (DittoManager, stores, hub, analyzers)
```

`src/mcp/` layout: `define-tool.ts` (data-record tool defs), `tools-*.ts`
(domain groups), `registry.ts` (manifest), `resources.ts`, `McpServerService`
(transport), `McpServerController` (per-connection lifecycle, status bar,
commands), `copilot.ts` (VS Code definition provider), `settings.ts` (port +
client snippet).

Coverage of the tool surface is locked by `src/test/mcp-tools.test.ts`'s
manifest assertion — when you add/remove a tool, update the lock list
deliberately.
