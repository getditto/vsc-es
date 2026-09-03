# Manual Testing Guide

## Setup (one-time)

1. Install Node ≥ 20 and VS Code ≥ 1.95.
2. Clone or open this repo at `/Users/labeaaa/Developer/ditto-vsc-es`.
3. Copy `.env.example` to `.env` and fill in your Ditto Cloud credentials:
   - `DITTO_DATABASE_ID` — your Database ID from https://portal.ditto.live
   - `DITTO_DEVELOPMENT_TOKEN` — Development Token
   - `DITTO_URL` — your Ditto app URL from https://portal.ditto.live
4. Run `npm install`.
5. Run `npm run build` (or `npm run watch` for auto-rebuild).

## Running the extension

Open the project in VS Code and press `F5`. A new "Extension Development Host" window opens with the extension loaded. View output via `View → Output → Ditto Edge Studio`.

To reload after a code change: with the Extension Development Host focused, press `Cmd+R` (macOS) / `Ctrl+R` (Windows/Linux).

## Test recipes

### T1 · SDK Smoke Test (Spike)

**Purpose:** Verify the `@dittolive/ditto` SDK loads and connects from inside VS Code's Electron Node runtime.

**Pre-conditions:** `.env` is populated with valid Ditto Cloud credentials.

**Steps:**
1. Press `F5` in the main VS Code window.
2. In the Extension Development Host, open the Output panel and select "Ditto Edge Studio" from the dropdown.

**Expected:** The output panel shows, in order:
```
Ditto Edge Studio extension activated.
SPIKE: opening Ditto…
SPIKE: login OK
SPIKE: sync started
SPIKE: inserted doc into vsce_smoke
SPIKE: observer saw 1 doc(s): [...]
```

If you see `SPIKE: failed: …` followed by a stack trace, the SDK is not loading correctly in this environment. **Stop here and resolve before continuing the implementation plan.** Common causes: missing native binary for your platform/arch, mismatched Node version, ESM/CJS interop error.

### T2 · Tree view shows the empty state

**Steps:**
1. Press `F5`.
2. Click the Ditto icon in the activity bar of the Extension Development Host.

**Expected:** The Connections view appears with no entries. Clicking the `＋` button shows a transient info message about "Register Connection — not implemented yet".

### T3 · Open the Database Editor panel (UI placeholder)

**Steps:**
1. Press `F5`.
2. Open the Ditto sidebar; click the `＋` button in the Connections title bar.

**Expected:** A new editor tab opens with title "Register Database" containing the text "Database editor — UI under construction." (UI replaced in T4.)

### T4 · Register a database

**Pre-conditions:** none.

**Steps:**
1. Press `F5`.
2. Click `＋` in the Connections view title bar.
3. With Server selected, fill in `Name` = "test-cloud", `Database ID` = your real Ditto Database ID, `Token` = your Development Token, `URL` = your app URL from the Portal.
4. Click Save.

**Expected:**
- Panel closes; toast "Saved connection 'test-cloud'." appears.
- Connections view shows a new row: `○ test-cloud (Server, idle)`.

**Edit flow:**
5. Right-click the row → "Edit Configuration".
6. The editor reopens prefilled. Change the name to "test-cloud-renamed" → Save.
7. The row updates to `○ test-cloud-renamed`.

**Delete flow:**
8. Right-click the row → "Delete" → confirm.
9. The row disappears.

**Small Peers Only mode:**
10. Repeat with Small Peers Only — confirm only the Optional Shared Secret Key section is visible (no URL field).

### T4a · Advanced configuration and collection sync scopes

**Pre-conditions:** A registered database with valid credentials (T4).

**Steps:**
1. Edit the database and confirm **Advanced Configuration** starts collapsed.
2. Expand it. Confirm SDK Log Level and DQL Strict Mode are inside the section.
3. Add these collection rows: `mesh_orders` → Small Peers Only, `audit_logs` → Big Peer Only, and `drafts` → Local Peer Only.
4. Confirm a blank row, a duplicate collection, and a name beginning with `__` disable Save and show an actionable validation message.
5. Remove the invalid row, save, reopen the editor, and confirm all valid rows and their order persist.
6. Connect, open Query Editor, and run `SHOW USER_COLLECTION_SYNC_SCOPES`.

**Expected:**
- The advanced summary reports `3 scopes`.
- `SHOW USER_COLLECTION_SYNC_SCOPES` returns the three configured values.
- Output logs that three collection sync scopes were applied before sync started.

