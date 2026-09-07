# MCP Server Validation — scripted agent run

Purpose: a repeatable acceptance script you hand to any AI agent (Claude Code,
Codex, Cursor, Copilot agent mode) to prove the extension's MCP server works
end to end — transport, tools, resources, and writes — with results you can
check **independently of the agent** (curl, the VS Code UI, and the tree).

The dataset is deterministic:
[`plugins/ditto-edge-studio-vscode/fixtures/mcp-validation-data.json`](../plugins/ditto-edge-studio-vscode/fixtures/mcp-validation-data.json)
(6 documents in a `mcp_tasks` collection).

## 0. Setup (you, the human)

1. Build + run this extension in an Extension Development Host (or install the
   VSIX from this branch).
2. Register a test connection (Small Peers Only with a throwaway offline token
   is fine — nothing needs to leave the machine).
3. Edit Configuration → Advanced → **MCP Server (AI Access)** → **ON** → Save.
4. Connect.
5. `curl http://127.0.0.1:65270/health` → `OK`. Status bar shows
   `⎇ plug Ditto MCP :65270`.
6. Point your agent at the server (per-client snippets:
   `plugins/ditto-edge-studio-vscode/README.md`). Copilot agent mode needs no
   config; the tools should show in its picker.
7. Give the agent the skill file
   (`plugins/ditto-edge-studio-vscode/skills/use-edge-studio-vscode/SKILL.md`)
   if the client supports skills; otherwise paste section "Rules of engagement"
   into the chat.

## 1. The script to paste to the agent

Replace `<REPO>` with the absolute path of this repo checkout. Paste as one
message:

```text
You are validating the Ditto Edge Studio MCP server. Use ONLY its tools
(list them first with your client's tool discovery; they are the
ditto-edge-studio-vscode server / `mcp__ditto-edge-studio__*` in Copilot).
Work through every step IN ORDER and produce a results table at the end with
PASS/FAIL and the one-line evidence for each step. If a step's tool call
fails, record FAIL with the error text and CONTINUE with the remaining steps.

Dataset file (JSON array): <REPO>/plugins/ditto-edge-studio-vscode/fixtures/mcp-validation-data.json

S1. get_active_database → report the connection name, databaseId, mode, and
    confirm there is no token/key value anywhere in the payload.
S2. list_databases → count how many connections are registered; confirm the
    payload shape is {id,name,databaseId,mode,status} only.
S3. list_collections → note whether mcp_tasks exists yet and its documentCount.
S4. insert_documents_from_file { file_path: the dataset file, collection:
    "mcp_tasks", mode: "insert" } → expect inserted=6, failed=0.
S5. execute_dql "SELECT COUNT(*) AS n FROM mcp_tasks" → expect n = 6.
S6. execute_dql "SELECT * FROM mcp_tasks WHERE assignee = 'ada' ORDER BY
    priority" → expect exactly 3 rows: mcp-task-1, mcp-task-3, mcp-task-6.
S7. create_index { collection: "mcp_tasks", fields: [{name:"done"},
    {name:"priority", direction:"DESC"}] } → expect outcome:"created" AND a
    top-level "index" field with the generated name (save it for S20).
    Call it AGAIN → expect outcome:"already-exists" with the same name.
S8. explain_query "SELECT * FROM mcp_tasks WHERE done = false ORDER BY
    priority DESC" → report whether the plan can use the new index.
S9. execute_dql "UPDATE mcp_tasks SET done = true WHERE _id = 'mcp-task-6'"
    → report mutatedDocumentIds (expect ["mcp-task-6"]) and commitId.
S10. get_sync_status → report sync state and transport toggles.
S11. get_peers → report peer count (0 is fine on a solo test rig) and confirm
    no metadata VALUES appear (only key counts).
S12. list_subscriptions FIRST and note the baseline count N (any number is
    fine — real connections may already have subscriptions). Then
    add_subscription { name: "open tasks", query: "SELECT * FROM mcp_tasks
    WHERE done = false" } → expect registered:true and an id in the response.
    list_subscriptions again → N+1, and the new id is present. Then
    remove_subscription by that id → removed:true, and a final list is back
    to N. (If the active connection is brand new N will be 0, but never
    assert that N is anything in particular.)
S13. add_observer { name: "all tasks", query: "SELECT * FROM mcp_tasks" } →
    list_observers → 1 entry → remove_observer → removed:true.
S14. get_system_metrics (call it twice, a few seconds apart) → report status
    kind and confirm the second call's sinceConnect totals are ≥ the first.
S15. get_database_metrics → report totalDiskBytes and the mcp_tasks
    documentCount from collectionBreakdown (expect 6).
S16. get_app_logs { lines: 20, filter: "mcp" } → return however many lines
    matched (0+ is a PASS — SDK log levels vary).
S17. query_log_analyzer { level: "all", limit: 5 } → expect a paged result
    with total and items fields.
S18. resources: read ditto://schema and ditto://sync-status → schema lists
    mcp_tasks with documentCount 6.
S19. watch_query { query: "SELECT * FROM mcp_tasks WHERE done = false",
    duration_ms: 3000 } → expect ≥1 event; NOTE: the FIRST event is the
    initial result set, not a change.
S20. execute_dql "EVICT FROM mcp_tasks WHERE true" (cleanup) → 6 removed;
    then list_collections → mcp_tasks gone or 0 docs; then drop_index
    { index_name: <the name S7 returned in its "index" field>, collection:
    "mcp_tasks" } → dropped (or a clean "no such index" if the collection
    carried it away — both acceptable; say which happened).

If your client has no resources support, mark S18 SKIP and note it.
Do NOT use connect_database, disconnect_database, debug_socket_query,
configure_transport, set_sync, or fetch_attachment in this run — those paths
are exercised by the human checklist below.
```

