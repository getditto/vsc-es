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