**Reconnect behavior:**
7. While connected, edit `drafts` to All Peers and save.
8. Run `SHOW USER_COLLECTION_SYNC_SCOPES` again; it still reports Local Peer Only for the live instance.
9. Disconnect and reconnect, then rerun the command; it now reports All Peers.

### T4b · Startup system settings

**Pre-conditions:** A registered database with valid credentials (T4).

**Disconnected/create behavior:**
1. Open the database editor while disconnected and expand **Advanced Configuration**.
2. Add `DQL_CONCURRENT_REQUEST_LIMIT` as Integer with value `10`.
3. Confirm no reconnect warning appears, save, reopen, and confirm the row persists.
4. Connect and run `SHOW DQL_CONCURRENT_REQUEST_LIMIT` in Query Editor.

**Expected:**
- The parameter reports `10` and was applied before sync started.
- Output logs the parameter name but not its configured value.

**Connected edit and warning behavior:**
5. Edit the active connection and confirm **Add startup setting** uses parameters loaded from `SHOW ALL`.
6. Add a setting and confirm an inline **Reconnect required** warning reports one addition.
7. Remove an existing setting and confirm the warning reports the addition and removal.
8. Restore the settings to their original state and confirm the warning disappears.
9. Change a setting again and save.

**Expected:**
- A VS Code warning says the connection must be disconnected and reconnected.
- `SHOW` still reports the old live value immediately after saving.
- After disconnecting and reconnecting, `SHOW` reports the saved value.
- Canceling instead of saving discards additions, edits, and removals.

**Validation and failure:**
10. Confirm blank, duplicate, reserved (`DQL_STRICT_MODE`), malformed JSON, and invalid parameter names disable Save with an actionable error.
11. Save a syntactically valid but unsupported parameter, then attempt to connect.
12. From the active editor, capture representative Boolean, Integer, String, and JSON rows from the real `SHOW ALL` result and apply one supported value of each type.
13. Configure two supported settings followed by one unsupported setting; connect and confirm startup aborts after the failure without starting sync or subscriptions.
14. Remove a previously applied setting, disconnect, and reconnect using the same database entry and persistence directory; use `SHOW` to confirm the removed setting returns to its SDK default.

**Expected:**
- The connection fails before sync and subscriptions start, and the error identifies the failing parameter without logging its value.
- `SHOW ALL` rows materialize into the expected parameter/value document shape, all four bound value types apply successfully, and duplicate or non-safe-integer rows do not create ambiguous editor options.
- A partial startup-setting failure never crosses the sync-start boundary.
- Removed settings are not retained accidentally when the same on-disk Ditto store is reopened.

### T5 · Connect & disconnect

**Pre-conditions:** A registered database with valid credentials (T4).

**Steps:**
1. Right-click the database row → "Connect".

**Expected:**
- Status dot transitions `○` → `◐` → `●` within a few seconds.
- Row auto-expands showing `Subscriptions` and `Peer Listing` children.
- Output panel logs `Connected to "<name>".`

**Disconnect:**
2. Right-click the active row → "Disconnect".
3. Status dot returns to `○` and children collapse.
4. Output logs `Disconnected.`

**Error path:**
5. Edit the database, change Token to garbage, save. Right-click → Connect.
6. Expect dot transitions `○` → `◐` → `⊗` (error). Toast `Connect failed: …`. Output logs the failure.

### T6 · Peer Listing panel

**Pre-conditions:** A database connected (T5).

**Steps:**
1. Expand the active database.
2. Click `Peer Listing`.

**Expected:**
- A new editor tab opens labeled `Peers — <name>`.
- Header: green dot + "Sync Active" + Stop Sync button.
- "Connected Peers" tab is active. The Local Peer card shows your device name, SDK language (JS), platform (Node), version.
- If other Ditto peers are on the same LAN or your Cloud has connected peers, their cards appear in the grid with peer ID, OS, SDK version, connection types, last update.

**Sync toggle:**
3. Click "Stop Sync". The dot turns red and the button label becomes "Start Sync". Wait a few seconds. Remote peer cards may disappear as the sync session tears down.
4. Click "Start Sync". Sync resumes; cards repopulate.

**Presence Graph tab:**
5. Click the `Presence Graph` segment. The graph renders (recipe 12 below
   covers it in detail) — this step is only checking the tab switch.