### Expected self-report

The agent should end with a 20-row table. Any FAIL row should include the
verbatim error. Common FAIL causes you can sanity-check instantly:

| FAIL on | Likely cause | Check |
|---|---|---|
| everything (tool errors = "No active connection") | nothing connected, or agent is talking to the SwiftUI app on 65269 | `curl localhost:65270/health`; `get_active_database` name |
| everything (connection refused) | flag off / wrong port | status bar item visible? Settings → `dittoVsce.mcpServer.port` |
| S4 | wrong `<REPO>` path substituted | path must exist; file is a JSON array |
| S7 second call fails with "different definition" | direction casing — expected `already-exists`; a hard error here is a REAL bug | report it |
| S14 `exporterDisabled` | connection opened before `collectSystemMetrics` was on | reconnect, re-run only S14 |
| S18 SKIP | client has no resources support | acceptable for that client; verify with Copilot or curl |

## 2. Your independent verification (don't trust the agent's table)

After the run:

1. **Query Editor:** `SELECT * FROM mcp_tasks` → empty (S20 cleaned up). The
   **Connections tree → mcp_tasks** row is gone (or shows 0 documents).
2. **Tree → Subscriptions** on the test connection → empty (S12 removed it).
3. **Tree → Observers** → empty (S13 removed it).
4. **Logs:** Command Palette → **Ditto: Open Output Channel** → the run's
   activity is logged; no credential values anywhere.
5. **Security spot-check:** the S1 payload shows `httpApiConfigured: false`
   and *no* token/key material.

## 3. Human checklist for the paths the script deliberately skips

These change global/session state, so they stay manual:

- **connect/disconnect roundtrip:** with the server running, ask the agent
  (or run yourself via curl against `/mcp`) `disconnect_database` → status bar
  item disappears, `/health` refuses; `connect_database {id_or_name}` back to
  the flagged connection → item returns, `/health` OK.
- **Switch safety:** connect_database to a second *flagged* connection → works;
  to an *unflagged* one → the server stops mid-session (expected! re-flag it or
  switch back).
- **fetch_attachment:** insert a document with an attachment via the Inspector,
  find its token via `execute_dql`, then ask the agent to
  `fetch_attachment` to a scratch path with `overwrite:false` — the file lands
  on disk; a second call without overwrite fails cleanly.
- **debug_socket_query:** with an app under development, apply
  `ALTER SYSTEM SET debug_socket = '/tmp/ditto-debug.sock'` to it, then
  `debug_socket_query { socket_path: '/tmp/ditto-debug.sock', statement:
  'SELECT * FROM system:data_sync_info' }` → rows.
- **Copilot picker:** with the server running, open Copilot agent mode →
  tools menu → `ditto-edge-studio` present with 31 tools; stop the server →
  it vanishes on next refresh.

## 4. What a green run means

- Transport: initialize/tools/list/tools/call over stateful sessions (+ legacy
  SSE for Codex/older clients) all work against a live Ditto instance.
- Every domain tool reads/writes the same store the panels show you (you
  watched the tree update).
- The destructive cleanup left no residue and credentials never surfaced.
