# use-edge-studio-vscode

Use the Ditto Edge Studio **VS Code extension** MCP server to query and manage the active Ditto database from an AI coding session.

## Prerequisites

1. The **Ditto Edge Studio** extension is installed and running in VS Code (or Cursor/Antigravity).
2. A connection is registered, and its **Advanced Configuration → MCP Server (AI Access)** checkbox is **ON** (off by default, per connection, for security).
3. That connection is **connected** (green status dot in the Connections tree).
4. Your client is pointed at the server:
   - **Copilot agent mode**: nothing to do — the extension advertises the running server automatically (`mcp__ditto-edge-studio__*` tools appear).
   - **Claude Code**: project `.mcp.json` → `{ "mcpServers": { "ditto-edge-studio-vscode": { "type": "http", "url": "http://127.0.0.1:65270/mcp" } } }` (the VS Code command **Ditto: Copy MCP Client Config** copies exactly this).
   - **Other HTTP clients**: streamable-HTTP endpoint `http://127.0.0.1:65270/mcp`; legacy SSE at `/sse` (+ `POST /messages`).

> Liveness without a client: `curl http://127.0.0.1:65270/health` → `OK`.
> Connection refused = nothing connected, or the active connection has MCP off, or the port setting changed.

## Rules of engagement

- **Everything targets the ACTIVE connection.** Check `get_active_database` before assuming which database you're on.
- **`execute_dql` can WRITE.** Confirm EVICT / UPDATE / DELETE with the user before running them; report `mutatedDocumentIds`/`commitId` back after mutations.
- **Do not call `connect_database` unless the user asked for a switch** — switching closes the user's panels, and switching to a connection whose MCP flag is OFF stops the server mid-session (your channel dies). Stay on the flagged connection.
- Result sets cap at 10 000 rows (`truncated: true`, `totalRowCount`) — narrow with WHERE/LIMIT instead of paging.
- `configure_transport` restarts sync (peers briefly drop); `get_database_metrics` scans the whole store (be sparing); `profile_query` RUNS the query it profiles.
- Credentials are never in tool output — don't ask for them.

## Tools (31)

### Connection / automation
| Tool | Arguments | Notes |
|---|---|---|
| `list_databases` | — | Registered connections `[{id, name, databaseId, mode, status}]`. |
| `get_active_database` | — | Active detail; `httpApiConfigured` is a bool, never the key. |
| `connect_database` | `id_or_name` | Headless connect/switch with auto-rollback. See the warning above. |
| `disconnect_database` | — | Reports `wasConnected`. |

### Queries & data
| Tool | Arguments | Notes |
|---|---|---|
| `execute_dql` | `query`, `transport`=`local`\|`http` | Any DQL. Local by default; `http` routes to the connection's Ditto Server API (structured `http_not_configured` payload when unset). |
| `insert_documents_from_file` | `file_path`, `collection`, `mode`=`insert`\|`insert_initial` | JSON array of docs with `_id`; batched upsert; reports `{inserted, failed, errors}`. |
| `explain_query` | `query` | Plan without executing. |
| `profile_query` | `query` (SELECT) | Runs with PROFILE → per-operator timing tree + rows. |
| `debug_socket_query` | `socket_path`, `statement` | One DQL statement against a **running app's** debug socket (the app applied `ALTER SYSTEM SET debug_socket = '/path/to.sock'`). No extension connection needed; 15 s cap. |

### Collections & indexes
| Tool | Arguments | Notes |
|---|---|---|
| `list_collections` | — | + live counts + nested indexes. |
| `list_indexes` | — | Flat list; `[]` when disconnected. |
| `create_index` | `collection`, `field` **or** `fields` | `fields`: ordered composite `[{name, direction?}]`. Same name/same def → `already-exists`; same name/diff def → hard error. |
| `drop_index` | `index_name`, `collection?` | Ambiguity across collections is refused until you pass `collection`. |

### Sync / peers / transports
| Tool | Arguments | Notes |
|---|---|---|
| `get_sync_status` | — | sync on/off, peer counts, cloud link, transports. |
| `set_sync` | `enabled` | Toolbar toggle. |
| `configure_transport` | `lan?`, `ble?`, `awdl?` | Omit = unchanged; persists to the connection. |
| `get_peers` | — | Direct peers + raw multi-hop `presenceGraph`; metadata as COUNTS. |