### T7 · Add, edit, and delete subscriptions

**Pre-conditions:** A database connected (T5).

**Add:**
1. Hover over `Subscriptions` in the tree; click the `＋` button.
2. Enter Name = "tasks-all", Query = `SELECT * FROM tasks`. Click Save.

**Expected:**
- Toast "Saved subscription 'tasks-all'." appears.
- Tree shows `tasks-all   SELECT * FROM tasks` as a leaf under `Subscriptions`.

**Edit:**
3. Right-click the leaf → "Edit Subscription".
4. Change Name to "tasks-renamed". Save.
5. Tree leaf updates.

**Delete:**
6. Right-click → "Delete Subscription" → confirm.
7. Leaf disappears.

### T8 · Subscriptions persist across reconnect

**Pre-conditions:** A database connected (T5) with at least one subscription saved (T7).

**Steps:**
1. Right-click the active database → "Disconnect".
2. Right-click again → "Connect".

**Expected:**
- Status dot transitions through `◐` to `●`.
- The subscription leaves remain visible after reconnect.
- Output panel does not show any "Failed to register subscription" messages.
- (Optional) If you have another Ditto peer (your SwiftUI app) inserting into the subscribed collection, verify the data syncs into the VS Code Ditto instance — there's no inline collection viewer in the POC, but you can confirm via the presence observer activity in Output if your SDK build emits that level of logging at `debug` log level.

### T9 · Peer Listing — real data, SwiftUI parity

**Pre-conditions:** A database connected (T5). For full verification, run the SwiftUI Ditto Edge Studio against the same database concurrently, or have another peer (mobile app, second machine) sync.

**Steps:**

1. Click `Peer Listing` tree leaf.
2. **Local Peer card** (black gradient, top-left of grid):
   - `Device Name = "VS Code"`.
   - `SDK Language`, `SDK Platform`, `SDK Version` — populated with real values from `__small_peer_info`. No "unknown" anywhere.
3. **Remote peer cards** (with at least one other peer reachable):
   - Card gradient color matches dominant connection type:
     - Cloud (purple) when connected via Ditto Server / WebSocket.
     - Orange for WebSocket-only.
     - Green for AccessPoint (LAN).
     - Red for P2P WiFi.
     - Blue for Bluetooth.
     - Gray for unknown.
   - `Ditto SDK: <version>` row shows real version, NOT "unknown".
   - At least one connection badge with a real type (`Bluetooth` / `WebSocket` / `WiFi AP` / `P2P WiFi`), NOT "unknown".
   - Status dot is green (or orange/red per actual session state).
   - "Last update" timestamp updates as data flows. Stays "just now" / "3:49 PM" / "Mar 5, 3:49 PM" depending on staleness.
4. Stop the SwiftUI peer (or other peer) → its card animates away within ~250ms.
5. Restart it → card animates back in. Position is preserved across re-renders for already-known peers.
6. Click Stop Sync → sync session status transitions through `Disconnected`. Cards stay visible (presence still observed). Click Start Sync → resumes.
7. Double-click any peer ID → it briefly flashes green (copied to clipboard).
8. Open the **Presence Graph** tab with at least two reachable peers:
   - The connection legend, Direct switch, zoom controls, center button, and eye button are visible.
   - Tab through the controls. Each interactive control has a visible focus indicator and an understandable accessible label/tooltip in both light and dark themes.
9. Click the eye button:
   - The legend, Direct switch, and zoom controls disappear, leaving more room for the graph.
   - The center and eye buttons remain available.
   - Click the eye button again → every hidden control returns.
10. Zoom and pan the graph, then click the center button:
    - Zoom returns to 100%.
    - The local **Me** peer is centered, including after manually dragging it away from its original position.
11. With **Direct** enabled, click a remote peer without dragging it:
    - That peer, the local peer, and every connection between them stay at full opacity.
    - Unrelated peers and connections become semi-transparent.
    - Clicking the selected peer again or clicking open canvas space restores normal opacity everywhere.
    - Turn **Direct** off and click a remote peer in the full mesh:
      - The selected peer and every peer connected to it stay prominent.
      - Connections not touching the selected peer dim while retaining their connection-type colours.
      - Clicking the selected peer again or clicking open canvas space clears the full-mesh focus.
