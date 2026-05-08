# Manual Testing Guide

## Setup (one-time)

1. Install Node ≥ 20 and VS Code ≥ 1.95.
2. Clone or open this repo at `/Users/labeaaa/Developer/ditto-vsc-es`.
3. Copy `.env.example` to `.env` and fill in your Ditto Cloud credentials:
   - `DITTO_APP_ID` — your app ID from https://portal.ditto.live
   - `DITTO_PLAYGROUND_TOKEN` — playground token
   - `DITTO_AUTH_URL` — auth endpoint URL
   - `DITTO_WEBSOCKET_URL` — websocket endpoint URL
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

**Expected:** The Databases view appears with no entries. Clicking the `＋` button shows a transient info message about "Register Database — not implemented yet".

### T3 · Open the Database Editor panel (UI placeholder)

**Steps:**
1. Press `F5`.
2. Open the Ditto sidebar; click the `＋` button in the Databases title bar.

**Expected:** A new editor tab opens with title "Register Database" containing the text "Database editor — UI under construction." (UI replaced in T4.)

### T4 · Register a database

**Pre-conditions:** none.

**Steps:**
1. Press `F5`.
2. Click `＋` in the Databases view title bar.
3. With Server selected, fill in `Name` = "test-cloud", `Database ID` = your real Ditto app ID, `Token` = your playground token, `Auth URL` = your auth URL, `Websocket URL` = your websocket URL.
4. Click Save.

**Expected:**
- Panel closes; toast "Saved database 'test-cloud'." appears.
- Databases view shows a new row: `○ test-cloud (Server, idle)`.

**Edit flow:**
5. Right-click the row → "Edit Configuration".
6. The editor reopens prefilled. Change the name to "test-cloud-renamed" → Save.
7. The row updates to `○ test-cloud-renamed`.

**Delete flow:**
8. Right-click the row → "Delete" → confirm.
9. The row disappears.

**Small Peers Only mode:**
10. Repeat with Small Peers Only — confirm only the Optional Shared Secret Key section is visible (no Auth/Websocket URL fields).

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
5. Click `Presence Graph` segment. See the "Coming soon" placeholder.

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