### Subscriptions & observers (definitions persist; live only while that connection is active)
| Tool | Arguments | Notes |
|---|---|---|
| `list_subscriptions` / `add_subscription` / `remove_subscription` | `database?` targets another registered connection; add takes `{name, query}`; remove `{id}` | SELECT-only. Adds register live on the active target. |
| `list_observers` / `add_observer` / `remove_observer` | same shapes | Definitions only. |
| `watch_query` | `query`, `duration_ms?`≤30000, `max_events?`≤100, `max_rows_per_event?`≤200 | Bounded live capture with diff arrays; auto-cancels. **First event = the full initial result set** (all "insertions"), not a change. Loop it for "wait until X changes". |

### Metrics & diagnostics
| Tool | Arguments | Notes |
|---|---|---|
| `get_query_metrics` | — | Last-200 Query Editor runs (not `execute_dql` calls). |
| `get_system_metrics` | — | Shared accumulator (see the contract below). |
| `get_database_metrics` | — | Disk buckets + per-collection CBOR bytes. Heavier weight. |
| `get_app_logs` | `lines?`≤2000, `filter?` substring | Extension log, redacted. |
| `get_ditto_logs` | `+ level?` min severity | Ditto-origin tags only (`sdk`/`transport`/`connection-request`). |
| `query_log_analyzer` | `level?`, `source?`, `search?`, `limit?`, `offset?` | Pattern-flagged problems, paged. First call backfills (slow is normal). |
| `fetch_attachment` | `token` (id/len/metadata from a row), `save_to_path` (absolute), `overwrite?` | Streams to disk; never returns bytes. |

## Resources (`resources/read`)

`ditto://schema`, `ditto://peers`, `ditto://sync-status`, `ditto://system-metrics` (accumulated; side-effect-free), `ditto://subscriptions`, `ditto://observers`. Disconnected → JSON body `{"error":"no_active_connection"}` — not a protocol error, and not worth retrying until something's connected.

## The system:metrics contract (don't get confused by deltas)

Every `system:metrics` read **flushes** the SDK registry. The extension funnels all readers through one shared per-connection accumulator, so:

- Report **`sinceConnect`** totals and the **`sinceMs`** zero point — those are the stable numbers.
- Expect **`periodDelta`** to shrink immediately after any read (yours included).
- `exporterDisabled` → tell the user to enable `dittoVsce.collectSystemMetrics` and reconnect (it's startup-gated); `settingDisabled`/`noConnection` carry their own guidance field.

## Common workflows

**Explore a database:** `get_active_database` → `list_collections` → `execute_dql` a few `SELECT * … LIMIT 5` samples.

**Tune a slow query:** `explain_query` (baseline plan) → `list_indexes` → `create_index` on the filtered fields → `explain_query` again → optionally `profile_query` to prove the timings.

**Pre-stage sync shape before showing it to the user:** `list_databases` → `add_subscription {database: '<name>'}` (inactive target persists; registers on next connect).

**Wait for data:** `watch_query {query, duration_ms: 5000}` in a loop until an event's diff arrays match what you're waiting for, or drive the change yourself with a mutation and watch the result land.

**Debug a live app from VS Code:** `debug_socket_query` `SELECT * FROM system:data_sync_info` (or any DQL) against the app's socket path.

**Bulk seed, then verify:** `insert_documents_from_file` → `execute_dql` `SELECT COUNT(*)` → spot-read a known `_id`.

## Error reference

| Symptom | Cause | Fix |
|---|---|---|
| `connection refused` / `/health` silent | Server not running | Active connection needs the MCP checkbox ON and must be connected. |
| `Error: No active connection…` | Nothing connected | `list_databases`, ask the user which to use, then (with permission) `connect_database` a flagged one. |
| `unknown sessionId` (404) | Your session expired (server restart) | Re-initialize: POST a fresh `initialize` to `/mcp`. |
| `http_not_configured` | `transport:"http"` but no HTTP API on the connection | Use `transport:"local"` or ask the user to fill HTTP API URL+Key. |
| `in progress` on connect/configure | A switch or transport apply is mid-flight | Wait a beat; poll `get_active_database`; retry. |
| `A transport change is already in progress` | Same, transport-specific | Same as above. |
| `truncated: true` | SELECT exceeded 10 000 rows | Add WHERE/LIMIT; use `totalRowCount` for the real size. |
| Tool prefix missing in Copilot | Server stopped between chats | Tools appear only while the server runs — re-check `/health`. |