12. Verify interaction and live-update edge cases:
    - Dragging a peer moves it without being mistaken for a selection click.
    - Turning **Direct** off clears any selection and shows the full graph normally.
    - Removing a selected peer clears focus without leaving other peers dimmed.
    - Resize the panel narrow and wide; controls remain usable and do not obscure recovery actions.
    - Close the panel during or after a drag and reopen it; the cursor and graph interaction are not stuck.
    - Clicking the local **Me** peer selects nothing — no peer dims and no connection thickens.
      With **Direct** enabled, hovering **Me** likewise dims nothing and thickens no
      connections; only its own pill shows the hover fill. (With Direct off, hovering
      **Me** emphasizes its connections like any other peer.)
13. Verify state survives the tab round-trip (each of these was a real defect):
    - Uncheck **Direct**, switch to *Connected Peers*, switch back. The box is
      still unchecked **and** multi-hop peers are still shown — the two must agree.
    - Hide the controls with the eye, round-trip the tabs, and confirm they are
      still hidden.
14. Verify the graph never gets stuck dimmed:
    - Hover a peer (unrelated peers dim), then move the pointer onto the Direct
      switch, the zoom controls, and off the panel entirely. Full opacity returns
      each time; the graph never stays dimmed once the pointer is away.
    - Start dragging a peer, release the mouse button outside the VS Code window,
      then move back over the canvas. The peer stops following the cursor, and a
      peer joining afterwards animates to its ring position instead of being
      stranded on top of **Me**.
    - Start dragging a peer, then press and release the right mouse button while
      still holding the left. The drag continues and no peer becomes selected.
    - After releasing outside the window, move back over the canvas: no peer
      becomes selected, and an existing selection is not silently cleared.
    - Drag a peer off the canvas edge and release there. Full opacity returns —
      the peer you were dragging must not stay latched as hovered.

> The following can only be checked by eye — jsdom performs no layout, cascade,
> or hit-testing, so the automated suite cannot cover CSS behaviour at all.

15. Verify cursors and pointer targets:
    - Hovering a peer shows a pointer cursor; pressing and dragging shows
      `grabbing` (not `pointer`) for the whole drag.
    - Hover a peer, then move the pointer through the *gaps between* the control
      groups in the bottom-right. The graph returns to full opacity rather than
      staying dimmed — the overlay container must not swallow those events.
    - Every control in that cluster is still clickable: Direct, both zoom
      buttons, center, and eye.
16. Switch VS Code to a **light** theme and reopen the Presence Graph:
    - The legend, Direct/zoom groups, and the center/eye buttons are all legible
      against their own backgrounds — check especially with the controls hidden,
      when the two icon buttons are the only thing on screen.

### T10 · DQL Query Editor

**Pre-conditions:** A database connected (T5).

**Steps:**

1. Click `Query Editor` tree leaf → panel opens with empty textarea and "Run a query to see results." empty state.
2. Type `SELECT * FROM __small_peer_info` → press `Cmd+Enter` (or click Run).
3. Confirm: results header shows `"1 row · <n> ms"`. Table renders with columns including `ditto_sdk_language`, `ditto_sdk_platform`, `ditto_sdk_version` and one row populated.
4. Click the `JSON` toggle → same data as a JS array.
5. Type a malformed query (`SELECT * FORM books`) → press Run. Confirm red error banner with the SDK's parse error. Textarea content preserved. Press `Escape` → banner clears.
6. Type `SELECT * FROM tasks` (or any collection where you've inserted data via the SwiftUI app or another peer) → confirm real document rows back.
7. Run a query with heterogeneous documents (e.g., nested objects). Confirm columns reflect the union of keys; missing-key cells render empty; nested values render as `JSON.stringify` strings truncated at 120 chars with full value in tooltip.

### T11 · Inspector basic flow

**Pre-conditions:** registered DB (T4), connected (T5).

**Steps:**

1. Open Query Editor (click `Query Editor` leaf in tree).
2. **First time only**: the auxiliary bar slides open showing the Inspector. (Subsequent opens won't auto-reveal.)
3. Inspector shows the Query Inspector with 5 tabs: History, Favorites, JSON, Metrics, Help. Default tab: History (or last selected per-DB).
4. Switch tabs by clicking the icons; each tab renders its empty state until populated.
5. Close the Query Editor tab. Inspector auxiliary bar stays open but content shows "No active database" (briefly) or the last sticky kind.
6. Reopen Query Editor → Inspector swaps content back. Last-selected tab is preserved per-DB.

### T12 · Query Editor + Inspector roundtrip

**Pre-conditions:** T11 just completed.

**Steps:**

1. In Query Editor, type `SELECT * FROM tasks` (or any valid DQL) and click Run.
2. Verify Inspector History tab now shows that query.
3. Click the query row in History → query loads into Query Editor textarea.
4. Click a result row in the Query Editor's results table → Inspector JSON tab updates with the row's JSON.
5. Click the star button on the Query Editor toolbar → query appears in Favorites tab.
6. Switch to Metrics tab → Time, Results, Index, EXPLAIN block populated.
7. Click a History entry's hover Trash icon → entry removed.

### T13 · Attachment fetch

**Pre-conditions:** a collection containing at least one document with an attachment field (image and non-image both helpful).

**Steps:**

1. Run `SELECT * FROM <collection-with-attachments>`.
2. Click a result row → JSON tab shows JSON; below it, Attachment Viewer lists each detected attachment with metadata + Fetch button.
3. Click Fetch on an image attachment → progress flickers → image renders inline.
4. Click Fetch on a non-image attachment → "Save…" button appears. Click → save dialog → write to disk → confirmation.

### T14 · Inspector + DB switch

**Pre-conditions:** two DBs registered.

**Steps:**

1. Connect db-A. Open Query Editor; populate History with a couple of queries.
2. Switch to db-B (per Lifecycle T17 flow).
3. During the switch, Inspector goes blank or shows the brief `kind: 'none'` empty state.
4. After db-B activates, Query Editor is restored only if db-B's panel set has it; Inspector content tracks the focused panel.
5. Switch back to db-A → Inspector History tab shows db-A's prior history (proving per-DB persistence).

### T15 · Inspector + DB delete

**Pre-conditions:** db-A connected with Query history populated.

**Steps:**

1. Right-click db-A → Delete → confirm.
2. Tree shows no row; auxiliary bar Inspector hides (`when` clause).
3. Re-register db-A with same config; connect.
4. Inspector History is empty (deleteDatabase cleared the per-DB stores).

### T17 · Switch with open panels

**Pre-conditions:** two registered databases (db-A, db-B) with valid credentials.

**Steps:**

1. Connect db-A.
2. Open Query Editor and Peer Listing for db-A.
3. Right-click db-B in the tree → Connect.

**Expected:**
- Modal warning: "Switching to db-B will close 2 open panels for db-A: • Query — db-A • Peers — db-A — These will reopen automatically the next time you connect to db-A. [Cancel] [Switch]".
- Click **Switch** → notification fires bottom-right; status bar shows `$(sync~spin) Ditto: …` through phases.
- db-A's panels close.
- db-B activates; tree shows `● db-B`.
- No panels reopen for db-B (its set is empty on first connect).

### T18 · Round-trip restoration

**Pre-conditions:** continuing from T17.

**Steps:**

1. Click db-A in the tree.

**Expected:**
- No warning modal (db-B's open-panel set is empty).
- Notification + status bar progress fire.
- db-A activates; **Query Editor and Peer Listing tabs reopen automatically.**

### T19 · Switch failure with rollback

**Pre-conditions:** db-A registered with valid creds; db-B registered with an intentionally bad token.

**Steps:**

1. Connect db-A.
2. Right-click db-B → Connect.

**Expected:**
- Switch starts (warning modal skipped if no panels open, or accept it).
- After db-A teardown completes, db-B activation fails.
- Rollback modal: "Connect to db-B failed: <reason>. Reconnect to db-A? [Reconnect to db-A] [Stay disconnected]".
- Click **Reconnect to db-A** → notification updates to "Reconnecting…" → db-A reactivates with its panels restored.

### T20 · Switch failure, stay disconnected

**Pre-conditions:** same as T19.

**Steps:**

1. Connect db-A.
2. Right-click db-B → Connect.
3. On rollback modal, click **Stay disconnected**.

**Expected:**
- State ends at idle: tree shows db-A as `○ idle` and db-B as `⊗ error`.
- No panels are open.
- Output channel logs both phases of the failed switch + the user's choice.

### T21 · Double-click protection

**Pre-conditions:** three registered databases.

**Steps:**

1. Connect db-A.
2. Right-click db-B → Connect.
3. Within the first second (while progress notification is showing), right-click db-C → Connect.

**Expected:**
- The second click shows transient "Switch in progress — please wait." info message.
- The first switch completes uninterrupted; db-B becomes active.
- After db-B is active, right-clicking db-C → Connect works normally and triggers a new switch.

### T22 · Plain disconnect with restore

**Steps:**

1. Connect db-A.
2. Open Query Editor and Peer Listing.
3. Right-click db-A in the tree → Disconnect.
4. Right-click db-A → Connect.

**Expected:**
- Step 3: notification "Disconnecting from db-A…" fires; panels close; tree shows `○ db-A`.
- Step 4: notification "Connecting to db-A…" fires; db-A activates; **Query Editor and Peer Listing tabs reopen automatically.**

### T16 · Logging — basic flow + export

**Pre-conditions:** none.

**Steps:**

1. Press `F5`. Open the Ditto sidebar; verify three panels: **Connections**, **Logging**, **Help**.
2. In the **Logging** panel: click **Application Log Level** → quick-pick opens with five levels and `info` marked. Choose `debug`. Description updates to `debug` immediately.
3. Click **Open Output Channel** — the Ditto Edge Studio channel opens, showing previously-logged lines tagged `[ext:...]`, `[sdk]`, `[webview:...]`.
4. Connect a database, run a query, click a few panels. New lines appear with timestamps + tags + levels.
5. Click **Ditto SDK Log Level** → choose `verbose`. SDK lines start showing more detail.
6. Click **Export Logs for Bug Report…** → confirm modal warning → "Open in Editor" → new untitled doc opens, language `log`.
7. Save the document somewhere — verify file roundtrips cleanly.
8. In **Help** panel: click each link, verify it opens the right URL in the system browser.
9. Disconnect, then reconnect. Verify the SDK level reverts to the per-DB config default (not the live `verbose` we set).
10. Lower channel level back to `info` via Logging panel; subsequent `debug`/`trace` lines stop appearing in the channel but **still appear in the file**.

### T23 · Debug Socket Console (SDK 5.1 `debug_socket`)

**Pre-conditions:** macOS or Linux (no debug socket on Windows). You need an app
running Ditto **SDK 5.1+** with the debug socket enabled. The repo ships a
ready-made one — the test injector (`scripts/test-injector/`):

```sh
npm run injector:generate -- --collection=tasks --count=200
npm run injector:run -- --collection=tasks --debug-socket=/tmp/my-app-ditto-debug.sock
```

Any other 5.1+ app works too — e.g. a quickstart app with this added after
opening Ditto:

```text
ALTER SYSTEM SET debug_socket = '/tmp/my-app-ditto-debug.sock'
```

(The socket path must be absolute, the parent directory must exist, and the path
must be ≤ 104 bytes on macOS.) The extension's own Ditto connection is irrelevant —
this console attaches to the APP's SDK, so test it with nothing connected in the
extension.

The offline unit suite covers the client protocol against a fake server
(`src/test/DebugSocketClient.test.ts`) and panel message traffic (ditto
`DebugConsolePanel.test.ts`), but only a real app exercises the SDK-side listener,
so this recipe cannot be automated locally.

**Steps:**

1. Command Palette → `Ditto: Open Debug Console` → panel opens with:
   the warning banner ("Statements run live … not a sandbox"), a `Disconnected`
   pill, and an empty-state history area.
2. Enter a relative path (`tmp/app.sock`) → Connect → error appears in the panel
   ("must be an absolute path"); no error dialog.
3. Enter the app's socket path (`/tmp/my-app-ditto-debug.sock`) → Connect →
   pill flips to `Connected`.
4. Run `SELECT * FROM system:data_sync_info` (press Enter) → run card appears:
   statement, `N items · M ms`, and a table with the sync-info row.
5. Run a mutation to prove full DQL is live, e.g.
   `INSERT INTO cars DOCUMENTS ({"_id":"dbg1","make":"Test"})` → ok card; then
   `SELECT * FROM cars` shows the document (and it is visible in the app itself).
6. Run `SELECT *** FROM cars` → error run card shows the SDK's
   `ERROR: Parse error…` line in the panel (no dialog).
7. Run several statements quickly — cards stack newest-first; the input clears
   after each run. Shift+Enter does NOT run.
8. Disconnect via the button → pill `Disconnected`; Run is disabled. Re-run →
   "Not connected" run card.
9. Kill the app while connected (or `ALTER SYSTEM RESET debug_socket` in the app)
   → pill flips to `Disconnected` with a socket-closed error; Run re-arms after
   reconnecting (no stuck "Running…").
10. Try a path longer than 104 bytes → the in-panel path warning appears; on
    macOS the app itself will have failed to bind, so connect fails too.

## What is covered automatically

Before adding a recipe here, check whether it belongs in `npm test` instead —
most things do. The suite already covers, without a human:

- **Emitted DQL, against a real store.** `src/test/dql-live.test.ts` opens a
  real Ditto in `smallPeersOnly` mode against a temp directory — no
  credentials, no license, and `sync.start()` is never called, so nothing
  leaves the machine. It asserts insert/select round-trips, `createIndex` /
  `dropIndex`, nested field paths, `importDocuments`, the query-editor prefill,
  and `COUNT(*)` hydration for collection names like `order-items`, `two
  words`, `Ünïcödé` and `9lives`. If you are about to hand-verify a DQL change,
  add a case there instead.
- **Panel error surfacing.** `src/test/panel-error-surfacing.test.ts` proves a
  rejected or throwing webview handler is both logged and shown to the user,
  and that every panel routes through `webviewMessageHandler` — so a new panel
  copied from an old one cannot reintroduce the silent-failure bug.
- **Panel lifecycle.** `src/test/QueryEditorPanel.dispose.test.ts` drives the
  webview-panel fake in `scripts/vscode-stub.mjs` (`createdWebviewPanels`,
  `__resetStub()`), covering tracker-slot release on user close versus
  orchestrated teardown. Any panel is testable this way.
- **Manifest invariants.** `src/test/manifest.test.ts` asserts the
  `engines.vscode` floor required by the `secondarySidebar` container, that
  every menu entry names a declared command, that every `views` key resolves to
  a real container, the machine scope on `logAnalyzer.customPatternsFile`, and
  the workspace-trust declarations.
- **Log Analyzer state transitions**, including that Clear empties the Sessions
  view and does not resurrect pre-Clear history
  (`src/test/LogAnalyzerService.test.ts`).

What genuinely needs a human is below: anything requiring layout, the cascade,
hit-testing, real peer-to-peer transports, or a judgement about how something
looks. jsdom performs no layout, so CSS behaviour in particular cannot be
covered by the automated suite at all.

## Composite index editor (visual only)

The behaviour is covered automatically — `index-builder.test.ts` for the
statement text, `dql-live.test.ts` for the real round-trip including an EXPLAIN
that names the composite index, and `webview/add-index-element.test.ts` for the
editor's rows, reordering and emitted payload. What is left needs eyes, because
jsdom performs no layout:

1. Open **Add Index…** on a collection. Add three fields. The rows stay legible
   at a narrow panel width: the name input flexes, ASC/DESC stays readable, and
   the ↑/↓/✕ buttons stay square and reachable.
2. The ↑ on the first row and ↓ on the last are visibly disabled, not just
   inert.
3. In a **light** theme, the row buttons and the ASC/DESC dropdown are legible
   against their own backgrounds.
4. Tab through one row: name → direction → up → down → remove, each with a
   visible focus ring.

## Troubleshooting

### The Output panel shows `SPIKE: failed: …`

The `@dittolive/ditto` native binary couldn't load. Check:
- `node --version` is ≥ 20.
- `ls node_modules/@dittolive/ditto/dist/*.node` lists a binary matching your platform/arch (e.g. `ditto-darwin-arm64.node` on Apple Silicon).
- `npm install` ran without errors.

### Connect transitions `○` → `◐` → `⊗` (error)

Open the Output panel. The error log shows the failing call. Common causes:
- Invalid token (expired or wrong) — re-issue from https://portal.ditto.live.
- Wrong URL.
- No network connectivity.

### Peer Listing shows "No sync status available"

Cause: no Ditto peers are reachable. Either no other peers exist on your LAN / Cloud account, or the SDK's presence observer hasn't yet emitted a snapshot. Wait ~10 seconds, then check.

### Tree view appears empty even though a database was registered

A possible globalState key collision. Open the Command Palette → "Developer: Reload Window" in the Extension Development Host. If still empty, run "Help → Toggle Developer Tools" and inspect `Storage → Local Storage` for the `dittoConfigs.v1` key.

### Reset everything

To wipe stored configs and secrets during development, open the Extension Development Host's Command Palette → "Developer: Reset Extension Host". This clears `globalState` and `SecretStorage` for the dev profile.
