# Ditto Edge Studio — VS Code Extension POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a POC VS Code extension that mimics core Ditto Edge Studio features — register Ditto database configs (server + small-peers modes), securely store credentials, connect to one DB at a time, register subscriptions, and view connected peers — in TypeScript with Lit-based webviews.

**Architecture:** TreeView-driven navigation in the activity bar. Native VS Code APIs (`SecretStorage`, `globalState`) for storage. Lit webview panels for the database registration form, the subscription editor, and the peer listing. Singleton `DittoManager` wraps the `@dittolive/ditto` NodeJS SDK with one active database at a time.

**Tech Stack:** TypeScript (ESM), `@dittolive/ditto` 5.0.0, Lit 3, esbuild (single bundler for extension host + webview UIs), node:test + tsx for unit tests, VS Code Extension API ≥ 1.95.

**Reference spec:** `docs/superpowers/specs/2026-05-08-ditto-edge-studio-vsce-poc-design.md`

**Manual testing docs:** Built incrementally in `docs/MANUAL_TESTING.md` — every task that ships user-visible functionality appends a recipe.

---

## Prerequisites (one-time, before Task 1)

- Node ≥ 20 installed (`node --version`)
- VS Code ≥ 1.95 installed
- Ditto Cloud account with a database and playground token, or local credentials. The reference quickstart at `/Users/labeaaa/Developer/quickstart/javascript-tui/` documents the env-var shape.

---

## Task 1: Project scaffolding

**Goal:** Empty extension that activates and logs to an output channel. Foundation for everything else.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`
- Create: `.gitignore`
- Create: `src/extension.ts`
- Create: `README.md`

- [ ] **Step 1: Initialize git (if not already initialized)**

Run:
```bash
cd /Users/labeaaa/Developer/ditto-vsc-es
git init -b main
```

Expected: `Initialized empty Git repository …` (or "Reinitialized" if it already exists).

- [ ] **Step 2: Create `package.json`**

Create file `package.json`:
```json
{
  "name": "ditto-vsce",
  "displayName": "Ditto Edge Studio",
  "description": "Debug and inspect Ditto databases from VS Code (POC).",
  "version": "0.0.1",
  "engines": { "vscode": "^1.95.0", "node": ">=20" },
  "type": "module",
  "main": "./dist/extension.js",
  "publisher": "ditto",
  "categories": ["Other"],
  "activationEvents": [],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "dittoVsce",
          "title": "Ditto",
          "icon": "$(database)"
        }
      ]
    },
    "views": {
      "dittoVsce": [
        { "id": "dittoDatabases", "name": "Databases" }
      ]
    },
    "commands": []
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "test": "node --import tsx --test 'src/test/**/*.test.ts'",
    "vscode:prepublish": "npm run build"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "@types/vscode": "^1.95.0",
    "esbuild": "^0.23.0",
    "tsx": "^4.16.2",
    "typescript": "^5.5.3"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json`**

Create file `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true
  },
  "include": ["src/**/*", "webview-ui/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `esbuild.config.mjs`**

Create file `esbuild.config.mjs`:
```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', '@dittolive/ditto'],
  sourcemap: true,
  logLevel: 'info'
});

if (watch) {
  await extensionCtx.watch();
  console.log('[esbuild] watching…');
} else {
  await extensionCtx.rebuild();
  await extensionCtx.dispose();
}
```

> Note: We use `format: 'cjs'` for the extension bundle even though `package.json` is `"type": "module"`, because VS Code's extension loader is CJS-friendly and this avoids ESM-interop issues with `@dittolive/ditto`'s native modules. The `.mjs` esbuild config itself is ESM so it can use top-level `await`.

- [ ] **Step 5: Create `.vscode/launch.json`**

Create file `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

- [ ] **Step 6: Create `.vscode/tasks.json`**

Create file `.vscode/tasks.json`:
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": { "kind": "build", "isDefault": true },
      "presentation": { "reveal": "silent" },
      "problemMatcher": ["$tsc"]
    },
    {
      "type": "npm",
      "script": "watch",
      "isBackground": true,
      "presentation": { "reveal": "always", "panel": "dedicated" },
      "problemMatcher": {
        "owner": "esbuild",
        "pattern": [{ "regexp": "^$" }],
        "background": {
          "activeOnStart": true,
          "beginsPattern": ".*\\[esbuild\\] watching.*",
          "endsPattern": ".*build finished.*"
        }
      }
    }
  ]
}
```

- [ ] **Step 7: Create `.gitignore`**

Create file `.gitignore`:
```
node_modules/
dist/
.env
*.log
.DS_Store
```

- [ ] **Step 8: Create `src/extension.ts`**

Create file `src/extension.ts`:
```ts
import * as vscode from 'vscode';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  output.appendLine('Ditto Edge Studio extension activated.');
  context.subscriptions.push(output);
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
```

- [ ] **Step 9: Create a one-line `README.md`**

Create file `README.md`:
```markdown
# Ditto Edge Studio (VS Code) — POC

Debug and inspect Ditto databases from VS Code. See `docs/MANUAL_TESTING.md` for setup and test recipes.
```

- [ ] **Step 10: Install dependencies**

Run:
```bash
npm install
```

Expected: a `node_modules/` directory is created and `package-lock.json` is written.

- [ ] **Step 11: Build the extension**

Run:
```bash
npm run build
```

Expected: prints esbuild summary and creates `dist/extension.js`.

- [ ] **Step 12: Manual verification — launch extension dev host**

1. Open `/Users/labeaaa/Developer/ditto-vsc-es` in VS Code.
2. Press `F5`. A new VS Code window labeled "[Extension Development Host]" opens.
3. In the Extension Development Host window, run `View → Output`, choose "Ditto Edge Studio" from the dropdown.

Expected: the Output panel shows `Ditto Edge Studio extension activated.`

You should also see a database icon in the activity bar of the Extension Development Host. Clicking it opens an empty view container titled "Ditto" with a "Databases" view that says "There is no data provider registered that can provide view data."

- [ ] **Step 13: Commit**

Run:
```bash
git add .
git commit -m "chore: scaffold VS Code extension"
```

---

## Task 2: SDK loadability spike (HARD GATE)

**Goal:** Prove the `@dittolive/ditto` SDK loads and works inside VS Code's Electron Node runtime. **If this fails, stop and fix packaging before any further work.**

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Create: `.env.example`
- Create: `docs/MANUAL_TESTING.md`

- [ ] **Step 1: Add SDK dependencies**

Run:
```bash
npm install @dittolive/ditto@5.0.0 dotenv@^16.4.5
```

Expected: `node_modules/@dittolive/ditto` is created, including native `.node` files under `node_modules/@dittolive/ditto/dist/`.

- [ ] **Step 2: Verify the SDK ships native binaries for your platform**

Run (on macOS):
```bash
ls node_modules/@dittolive/ditto/dist/ | grep -E '\.node$'
```

Expected: a `.node` file matching your arch (e.g. `ditto-darwin-arm64.node`). If empty, the SDK is missing prebuilt binaries for your platform — stop and contact Ditto.

- [ ] **Step 3: Create `.env.example`**

Create file `.env.example`:
```
# Copy this file to `.env` and fill in your Ditto Cloud credentials.
# Get them from https://portal.ditto.live
DITTO_APP_ID=
DITTO_PLAYGROUND_TOKEN=
DITTO_AUTH_URL=
DITTO_WEBSOCKET_URL=
```

- [ ] **Step 4: Manually create `.env` with real credentials**

Copy `.env.example` to `.env` and fill in real values from your Ditto Cloud account or borrow from `/Users/labeaaa/Developer/quickstart/.env` (or wherever the JS quickstart's .env lives):
```bash
cp .env.example .env
# edit .env and fill in the four values
```

`.env` is in `.gitignore` and will not be committed.

- [ ] **Step 5: Replace `src/extension.ts` with the spike**

Replace `src/extension.ts`:
```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { config as loadDotenv } from 'dotenv';
import { Ditto, DittoConfig, Authenticator } from '@dittolive/ditto';

let output: vscode.OutputChannel;
let ditto: Ditto | undefined;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);
  output.appendLine('Ditto Edge Studio extension activated.');
  output.show(true);

  loadDotenv({ path: path.join(context.extensionPath, '.env') });

  const appId = process.env.DITTO_APP_ID;
  const token = process.env.DITTO_PLAYGROUND_TOKEN;
  const authUrl = process.env.DITTO_AUTH_URL;

  if (!appId || !token || !authUrl) {
    output.appendLine('SPIKE: missing env vars; skipping Ditto smoke test.');
    return;
  }

  try {
    output.appendLine('SPIKE: opening Ditto…');

    const persistenceDir = path.join(context.globalStorageUri.fsPath, 'spike');
    fs.mkdirSync(persistenceDir, { recursive: true });

    const config = new DittoConfig(appId, { mode: 'server', url: authUrl }, persistenceDir);
    ditto = await Ditto.open(config);

    ditto.updateTransportConfig((c: any) => {
      c.peerToPeer.bluetoothLE.isEnabled = false;
      c.peerToPeer.awdl.isEnabled = false;
      c.peerToPeer.lan.isEnabled = true;
      c.peerToPeer.lan.isMdnsEnabled = true;
      c.peerToPeer.lan.isMulticastEnabled = true;
    });

    if (ditto.auth.loginSupported) {
      const result = await ditto.auth.login(token, Authenticator.DEVELOPMENT_PROVIDER);
      if (result.error) {
        output.appendLine(`SPIKE: login failed: ${result.error}`);
        return;
      }
      output.appendLine('SPIKE: login OK');
    }

    ditto.sync.start();
    output.appendLine('SPIKE: sync started');

    const observer = ditto.store.registerObserver(
      'SELECT * FROM vsce_smoke',
      (result: any) => {
        const items = result.items.map((i: any) => i.value);
        output.appendLine(`SPIKE: observer saw ${items.length} doc(s): ${JSON.stringify(items)}`);
      }
    );
    context.subscriptions.push({ dispose: () => observer.cancel() });

    const sub = ditto.sync.registerSubscription('SELECT * FROM vsce_smoke');
    context.subscriptions.push({ dispose: () => sub.cancel() });

    await ditto.store.execute('INSERT INTO vsce_smoke DOCUMENTS (:doc)', {
      doc: { hello: 'world', t: Date.now() }
    });
    output.appendLine('SPIKE: inserted doc into vsce_smoke');
  } catch (err) {
    output.appendLine(`SPIKE: failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

export async function deactivate() {
  if (ditto) {
    try {
      ditto.sync.stop();
      await ditto.close();
    } catch { /* ignore */ }
    ditto = undefined;
  }
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
```

- [ ] **Step 6: Update esbuild config to copy native modules to `dist/`**

Replace `esbuild.config.mjs`:
```js
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', '@dittolive/ditto'],
  sourcemap: true,
  logLevel: 'info'
});

if (watch) {
  await extensionCtx.watch();
  console.log('[esbuild] watching…');
} else {
  await extensionCtx.rebuild();
  await extensionCtx.dispose();
  console.log('[esbuild] build finished.');
}
```

> The Ditto SDK is `external`, so VS Code's extension loader resolves `@dittolive/ditto` from `node_modules/` at runtime. Native `.node` files inside the SDK package load via the SDK's own resolver, no copying needed.

- [ ] **Step 7: Rebuild**

Run:
```bash
npm run build
```

Expected: rebuild succeeds; `dist/extension.js` is regenerated.

- [ ] **Step 8: Create `docs/MANUAL_TESTING.md` with setup and spike recipe**

Create file `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 9: Manual verification — run the spike**

1. Press `F5` in the main VS Code window.
2. In the Extension Development Host, open `View → Output → Ditto Edge Studio`.

**Expected output (in order):**
```
Ditto Edge Studio extension activated.
SPIKE: opening Ditto…
SPIKE: login OK
SPIKE: sync started
SPIKE: inserted doc into vsce_smoke
SPIKE: observer saw 1 doc(s): [{"_id":"…","hello":"world","t":…}]
```

**🛑 HARD GATE:** If you do **not** see the full sequence above, **stop the plan**. The remaining tasks assume the SDK loads correctly. Diagnose with the troubleshooting block in the verification recipe.

- [ ] **Step 10: Commit**

Run:
```bash
git add .
git commit -m "feat(spike): verify Ditto NodeJS SDK loads inside VS Code extension host"
```

---

## Task 3: Models, IPC types, and tests scaffold

**Goal:** Lock in the type contracts. Wire up the unit-test runner. Replace the spike with a clean `extension.ts` skeleton.

**Files:**
- Create: `src/models/DittoConfig.ts`
- Create: `src/ipc/messages.ts`
- Create: `src/test/example.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/models/DittoConfig.ts`**

Create file `src/models/DittoConfig.ts`:
```ts
export type AuthMode = 'server' | 'smallPeersOnly';
export type LogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';

export interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: AuthMode;
  authUrl: string;
  websocketUrl: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: LogLevel;
  isStrictModeEnabled: boolean;
}

export interface SecretSet {
  token: string;
  secretKey?: string;
  httpApiKey?: string;
}

export function newConfig(): StoredDittoConfig {
  return {
    id: '',
    name: '',
    databaseId: '',
    mode: 'server',
    authUrl: '',
    websocketUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false
  };
}

export interface StoredSubscription {
  id: string;
  name: string;
  query: string;
}

export interface PeerSnapshot {
  local: LocalPeer | null;
  remote: RemotePeer[];
}

export interface LocalPeer {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

export interface RemotePeer {
  id: string;
  deviceName?: string;
  sdkVersion?: string;
  os?: 'iOS' | 'android' | 'macOS' | 'linux' | 'windows' | 'unknown';
  connections: Array<{
    type: 'webSocket' | 'lan' | 'bluetooth' | 'p2pWiFi' | 'unknown';
    address?: string;
  }>;
  lastUpdate: number;
}
```

- [ ] **Step 2: Create `src/ipc/messages.ts`**

Create file `src/ipc/messages.ts`:
```ts
import type { StoredDittoConfig, SecretSet, StoredSubscription, PeerSnapshot } from '../models/DittoConfig.js';

// ─── Database editor panel ─────────────────────────────────────
export type EditorIn =
  | { type: 'editor.save'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.cancel' };

export type EditorOut =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.validationError'; message: string };

// ─── Subscription editor panel ─────────────────────────────────
export type SubIn =
  | { type: 'sub.save'; id?: string; name: string; query: string }
  | { type: 'sub.cancel' };

export type SubOut =
  | { type: 'sub.init'; id?: string; name: string; query: string };

// ─── Peer listing panel ────────────────────────────────────────
export type PeerIn =
  | { type: 'peer.toggleSync' };

export type PeerOut =
  | { type: 'peer.state'; snapshot: PeerSnapshot; sync: 'active' | 'idle' };
```

- [ ] **Step 3: Create test scaffold `src/test/example.test.ts`**

Create file `src/test/example.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConfig } from '../models/DittoConfig.js';

test('newConfig returns a default config', () => {
  const c = newConfig();
  assert.equal(c.mode, 'server');
  assert.equal(c.allowUntrustedCerts, false);
  assert.equal(c.logLevel, 'info');
});
```

- [ ] **Step 4: Run the tests**

Run:
```bash
npm test
```

Expected: 1 test passes.

- [ ] **Step 5: Replace `src/extension.ts` with a clean skeleton (drop spike code)**

Replace `src/extension.ts`:
```ts
import * as vscode from 'vscode';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);
  output.appendLine('Ditto Edge Studio extension activated.');
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
```

- [ ] **Step 6: Build & manual smoke test**

Run:
```bash
npm run build
```

Press `F5`. The Extension Development Host should still show the activation log. The spike side-effects are gone.

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "feat: add models, IPC types, and test runner; remove spike from activate"
```

---

## Task 4: ConfigStore (TDD)

**Goal:** Persist `StoredDittoConfig[]` in `globalState`. Pure logic, fully unit-tested with a fake `Memento`.

**Files:**
- Create: `src/test/ConfigStore.test.ts`
- Create: `src/storage/ConfigStore.ts`

- [ ] **Step 1: Write the failing tests**

Create file `src/test/ConfigStore.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../storage/ConfigStore.js';
import { newConfig, type StoredDittoConfig } from '../models/DittoConfig.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeConfig(overrides: Partial<StoredDittoConfig> = {}): StoredDittoConfig {
  return { ...newConfig(), id: 'id-' + Math.random().toString(36).slice(2), ...overrides };
}

test('list() returns [] when nothing stored', () => {
  const store = new ConfigStore(new FakeMemento() as any);
  assert.deepEqual(store.list(), []);
});

test('save() then list() round-trips a config', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig({ name: 'A', databaseId: 'db-A' });
  await store.save(cfg);
  assert.deepEqual(store.list(), [cfg]);
});

test('save() updates an existing config by id', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig({ name: 'A' });
  await store.save(cfg);
  await store.save({ ...cfg, name: 'A renamed' });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].name, 'A renamed');
});

test('get(id) returns the matching config or undefined', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig();
  await store.save(cfg);
  assert.deepEqual(store.get(cfg.id), cfg);
  assert.equal(store.get('nope'), undefined);
});

test('delete(id) removes the config', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const cfg = makeConfig();
  await store.save(cfg);
  await store.delete(cfg.id);
  assert.deepEqual(store.list(), []);
});

test('listeners fire on save and delete', async () => {
  const store = new ConfigStore(new FakeMemento() as any);
  const events: string[] = [];
  store.onDidChange(() => events.push('change'));
  await store.save(makeConfig());
  await store.delete(store.list()[0].id);
  assert.deepEqual(events, ['change', 'change']);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run:
```bash
npm test
```

Expected: tests fail with "Cannot find module '../storage/ConfigStore.js'" or similar.

- [ ] **Step 3: Implement `ConfigStore`**

Create file `src/storage/ConfigStore.ts`:
```ts
import type { StoredDittoConfig } from '../models/DittoConfig.js';

const STORAGE_KEY = 'dittoConfigs.v1';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = () => void;

export class ConfigStore {
  private listeners = new Set<Listener>();

  constructor(private readonly memento: MementoLike) {}

  list(): StoredDittoConfig[] {
    return this.memento.get<StoredDittoConfig[]>(STORAGE_KEY) ?? [];
  }

  get(id: string): StoredDittoConfig | undefined {
    return this.list().find(c => c.id === id);
  }

  async save(config: StoredDittoConfig): Promise<void> {
    const list = this.list();
    const idx = list.findIndex(c => c.id === config.id);
    if (idx >= 0) { list[idx] = config; } else { list.push(config); }
    await this.memento.update(STORAGE_KEY, list);
    this.fire();
  }

  async delete(id: string): Promise<void> {
    const list = this.list().filter(c => c.id !== id);
    await this.memento.update(STORAGE_KEY, list);
    this.fire();
  }

  onDidChange(listener: Listener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private fire() {
    for (const l of this.listeners) { l(); }
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run:
```bash
npm test
```

Expected: all 6 ConfigStore tests pass plus the existing example test.

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(storage): add ConfigStore with TDD coverage"
```

---

## Task 5: SecretStore (TDD)

**Goal:** Wrap `vscode.SecretStorage` with a typed API per-config. Same TDD pattern as ConfigStore.

**Files:**
- Create: `src/test/SecretStore.test.ts`
- Create: `src/storage/SecretStore.ts`

- [ ] **Step 1: Write the failing tests**

Create file `src/test/SecretStore.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../storage/SecretStore.js';
import type { SecretSet } from '../models/DittoConfig.js';

class FakeSecretStorage {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

test('write() then read() returns the saved secrets', async () => {
  const store = new SecretStore(new FakeSecretStorage() as any);
  const secrets: SecretSet = { token: 't', secretKey: 'sk', httpApiKey: 'hk' };
  await store.write('cfg-1', secrets);
  assert.deepEqual(await store.read('cfg-1'), secrets);
});

test('read() returns empty object when nothing stored', async () => {
  const store = new SecretStore(new FakeSecretStorage() as any);
  assert.deepEqual(await store.read('cfg-1'), { token: '' });
});

test('write() with optional fields undefined deletes them', async () => {
  const store = new SecretStore(new FakeSecretStorage() as any);
  await store.write('cfg-1', { token: 't', secretKey: 'sk', httpApiKey: 'hk' });
  await store.write('cfg-1', { token: 't2' });
  const s = await store.read('cfg-1');
  assert.equal(s.token, 't2');
  assert.equal(s.secretKey, undefined);
  assert.equal(s.httpApiKey, undefined);
});

test('deleteAll(id) clears every secret for that id', async () => {
  const store = new SecretStore(new FakeSecretStorage() as any);
  await store.write('cfg-1', { token: 't', secretKey: 'sk', httpApiKey: 'hk' });
  await store.deleteAll('cfg-1');
  const s = await store.read('cfg-1');
  assert.equal(s.token, '');
  assert.equal(s.secretKey, undefined);
  assert.equal(s.httpApiKey, undefined);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run:
```bash
npm test
```

Expected: SecretStore tests fail with module-not-found.

- [ ] **Step 3: Implement `SecretStore`**

Create file `src/storage/SecretStore.ts`:
```ts
import type { SecretSet } from '../models/DittoConfig.js';

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const FIELDS = ['token', 'secretKey', 'httpApiKey'] as const;
type Field = typeof FIELDS[number];

function key(id: string, field: Field): string {
  return `ditto.${id}.${field}`;
}

export class SecretStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  async read(id: string): Promise<SecretSet> {
    const out: SecretSet = { token: '' };
    out.token = (await this.secrets.get(key(id, 'token'))) ?? '';
    const sk = await this.secrets.get(key(id, 'secretKey'));
    const hk = await this.secrets.get(key(id, 'httpApiKey'));
    if (sk !== undefined) { out.secretKey = sk; }
    if (hk !== undefined) { out.httpApiKey = hk; }
    return out;
  }

  async write(id: string, set: SecretSet): Promise<void> {
    await this.secrets.store(key(id, 'token'), set.token);
    if (set.secretKey !== undefined && set.secretKey !== '') {
      await this.secrets.store(key(id, 'secretKey'), set.secretKey);
    } else {
      await this.secrets.delete(key(id, 'secretKey'));
    }
    if (set.httpApiKey !== undefined && set.httpApiKey !== '') {
      await this.secrets.store(key(id, 'httpApiKey'), set.httpApiKey);
    } else {
      await this.secrets.delete(key(id, 'httpApiKey'));
    }
  }

  async deleteAll(id: string): Promise<void> {
    for (const f of FIELDS) {
      await this.secrets.delete(key(id, f));
    }
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run:
```bash
npm test
```

Expected: all SecretStore tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(storage): add SecretStore with TDD coverage"
```

---

## Task 6: DatabaseTreeProvider — idle-only tree (TDD)

**Goal:** Render the list of registered databases as tree items with status dots. No active-DB children yet — that comes after `DittoManager`.

**Files:**
- Create: `src/tree/DatabaseTreeItem.ts`
- Create: `src/test/DatabaseTreeProvider.test.ts`
- Create: `src/tree/DatabaseTreeProvider.ts`
- Modify: `src/extension.ts`
- Modify: `package.json` (commands & menus)

- [ ] **Step 1: Create the tree-item discriminated union**

Create file `src/tree/DatabaseTreeItem.ts`:
```ts
import type { StoredDittoConfig, StoredSubscription } from '../models/DittoConfig.js';

export type DatabaseTreeNode =
  | { kind: 'database'; config: StoredDittoConfig; status: 'idle' | 'activating' | 'active' | 'error' }
  | { kind: 'subscriptionsParent'; databaseId: string }
  | { kind: 'subscription'; databaseId: string; sub: StoredSubscription }
  | { kind: 'peerListing'; databaseId: string };
```

- [ ] **Step 2: Write failing tests for the tree provider**

Create file `src/test/DatabaseTreeProvider.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../storage/ConfigStore.js';
import { DatabaseTreeProvider } from '../tree/DatabaseTreeProvider.js';
import { newConfig } from '../models/DittoConfig.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeStore(): ConfigStore { return new ConfigStore(new FakeMemento() as any); }

test('getRootChildren returns [] when no configs', async () => {
  const cfg = makeStore();
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  assert.deepEqual(await provider.getRootChildren(), []);
});

test('getRootChildren returns one database node per stored config (idle by default)', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  const roots = await provider.getRootChildren();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].kind, 'database');
  assert.equal(roots[0].kind === 'database' && roots[0].status, 'idle');
  assert.equal(roots[1].kind === 'database' && roots[1].config.name, 'B');
});

test('idle database has no children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle');
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children, []);
});

test('active database has Subscriptions parent and Peer Listing as children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active');
  const [root] = await provider.getRootChildren();
  const children = await provider.getNodeChildren(root);
  assert.equal(children.length, 2);
  assert.equal(children[0].kind, 'subscriptionsParent');
  assert.equal(children[1].kind, 'peerListing');
});
```

- [ ] **Step 3: Run tests — verify failure**

Run:
```bash
npm test
```

Expected: test file errors with module-not-found for `../tree/DatabaseTreeProvider.js`.

- [ ] **Step 4: Implement `DatabaseTreeProvider`**

Create file `src/tree/DatabaseTreeProvider.ts`:
```ts
import * as vscode from 'vscode';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { DatabaseTreeNode } from './DatabaseTreeItem.js';

export type DatabaseStatus = 'idle' | 'activating' | 'active' | 'error';
export type StatusResolver = (databaseId: string) => DatabaseStatus;

export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly _changeEmitter = new vscode.EventEmitter<DatabaseTreeNode | undefined>();
  readonly onDidChangeTreeData = this._changeEmitter.event;

  constructor(
    private readonly configs: ConfigStore,
    private readonly statusFor: StatusResolver
  ) {
    configs.onDidChange(() => this._changeEmitter.fire(undefined));
  }

  refresh(node?: DatabaseTreeNode) { this._changeEmitter.fire(node); }

  async getRootChildren(): Promise<DatabaseTreeNode[]> {
    return this.configs.list().map(config => ({
      kind: 'database' as const,
      config,
      status: this.statusFor(config.id)
    }));
  }

  async getNodeChildren(node: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    if (node.kind === 'database') {
      if (node.status !== 'active') { return []; }
      return [
        { kind: 'subscriptionsParent', databaseId: node.config.id },
        { kind: 'peerListing', databaseId: node.config.id }
      ];
    }
    if (node.kind === 'subscriptionsParent') { return []; /* filled in Task 13 */ }
    return [];
  }

  // ─── vscode.TreeDataProvider ─────────────────────────────────
  async getChildren(element?: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    return element ? this.getNodeChildren(element) : this.getRootChildren();
  }

  getTreeItem(node: DatabaseTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'database': {
        const dot = node.status === 'active' ? '●'
                  : node.status === 'activating' ? '◐'
                  : node.status === 'error' ? '⊗'
                  : '○';
        const item = new vscode.TreeItem(
          `${dot} ${node.config.name || '(unnamed)'}`,
          node.status === 'active'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );
        item.description = `${node.config.mode === 'server' ? 'Server' : 'SmallPeers'} · ${node.config.databaseId.slice(0, 6)}…`;
        item.contextValue = `database.${node.status}`;
        item.tooltip = node.config.name;
        item.id = `db.${node.config.id}`;
        item.command = node.status === 'idle' || node.status === 'error'
          ? { command: 'dittoVsce.connect', title: 'Connect', arguments: [node] }
          : undefined;
        return item;
      }
      case 'subscriptionsParent': {
        const item = new vscode.TreeItem('Subscriptions', vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'subscriptionsParent';
        item.id = `subs.${node.databaseId}`;
        return item;
      }
      case 'subscription': {
        const item = new vscode.TreeItem(node.sub.name);
        item.description = node.sub.query;
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.sub.query, 'sql');
        item.contextValue = 'subscription';
        item.id = `sub.${node.databaseId}.${node.sub.id}`;
        return item;
      }
      case 'peerListing': {
        const item = new vscode.TreeItem('Peer Listing');
        item.iconPath = new vscode.ThemeIcon('broadcast');
        item.contextValue = 'peerListing';
        item.id = `peers.${node.databaseId}`;
        item.command = { command: 'dittoVsce.openPeerListing', title: 'Open Peer Listing', arguments: [node.databaseId] };
        return item;
      }
    }
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run:
```bash
npm test
```

Expected: all 4 tree-provider tests pass plus existing tests.

- [ ] **Step 6: Wire the tree provider into `extension.ts`**

Replace `src/extension.ts`:
```ts
import * as vscode from 'vscode';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);

  const treeProvider = new DatabaseTreeProvider(configStore, () => 'idle');
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  // placeholder commands (real impls in later tasks)
  context.subscriptions.push(
    vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
      vscode.window.showInformationMessage('Register Database — not implemented yet (Task 7).');
    }),
    vscode.commands.registerCommand('dittoVsce.editDatabase', () => {
      vscode.window.showInformationMessage('Edit Database — not implemented yet (Task 7).');
    }),
    vscode.commands.registerCommand('dittoVsce.deleteDatabase', async (node) => {
      if (node?.kind !== 'database') { return; }
      const ok = await vscode.window.showWarningMessage(
        `Delete database "${node.config.name}"?`, { modal: true }, 'Delete'
      );
      if (ok === 'Delete') {
        await configStore.delete(node.config.id);
        await secretStore.deleteAll(node.config.id);
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', () => {
      vscode.window.showInformationMessage('Connect — not implemented yet (Task 9).');
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', () => {
      vscode.window.showInformationMessage('Disconnect — not implemented yet (Task 9).');
    }),
    vscode.commands.registerCommand('dittoVsce.openPeerListing', () => {
      vscode.window.showInformationMessage('Peer Listing — not implemented yet (Task 11).');
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', () => {
      vscode.window.showInformationMessage('New Subscription — not implemented yet (Task 14).');
    })
  );

  output.appendLine('Ditto Edge Studio extension activated.');
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
```

- [ ] **Step 7: Update `package.json` with the contributed commands & menus**

Replace the `"contributes"` block in `package.json` with:
```json
"contributes": {
  "viewsContainers": {
    "activitybar": [
      { "id": "dittoVsce", "title": "Ditto", "icon": "$(database)" }
    ]
  },
  "views": {
    "dittoVsce": [
      { "id": "dittoDatabases", "name": "Databases" }
    ]
  },
  "commands": [
    { "command": "dittoVsce.registerDatabase", "title": "Register Database…", "icon": "$(add)" },
    { "command": "dittoVsce.editDatabase", "title": "Edit Configuration", "icon": "$(edit)" },
    { "command": "dittoVsce.deleteDatabase", "title": "Delete", "icon": "$(trash)" },
    { "command": "dittoVsce.connect", "title": "Connect" },
    { "command": "dittoVsce.disconnect", "title": "Disconnect" },
    { "command": "dittoVsce.openPeerListing", "title": "Open Peer Listing" },
    { "command": "dittoVsce.newSubscription", "title": "New Subscription…", "icon": "$(add)" }
  ],
  "menus": {
    "view/title": [
      { "command": "dittoVsce.registerDatabase", "when": "view == dittoDatabases", "group": "navigation" }
    ],
    "view/item/context": [
      { "command": "dittoVsce.connect", "when": "view == dittoDatabases && viewItem == database.idle", "group": "1_connection@1" },
      { "command": "dittoVsce.connect", "when": "view == dittoDatabases && viewItem == database.error", "group": "1_connection@1" },
      { "command": "dittoVsce.disconnect", "when": "view == dittoDatabases && viewItem == database.active", "group": "1_connection@1" },
      { "command": "dittoVsce.editDatabase", "when": "view == dittoDatabases && viewItem =~ /^database\\./", "group": "2_edit@1" },
      { "command": "dittoVsce.deleteDatabase", "when": "view == dittoDatabases && viewItem =~ /^database\\./", "group": "2_edit@2" },
      { "command": "dittoVsce.newSubscription", "when": "view == dittoDatabases && viewItem == subscriptionsParent", "group": "inline" }
    ]
  }
}
```

- [ ] **Step 8: Build & manually test the tree**

Run:
```bash
npm run build
```

Press `F5`. In the Extension Development Host:
1. Open the activity bar → click the Ditto icon. The "Databases" view shows but is empty.
2. Click the `＋` icon in the view title bar — message "Register Database — not implemented yet (Task 7)." appears.

To temporarily verify a non-empty tree, in the Debug Console (parent VS Code window during the F5 session) run:
```js
require('/Users/labeaaa/Developer/ditto-vsc-es/dist/extension.js')
```
…and so on. **Easier:** seed a fake config via the next step's manual recipe.

(We'll get a real "register" flow in Task 7.)

- [ ] **Step 9: Add manual test recipe to `docs/MANUAL_TESTING.md`**

Append to `docs/MANUAL_TESTING.md`:
```markdown
### T2 · Tree view shows the empty state

**Steps:**
1. Press `F5`.
2. Click the Ditto icon in the activity bar of the Extension Development Host.

**Expected:** The Databases view appears with no entries. Clicking the `＋` button shows a transient info message about "Register Database — not implemented yet".
```

- [ ] **Step 10: Commit**

Run:
```bash
git add .
git commit -m "feat(tree): add DatabaseTreeProvider and view contributions"
```

---

## Task 7: Database editor panel — extension-host side

**Goal:** Wire up the webview panel host and the Register Database / Edit command. The Lit UI itself comes in Task 8.

**Files:**
- Create: `src/panels/DatabaseEditorPanel.ts`
- Create: `src/panels/webview-utils.ts`
- Modify: `src/extension.ts`
- Modify: `esbuild.config.mjs` (add a webview build for the editor panel)
- Create: `webview-ui/editor/main.ts` (placeholder — real UI in Task 8)

- [ ] **Step 1: Create `src/panels/webview-utils.ts`**

Create file `src/panels/webview-utils.ts`:
```ts
import * as vscode from 'vscode';

export function nonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
}

export interface PanelHtmlOptions {
  title: string;
  scriptUri: vscode.Uri;
  cspSource: string;
}

export function panelHtml({ title, scriptUri, cspSource }: PanelHtmlOptions): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
```

- [ ] **Step 2: Create `src/panels/DatabaseEditorPanel.ts`**

Create file `src/panels/DatabaseEditorPanel.ts`:
```ts
import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import { newConfig, type StoredDittoConfig, type SecretSet } from '../models/DittoConfig.js';
import type { EditorIn, EditorOut } from '../ipc/messages.js';

export class DatabaseEditorPanel {
  private static current: DatabaseEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    secrets: SecretStore,
    existing?: StoredDittoConfig
  ) {
    if (DatabaseEditorPanel.current) {
      DatabaseEditorPanel.current.panel.reveal();
      DatabaseEditorPanel.current.init(existing);
      return;
    }
    DatabaseEditorPanel.current = new DatabaseEditorPanel(context, configs, secrets, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configs: ConfigStore,
    private readonly secrets: SecretStore,
    existing?: StoredDittoConfig
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoDatabaseEditor',
      existing ? `Edit Database — ${existing.name}` : 'Register Database',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );

    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'editor.js')
    );
    this.panel.webview.html = panelHtml({
      title: existing ? 'Edit Database' : 'Register Database',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });

    this.panel.webview.onDidReceiveMessage((msg: EditorIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Send init payload after the webview script has had a chance to register its listener.
    setTimeout(() => this.init(existing), 50);
  }

  private async init(existing?: StoredDittoConfig) {
    const config = existing ?? { ...newConfig(), id: cryptoRandomId() };
    const secrets: SecretSet = existing
      ? await this.secrets.read(existing.id)
      : { token: '' };
    this.post({ type: 'editor.init', config, secrets });
  }

  private post(msg: EditorOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: EditorIn) {
    if (msg.type === 'editor.cancel') {
      this.panel.dispose();
      return;
    }
    if (msg.type === 'editor.save') {
      const err = validate(msg.config, msg.secrets);
      if (err) {
        this.post({ type: 'editor.validationError', message: err });
        return;
      }
      await this.configs.save(msg.config);
      await this.secrets.write(msg.config.id, msg.secrets);
      vscode.window.showInformationMessage(`Saved database "${msg.config.name}".`);
      this.panel.dispose();
    }
  }

  private dispose() {
    DatabaseEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function validate(config: StoredDittoConfig, secrets: SecretSet): string | null {
  if (!config.name.trim()) { return 'Name is required.'; }
  if (!config.databaseId.trim()) { return 'Database ID is required.'; }
  if (!secrets.token.trim()) { return 'Token is required.'; }
  if (config.mode === 'server' && !config.authUrl.trim()) { return 'Auth URL is required for Server mode.'; }
  if (config.mode === 'server' && !config.websocketUrl.trim()) { return 'Websocket URL is required for Server mode.'; }
  return null;
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 3: Update `esbuild.config.mjs` to also build webview entries**

Replace `esbuild.config.mjs`:
```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', '@dittolive/ditto'],
  sourcemap: true,
  logLevel: 'info'
});

const webviewCtx = await esbuild.context({
  entryPoints: {
    editor: 'webview-ui/editor/main.ts',
    subscription: 'webview-ui/subscription/main.ts',
    peers: 'webview-ui/peers/main.ts'
  },
  bundle: true,
  outdir: 'dist/webview-ui',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info'
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log('[esbuild] build finished.');
}
```

- [ ] **Step 4: Create stub webview entry points so the build doesn't fail**

Create file `webview-ui/editor/main.ts`:
```ts
// Stub — real UI implemented in Task 8.
const root = document.getElementById('root');
if (root) { root.textContent = 'Database editor — UI under construction.'; }
```

Create file `webview-ui/subscription/main.ts`:
```ts
// Stub — real UI implemented in Task 15.
const root = document.getElementById('root');
if (root) { root.textContent = 'Subscription editor — UI under construction.'; }
```

Create file `webview-ui/peers/main.ts`:
```ts
// Stub — real UI implemented in Task 12.
const root = document.getElementById('root');
if (root) { root.textContent = 'Peer listing — UI under construction.'; }
```

- [ ] **Step 5: Wire the panel into `extension.ts`**

Replace the `dittoVsce.registerDatabase` and `dittoVsce.editDatabase` registrations in `src/extension.ts` with:
```ts
vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
  DatabaseEditorPanel.show(context, configStore, secretStore);
}),
vscode.commands.registerCommand('dittoVsce.editDatabase', (node) => {
  if (node?.kind !== 'database') { return; }
  DatabaseEditorPanel.show(context, configStore, secretStore, node.config);
}),
```

…and add the import at the top of `src/extension.ts`:
```ts
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
```

- [ ] **Step 6: Build and run**

Run:
```bash
npm run build
```

Press `F5`. In the Extension Development Host:
1. Click the `＋` button in the Databases view title bar.
2. A new editor tab labeled "Register Database" opens, showing "Database editor — UI under construction."

- [ ] **Step 7: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
### T3 · Open the Database Editor panel (UI placeholder)

**Steps:**
1. Press `F5`.
2. Open the Ditto sidebar; click the `＋` button in the Databases title bar.

**Expected:** A new editor tab opens with title "Register Database" containing the text "Database editor — UI under construction." (UI replaced in T4.)
```

- [ ] **Step 8: Commit**

Run:
```bash
git add .
git commit -m "feat(panels): add DatabaseEditorPanel host and webview build pipeline"
```

---

## Task 8: Database editor panel — Lit UI

**Goal:** Implement the registration / edit form in Lit, matching the SwiftUI DatabaseEditorView 1:1 (minus transport toggles).

**Files:**
- Modify: `package.json` (add Lit)
- Modify: `webview-ui/editor/main.ts`
- Create: `webview-ui/editor/editor-element.ts`
- Create: `webview-ui/shared/messaging.ts`

- [ ] **Step 1: Add Lit**

Run:
```bash
npm install lit@^3.1.4
```

- [ ] **Step 2: Create the messaging helper**

Create file `webview-ui/shared/messaging.ts`:
```ts
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const api = acquireVsCodeApi();

export function postToHost<T>(msg: T): void {
  api.postMessage(msg);
}

export function onHostMessage<T>(handler: (msg: T) => void): void {
  window.addEventListener('message', e => handler(e.data as T));
}
```

- [ ] **Step 3: Implement the Lit element**

Create file `webview-ui/editor/editor-element.ts`:
```ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: 'server' | 'smallPeersOnly';
  authUrl: string;
  websocketUrl: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: 'error' | 'warning' | 'info' | 'debug' | 'verbose';
  isStrictModeEnabled: boolean;
}

interface SecretSet { token: string; secretKey?: string; httpApiKey?: string; }

type In =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.validationError'; message: string };

@customElement('ditto-database-editor')
export class DatabaseEditor extends LitElement {
  @state() private config: StoredDittoConfig | null = null;
  @state() private secrets: SecretSet = { token: '' };
  @state() private validationError: string | null = null;

  static styles = css`
    :host { display: block; padding: 24px; max-width: 720px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    h2 { margin-top: 32px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input[type=text], input[type=password], select, textarea {
      width: 100%; padding: 6px 8px; box-sizing: border-box;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font: inherit; font-family: var(--vscode-editor-font-family);
    }
    .mode-picker { display: flex; gap: 4px; margin: 16px 0; }
    .mode-picker button { flex: 1; padding: 6px 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; }
    .mode-picker button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .help { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .warn { font-size: 11px; color: var(--vscode-editorWarning-foreground); margin-top: 4px; }
    .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer button { padding: 6px 16px; cursor: pointer; border: none; }
    .footer .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .error-banner { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px 12px; margin-bottom: 16px; border-radius: 2px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'editor.init') { this.config = msg.config; this.secrets = msg.secrets; }
      if (msg.type === 'editor.validationError') { this.validationError = msg.message; }
    });
  }

  private update_(field: keyof StoredDittoConfig, value: any) {
    if (!this.config) { return; }
    this.config = { ...this.config, [field]: value };
  }

  private updateSecret(field: keyof SecretSet, value: string) {
    this.secrets = { ...this.secrets, [field]: value };
  }

  private isValid(): boolean {
    const c = this.config;
    if (!c) { return false; }
    if (!c.name.trim() || !c.databaseId.trim() || !this.secrets.token.trim()) { return false; }
    return true;
  }

  private save() {
    if (!this.config) { return; }
    postToHost({ type: 'editor.save', config: this.config, secrets: this.secrets });
  }

  private cancel() { postToHost({ type: 'editor.cancel' }); }

  render() {
    if (!this.config) { return html`<p>Loading…</p>`; }
    const c = this.config;
    return html`
      ${this.validationError ? html`<div class="error-banner">${this.validationError}</div>` : nothing}

      <div class="mode-picker" role="tablist">
        <button class=${c.mode === 'server' ? 'active' : ''} @click=${() => this.update_('mode', 'server')}>Server</button>
        <button class=${c.mode === 'smallPeersOnly' ? 'active' : ''} @click=${() => this.update_('mode', 'smallPeersOnly')}>Small Peers Only</button>
      </div>

      <h2>Basic Information</h2>
      <label>Name</label>
      <input type="text" .value=${c.name} @input=${(e: Event) => this.update_('name', (e.target as HTMLInputElement).value)} />

      <h2>Authorization Information</h2>
      <label>Database ID</label>
      <input type="text" .value=${c.databaseId} @input=${(e: Event) => this.update_('databaseId', (e.target as HTMLInputElement).value.trim())} style="font-family: var(--vscode-editor-font-family)" />

      <label>${c.mode === 'server' ? 'Token' : 'Offline Token'}</label>
      <input type="password" .value=${this.secrets.token} @input=${(e: Event) => this.updateSecret('token', (e.target as HTMLInputElement).value.trim())} />
      ${c.mode === 'smallPeersOnly' ? html`<div class="help">Required for sync activation in Small Peers Only mode. Obtain from <a href="https://portal.ditto.live">portal.ditto.live</a>.</div>` : nothing}

      ${c.mode === 'server' ? html`
        <h2>Ditto Server (BigPeer) Information</h2>
        <label>Auth URL</label>
        <input type="text" .value=${c.authUrl} @input=${(e: Event) => this.update_('authUrl', (e.target as HTMLInputElement).value)} />
        <label>Websocket URL</label>
        <input type="text" .value=${c.websocketUrl} @input=${(e: Event) => this.update_('websocketUrl', (e.target as HTMLInputElement).value)} />

        <h2>Ditto Server — HTTP API (Optional)</h2>
        <label>HTTP API URL</label>
        <input type="text" .value=${c.httpApiUrl} @input=${(e: Event) => this.update_('httpApiUrl', (e.target as HTMLInputElement).value)} />
        <label>HTTP API Key</label>
        <input type="password" .value=${this.secrets.httpApiKey ?? ''} @input=${(e: Event) => this.updateSecret('httpApiKey', (e.target as HTMLInputElement).value)} />
        <div class="checkbox-row">
          <input type="checkbox" id="cb-untrusted" .checked=${c.allowUntrustedCerts} @change=${(e: Event) => this.update_('allowUntrustedCerts', (e.target as HTMLInputElement).checked)} />
          <label for="cb-untrusted" style="margin: 0">Allow untrusted certificates</label>
        </div>
        <div class="warn">By allowing untrusted certificates, you bypass SSL validation. Use only in development.</div>
      ` : nothing}

      ${c.mode === 'smallPeersOnly' ? html`
        <h2>Optional Shared Secret Key</h2>
        <input type="password" .value=${this.secrets.secretKey ?? ''} @input=${(e: Event) => this.updateSecret('secretKey', (e.target as HTMLInputElement).value)} />
        <div class="help">Optional secret key for shared key identity encryption. Leave empty if not using Shared Key.</div>
      ` : nothing}

      <h2>Developer Options</h2>
      <label>SDK Log Level</label>
      <select .value=${c.logLevel} @change=${(e: Event) => this.update_('logLevel', (e.target as HTMLSelectElement).value)}>
        <option value="error">Error</option>
        <option value="warning">Warning</option>
        <option value="info">Info (Default)</option>
        <option value="debug">Debug</option>
        <option value="verbose">Verbose</option>
      </select>
      <div class="help">Controls DittoLogger.minimumLogLevel when this database is activated.</div>

      <div class="checkbox-row">
        <input type="checkbox" id="cb-strict" .checked=${c.isStrictModeEnabled} @change=${(e: Event) => this.update_('isStrictModeEnabled', (e.target as HTMLInputElement).checked)} />
        <label for="cb-strict" style="margin: 0">Enable DQL Strict Mode</label>
      </div>
      <div class="warn">⚠️ For most users of Ditto SDK 5.0+, strict mode should remain disabled. Enable only if you require SDK 4.x compatibility.</div>

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.save}>Save</button>
      </div>
    `;
  }
}
```

- [ ] **Step 4: Replace the editor entry point**

Replace `webview-ui/editor/main.ts`:
```ts
import './editor-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-database-editor');
  root.appendChild(el);
}
```

- [ ] **Step 5: Build and run**

Run:
```bash
npm run build
```

Press `F5`. In the Extension Development Host:
1. Click `＋` in Databases.
2. The editor opens with the segmented Server / Small Peers Only picker, Name + Database ID + Token fields, and the Server-mode subsections.
3. Switch to Small Peers Only — Server-mode sections disappear, Optional Shared Secret Key appears.
4. Fill in dummy values: Name `test-db`, Database ID `abc123`, Token `xyz`. The Save button enables.
5. Click Save. The panel closes; "Saved database 'test-db'." appears as a notification. The Databases view now shows `○ test-db (Server, idle)`.

- [ ] **Step 6: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "feat(editor): implement Lit-based DatabaseEditor with full SwiftUI parity"
```

---

## Task 9: DittoManager — connect / disconnect lifecycle

**Goal:** Singleton that opens/closes one Ditto instance at a time, drives status, and exposes presence + subscription APIs for later tasks.

**Files:**
- Create: `src/ditto/DittoManager.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Implement `DittoManager`**

Create file `src/ditto/DittoManager.ts`:
```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Ditto, DittoConfig, Authenticator } from '@dittolive/ditto';
import type { StoredDittoConfig, SecretSet, PeerSnapshot, RemotePeer } from '../models/DittoConfig.js';
import type { DatabaseStatus } from '../tree/DatabaseTreeProvider.js';

type StatusListener = (status: DatabaseStatus, configId: string | null) => void;
type PresenceListener = (snapshot: PeerSnapshot) => void;

interface ActiveSession {
  configId: string;
  ditto: Ditto;
  presenceObserver?: { stop?: () => void };
  subscriptionHandles: Map<string, { cancel: () => void }>;
}

export class DittoManager {
  private session: ActiveSession | null = null;
  private status: DatabaseStatus = 'idle';
  private statusListeners = new Set<StatusListener>();
  private presenceListeners = new Set<PresenceListener>();
  private latestSnapshot: PeerSnapshot = { local: null, remote: [] };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  getStatus(configId: string): DatabaseStatus {
    if (!this.session) { return 'idle'; }
    if (this.session.configId === configId) { return this.status; }
    return 'idle';
  }

  getActiveConfigId(): string | null { return this.session?.configId ?? null; }
  getLatestSnapshot(): PeerSnapshot { return this.latestSnapshot; }

  onStatusChange(l: StatusListener): vscode.Disposable {
    this.statusListeners.add(l);
    return new vscode.Disposable(() => this.statusListeners.delete(l));
  }

  onPresence(l: PresenceListener): vscode.Disposable {
    this.presenceListeners.add(l);
    return new vscode.Disposable(() => this.presenceListeners.delete(l));
  }

  async connect(config: StoredDittoConfig, secrets: SecretSet): Promise<void> {
    if (this.session) { await this.disconnect(); }
    this.setStatus('activating', config.id);
    try {
      const persistenceDir = path.join(this.context.globalStorageUri.fsPath, 'dittoData', config.id);
      fs.mkdirSync(persistenceDir, { recursive: true });

      const dittoCfg = new DittoConfig(
        config.databaseId,
        config.mode === 'server'
          ? { mode: 'server', url: config.authUrl }
          : { mode: 'smallPeersOnly' as const },
        persistenceDir
      );
      const ditto = await Ditto.open(dittoCfg);

      ditto.updateTransportConfig((c: any) => {
        c.peerToPeer.bluetoothLE.isEnabled = false;
        c.peerToPeer.awdl.isEnabled = false;
        c.peerToPeer.lan.isEnabled = true;
        c.peerToPeer.lan.isMdnsEnabled = true;
        c.peerToPeer.lan.isMulticastEnabled = true;
      });

      if (config.mode === 'server' && ditto.auth.loginSupported) {
        await ditto.auth.setExpirationHandler(async (instance: any) => {
          if (instance.auth.loginSupported) {
            await instance.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
          }
        });
        const result = await ditto.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
        if ((result as any).error) { throw new Error(`Login failed: ${(result as any).error}`); }
      }

      ditto.sync.start();

      this.session = { configId: config.id, ditto, subscriptionHandles: new Map() };
      this.attachPresenceObserver(ditto);

      this.setStatus('active', config.id);
      this.output.appendLine(`Connected to "${config.name}".`);
    } catch (err) {
      this.output.appendLine(`Connect failed: ${err instanceof Error ? err.stack : String(err)}`);
      this.setStatus('error', config.id);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const s = this.session;
    if (!s) { return; }
    this.session = null;
    try {
      for (const h of s.subscriptionHandles.values()) { try { h.cancel(); } catch { /* ignore */ } }
      try { s.presenceObserver?.stop?.(); } catch { /* ignore */ }
      try { s.ditto.sync.stop(); } catch { /* ignore */ }
      try { await s.ditto.close(); } catch { /* ignore */ }
    } finally {
      this.latestSnapshot = { local: null, remote: [] };
      this.firePresence(this.latestSnapshot);
      this.setStatus('idle', null);
      this.output.appendLine('Disconnected.');
    }
  }

  async toggleSync(): Promise<'active' | 'idle'> {
    if (!this.session) { return 'idle'; }
    const ditto = this.session.ditto;
    const wasActive = (ditto.sync as any).isActive ?? true;
    if (wasActive) { ditto.sync.stop(); return 'idle'; }
    ditto.sync.start();
    return 'active';
  }

  registerSubscription(subId: string, query: string) {
    if (!this.session) { return; }
    if (this.session.subscriptionHandles.has(subId)) { return; }
    const handle = this.session.ditto.sync.registerSubscription(query);
    this.session.subscriptionHandles.set(subId, handle);
  }

  cancelSubscription(subId: string) {
    if (!this.session) { return; }
    const h = this.session.subscriptionHandles.get(subId);
    if (h) { try { h.cancel(); } catch { /* ignore */ } }
    this.session.subscriptionHandles.delete(subId);
  }

  // ─── private ─────────────────────────────────────────────────
  private attachPresenceObserver(ditto: Ditto) {
    const presence: any = (ditto as any).presence;
    if (!presence?.observe) {
      this.output.appendLine('Presence API not available on this SDK.');
      return;
    }
    let coalesceTimer: NodeJS.Timeout | null = null;
    let pending: any = null;
    const flush = () => {
      coalesceTimer = null;
      if (pending) { this.firePresence(toSnapshot(pending)); pending = null; }
    };
    const observer = presence.observe((graph: any) => {
      pending = graph;
      if (!coalesceTimer) { coalesceTimer = setTimeout(flush, 250); }
    });
    if (this.session) { this.session.presenceObserver = observer; }
  }

  private firePresence(snapshot: PeerSnapshot) {
    this.latestSnapshot = snapshot;
    for (const l of this.presenceListeners) { l(snapshot); }
  }

  private setStatus(s: DatabaseStatus, configId: string | null) {
    this.status = s;
    for (const l of this.statusListeners) { l(s, configId); }
  }
}

// ─── presence-graph adapter ────────────────────────────────────
// The exact shape from `ditto.presence.observe(...)` is verified during
// integration. This adapter narrows a best-guess shape into our
// PeerSnapshot type, falling back gracefully when fields are missing.
function toSnapshot(graph: any): PeerSnapshot {
  const local = graph?.localPeer ? {
    deviceName: graph.localPeer.deviceName ?? 'unknown',
    sdkLanguage: graph.localPeer.sdkLanguage ?? 'JS',
    sdkPlatform: graph.localPeer.platform ?? 'Node',
    sdkVersion: graph.localPeer.sdkVersion ?? 'unknown'
  } : null;

  const remoteRaw: any[] = Array.isArray(graph?.remotePeers) ? graph.remotePeers : [];
  const remote: RemotePeer[] = remoteRaw.map(r => ({
    id: String(r.peerKey ?? r.id ?? r._id ?? 'unknown'),
    deviceName: r.deviceName,
    sdkVersion: r.sdkVersion,
    os: r.os ?? r.platform ?? 'unknown',
    connections: Array.isArray(r.connections)
      ? r.connections.map((c: any) => ({ type: (c.type ?? c.kind ?? 'unknown'), address: c.address }))
      : [],
    lastUpdate: Date.now()
  }));

  return { local, remote };
}
```

- [ ] **Step 2: Wire `DittoManager` into `extension.ts`**

Replace `src/extension.ts`:
```ts
import * as vscode from 'vscode';
import { ConfigStore } from './storage/ConfigStore.js';
import { SecretStore } from './storage/SecretStore.js';
import { DatabaseTreeProvider } from './tree/DatabaseTreeProvider.js';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel.js';
import { DittoManager } from './ditto/DittoManager.js';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);

  const configStore = new ConfigStore(context.globalState);
  const secretStore = new SecretStore(context.secrets);
  const manager = new DittoManager(context, output);

  const treeProvider = new DatabaseTreeProvider(configStore, id => manager.getStatus(id));
  context.subscriptions.push(manager.onStatusChange(() => treeProvider.refresh()));
  const treeView = vscode.window.createTreeView('dittoDatabases', { treeDataProvider: treeProvider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand('dittoVsce.registerDatabase', () => {
      DatabaseEditorPanel.show(context, configStore, secretStore);
    }),
    vscode.commands.registerCommand('dittoVsce.editDatabase', (node) => {
      if (node?.kind !== 'database') { return; }
      DatabaseEditorPanel.show(context, configStore, secretStore, node.config);
    }),
    vscode.commands.registerCommand('dittoVsce.deleteDatabase', async (node) => {
      if (node?.kind !== 'database') { return; }
      if (manager.getActiveConfigId() === node.config.id) { await manager.disconnect(); }
      const ok = await vscode.window.showWarningMessage(
        `Delete database "${node.config.name}"?`, { modal: true }, 'Delete'
      );
      if (ok === 'Delete') {
        await configStore.delete(node.config.id);
        await secretStore.deleteAll(node.config.id);
        const dir = vscode.Uri.joinPath(context.globalStorageUri, 'dittoData', node.config.id);
        try { await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }); } catch { /* fine if missing */ }
      }
    }),
    vscode.commands.registerCommand('dittoVsce.connect', async (node) => {
      if (node?.kind !== 'database') { return; }
      const secrets = await secretStore.read(node.config.id);
      try {
        await manager.connect(node.config, secrets);
      } catch (err) {
        vscode.window.showErrorMessage(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('dittoVsce.disconnect', async () => {
      await manager.disconnect();
    }),
    vscode.commands.registerCommand('dittoVsce.openPeerListing', () => {
      vscode.window.showInformationMessage('Peer Listing — not implemented yet (Task 11).');
    }),
    vscode.commands.registerCommand('dittoVsce.newSubscription', () => {
      vscode.window.showInformationMessage('New Subscription — not implemented yet (Task 14).');
    })
  );

  context.subscriptions.push({ dispose: () => manager.disconnect() });
  output.appendLine('Ditto Edge Studio extension activated.');
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
```

- [ ] **Step 3: Build and manually verify connection**

Run:
```bash
npm run build
```

Press `F5`. In the Extension Development Host:
1. Register a database (real credentials — use the same env values you used for the spike).
2. Right-click the database row → "Connect".
3. Within ~2 seconds the row updates to `● database-name (Server, active)` and auto-expands to show `Subscriptions` and `Peer Listing` children.
4. Output panel shows `Connected to "<name>".`
5. Right-click → "Disconnect". Row collapses to `○`. Output shows `Disconnected.`

- [ ] **Step 4: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(ditto): add DittoManager singleton with connect/disconnect lifecycle"
```

---

## Task 10: SubscriptionStore + persistence (TDD)

**Goal:** Persist subscription metadata per database, with the same TDD shape as `ConfigStore`. (No SDK wiring yet — that's Task 16.)

**Files:**
- Create: `src/test/SubscriptionStore.test.ts`
- Create: `src/storage/SubscriptionStore.ts`

- [ ] **Step 1: Write the failing tests**

Create file `src/test/SubscriptionStore.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionStore } from '../storage/SubscriptionStore.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

test('list(dbId) returns [] when nothing stored', () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  assert.deepEqual(s.list('db1'), []);
});

test('save() then list() round-trips a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  assert.deepEqual(s.list('db1'), [{ id: 'sub1', name: 'tasks-all', query: 'SELECT * FROM tasks' }]);
});

test('subscriptions are scoped per database', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db2', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db2').length, 1);
  assert.equal(s.list('db1')[0].id, 'sub1');
});

test('save() updates an existing subscription by id', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub1', name: 'a-renamed', query: 'SELECT 1' });
  assert.equal(s.list('db1').length, 1);
  assert.equal(s.list('db1')[0].name, 'a-renamed');
});

test('delete() removes a subscription', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.delete('db1', 'sub1');
  assert.deepEqual(s.list('db1'), []);
});

test('deleteAll(dbId) clears all subscriptions for that DB', async () => {
  const s = new SubscriptionStore(new FakeMemento() as any);
  await s.save('db1', { id: 'sub1', name: 'a', query: 'SELECT 1' });
  await s.save('db1', { id: 'sub2', name: 'b', query: 'SELECT 2' });
  await s.deleteAll('db1');
  assert.deepEqual(s.list('db1'), []);
});
```

- [ ] **Step 2: Run tests — verify failure**

Run:
```bash
npm test
```

Expected: SubscriptionStore tests fail with module-not-found.

- [ ] **Step 3: Implement `SubscriptionStore`**

Create file `src/storage/SubscriptionStore.ts`:
```ts
import type { StoredSubscription } from '../models/DittoConfig.js';

const KEY_PREFIX = 'dittoSubscriptions.v1.';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

type Listener = (databaseId: string) => void;

export class SubscriptionStore {
  private listeners = new Set<Listener>();
  constructor(private readonly memento: MementoLike) {}

  list(databaseId: string): StoredSubscription[] {
    return this.memento.get<StoredSubscription[]>(KEY_PREFIX + databaseId) ?? [];
  }

  async save(databaseId: string, sub: StoredSubscription): Promise<void> {
    const list = this.list(databaseId);
    const idx = list.findIndex(s => s.id === sub.id);
    if (idx >= 0) { list[idx] = sub; } else { list.push(sub); }
    await this.memento.update(KEY_PREFIX + databaseId, list);
    this.fire(databaseId);
  }

  async delete(databaseId: string, id: string): Promise<void> {
    const list = this.list(databaseId).filter(s => s.id !== id);
    await this.memento.update(KEY_PREFIX + databaseId, list);
    this.fire(databaseId);
  }

  async deleteAll(databaseId: string): Promise<void> {
    await this.memento.update(KEY_PREFIX + databaseId, []);
    this.fire(databaseId);
  }

  onDidChange(l: Listener): { dispose: () => void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }

  private fire(databaseId: string) { for (const l of this.listeners) { l(databaseId); } }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run:
```bash
npm test
```

Expected: all 6 SubscriptionStore tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(storage): add SubscriptionStore with TDD coverage"
```

---

## Task 11: Tree subscription leaves + delete subscription command

**Goal:** Render persisted subscriptions as tree leaves under the `Subscriptions` parent. Wire the right-click "Delete" command. Inline `＋` opens a placeholder for now.

**Files:**
- Modify: `src/tree/DatabaseTreeProvider.ts`
- Modify: `src/test/DatabaseTreeProvider.test.ts` (extend coverage)
- Modify: `src/extension.ts` (instantiate SubscriptionStore, wire delete command)

- [ ] **Step 1: Extend the failing tests**

Append to `src/test/DatabaseTreeProvider.test.ts` (after the existing tests):
```ts
import { SubscriptionStore } from '../storage/SubscriptionStore.js';

test('Subscriptions parent expands to leaves from SubscriptionStore', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const subs = new SubscriptionStore(new FakeMemento() as any);
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', subs);
  const [root] = await provider.getRootChildren();
  const dbChildren = await provider.getNodeChildren(root);
  const subsParent = dbChildren.find(n => n.kind === 'subscriptionsParent')!;
  const leaves = await provider.getNodeChildren(subsParent);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].kind, 'subscription');
  assert.equal(leaves[0].kind === 'subscription' && leaves[0].sub.name, 'tasks-all');
});
```

You'll also need to update the prior tests' `new DatabaseTreeProvider(...)` calls to pass an empty store. Add this helper at the top of the file (after imports):
```ts
import { SubscriptionStore } from '../storage/SubscriptionStore.js';
function emptySubs(): SubscriptionStore { return new SubscriptionStore(new FakeMemento() as any); }
```

…and replace each existing `new DatabaseTreeProvider(cfg, () => '…')` with `new DatabaseTreeProvider(cfg, () => '…', emptySubs())`.

- [ ] **Step 2: Run tests — verify the new test fails (and old still pass)**

Run:
```bash
npm test
```

Expected: the new test fails (constructor signature mismatch); existing tests still pass after the helper edit.

- [ ] **Step 3: Update `DatabaseTreeProvider`**

In `src/tree/DatabaseTreeProvider.ts`:

Add the import at top:
```ts
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
```

Update the constructor signature:
```ts
constructor(
  private readonly configs: ConfigStore,
  private readonly statusFor: StatusResolver,
  private readonly subs: SubscriptionStore
) {
  configs.onDidChange(() => this._changeEmitter.fire(undefined));
  subs.onDidChange(() => this._changeEmitter.fire(undefined));
}
```

Replace the `subscriptionsParent` branch in `getNodeChildren`:
```ts
if (node.kind === 'subscriptionsParent') {
  return this.subs.list(node.databaseId).map(sub => ({
    kind: 'subscription' as const,
    databaseId: node.databaseId,
    sub
  }));
}
```

- [ ] **Step 4: Run tests — verify pass**

Run:
```bash
npm test
```

Expected: all tree-provider tests pass.

- [ ] **Step 5: Wire `SubscriptionStore` and delete command into `extension.ts`**

In `src/extension.ts`:

Add the import:
```ts
import { SubscriptionStore } from './storage/SubscriptionStore.js';
```

Inside `activate()`, after creating `secretStore`, add:
```ts
const subscriptionStore = new SubscriptionStore(context.globalState);
```

Update the tree provider construction:
```ts
const treeProvider = new DatabaseTreeProvider(configStore, id => manager.getStatus(id), subscriptionStore);
```

Add to the `commands.registerCommand` list:
```ts
vscode.commands.registerCommand('dittoVsce.deleteSubscription', async (node) => {
  if (node?.kind !== 'subscription') { return; }
  const ok = await vscode.window.showWarningMessage(
    `Delete subscription "${node.sub.name}"?`, { modal: true }, 'Delete'
  );
  if (ok === 'Delete') {
    await subscriptionStore.delete(node.databaseId, node.sub.id);
    if (manager.getActiveConfigId() === node.databaseId) {
      manager.cancelSubscription(node.sub.id);
    }
  }
}),
```

Also, in the `dittoVsce.deleteDatabase` handler (right after `await secretStore.deleteAll(node.config.id);`), add:
```ts
await subscriptionStore.deleteAll(node.config.id);
```

- [ ] **Step 6: Add `deleteSubscription` to `package.json` `commands` array**

Add to the `commands` array in `package.json`:
```json
{ "command": "dittoVsce.deleteSubscription", "title": "Delete Subscription", "icon": "$(trash)" }
```

Add to `view/item/context` menus:
```json
{ "command": "dittoVsce.deleteSubscription", "when": "view == dittoDatabases && viewItem == subscription", "group": "1@1" }
```

- [ ] **Step 7: Build and manually verify**

Run:
```bash
npm run build
```

Press `F5`. We can't yet add subscriptions through the UI (Task 14 ships that). For now, test the delete path with a seeded subscription:

In a fresh Extension Development Host, before connecting, open the `Help → Toggle Developer Tools` console, then in the Extension Host (parent VS Code's Debug Console) run a one-off seed (or skip and verify after Task 14 ships).

For now, the visible verification is: connect to a database, expand it, and confirm `Subscriptions` shows "(empty)" or simply has no leaves. (Tests already cover the leaf rendering path.)

- [ ] **Step 8: Commit**

Run:
```bash
git add .
git commit -m "feat(tree): render subscription leaves and wire delete command"
```

---

## Task 12: Peer Listing panel — extension host

**Goal:** When the user clicks the `Peer Listing` tree leaf, open a webview panel that subscribes to `DittoManager.onPresence` and forwards snapshots to the UI.

**Files:**
- Create: `src/panels/PeerListingPanel.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Implement the panel host**

Create file `src/panels/PeerListingPanel.ts`:
```ts
import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { PeerIn, PeerOut } from '../ipc/messages.js';

export class PeerListingPanel {
  private static current: PeerListingPanel | undefined;

  static show(context: vscode.ExtensionContext, manager: DittoManager, configs: ConfigStore, databaseId: string) {
    if (PeerListingPanel.current) {
      PeerListingPanel.current.panel.reveal();
      PeerListingPanel.current.refreshTitle(databaseId, configs);
      PeerListingPanel.current.pushState();
      return;
    }
    PeerListingPanel.current = new PeerListingPanel(context, manager, configs, databaseId);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly configs: ConfigStore,
    databaseId: string
  ) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel = vscode.window.createWebviewPanel(
      'dittoPeerListing',
      `Peers — ${cfg?.name ?? 'Unknown'}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'peers.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Peer Listing',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });

    this.panel.webview.onDidReceiveMessage((msg: PeerIn) => this.handle(msg), undefined, this.disposables);
    this.disposables.push(this.manager.onPresence(() => this.pushState()));
    this.disposables.push(this.manager.onStatusChange(() => this.pushState()));
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    setTimeout(() => this.pushState(), 50);
  }

  private refreshTitle(databaseId: string, configs: ConfigStore) {
    this.databaseId = databaseId;
    const cfg = configs.get(databaseId);
    this.panel.title = `Peers — ${cfg?.name ?? 'Unknown'}`;
  }

  private pushState() {
    const active = this.manager.getActiveConfigId() === this.databaseId;
    this.post({
      type: 'peer.state',
      snapshot: active ? this.manager.getLatestSnapshot() : { local: null, remote: [] },
      sync: active ? 'active' : 'idle'
    });
  }

  private post(msg: PeerOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: PeerIn) {
    if (msg.type === 'peer.toggleSync') {
      const next = await this.manager.toggleSync();
      this.post({ type: 'peer.state', snapshot: this.manager.getLatestSnapshot(), sync: next });
    }
  }

  private dispose() {
    PeerListingPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
```

- [ ] **Step 2: Wire into `extension.ts`**

Replace the `dittoVsce.openPeerListing` registration:
```ts
vscode.commands.registerCommand('dittoVsce.openPeerListing', (databaseIdOrNode) => {
  const databaseId = typeof databaseIdOrNode === 'string'
    ? databaseIdOrNode
    : databaseIdOrNode?.databaseId;
  if (!databaseId) { return; }
  PeerListingPanel.show(context, manager, configStore, databaseId);
}),
```

Add the import:
```ts
import { PeerListingPanel } from './panels/PeerListingPanel.js';
```

- [ ] **Step 3: Build and verify the panel opens (with placeholder content)**

Run:
```bash
npm run build
```

Press `F5`. Connect to a registered database. Expand it, click `Peer Listing`. A new editor tab opens labeled `Peers — <name>` showing "Peer listing — UI under construction." (the Task 7 stub). Output channel doesn't error.

- [ ] **Step 4: Commit**

Run:
```bash
git add .
git commit -m "feat(panels): add PeerListingPanel host wired to DittoManager presence"
```

---

## Task 13: Peer Listing panel — Lit UI

**Goal:** Implement the `Connected Peers` tab with `LocalPeerInfoCard` + remote peer cards. Add the `Presence Graph` segment as a "Coming soon" placeholder.

**Files:**
- Create: `webview-ui/peers/peers-element.ts`
- Modify: `webview-ui/peers/main.ts`

- [ ] **Step 1: Implement the Lit element**

Create file `webview-ui/peers/peers-element.ts`:
```ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface LocalPeer { deviceName: string; sdkLanguage: string; sdkPlatform: string; sdkVersion: string; }
interface RemotePeer {
  id: string; deviceName?: string; sdkVersion?: string; os?: string;
  connections: Array<{ type: string; address?: string }>; lastUpdate: number;
}
interface PeerSnapshot { local: LocalPeer | null; remote: RemotePeer[]; }
type In = { type: 'peer.state'; snapshot: PeerSnapshot; sync: 'active' | 'idle' };
type Tab = 'list' | 'graph';

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';
  @state() private tab: Tab = 'list';

  static styles = css`
    :host { display: block; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }
    button { padding: 4px 10px; font: inherit; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tabs button { background: transparent; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); border-radius: 0; padding: 8px 12px; }
    .tabs button.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; min-height: 220px; }
    .card h3 { margin: 0 0 8px 0; font-size: 13px; }
    .card .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin: 4px 0; }
    .card .row .label { color: var(--vscode-descriptionForeground); }
    .pill { display: inline-block; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; font-size: 11px; }
    .placeholder { padding: 48px; text-align: center; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 6px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') { this.snapshot = msg.snapshot; this.sync = msg.sync; }
    });
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  render() {
    return html`
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex:1"></span>
        <button @click=${this.toggleSync}>${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}</button>
      </div>

      <div class="tabs" role="tablist">
        <button class=${this.tab === 'list' ? 'active' : ''} @click=${() => this.tab = 'list'}>Connected Peers</button>
        <button class=${this.tab === 'graph' ? 'active' : ''} @click=${() => this.tab = 'graph'}>Presence Graph</button>
      </div>

      ${this.tab === 'list' ? this.renderList() : this.renderGraphPlaceholder()}
    `;
  }

  private renderList() {
    const { local, remote } = this.snapshot;
    if (!local && remote.length === 0) {
      return html`<div class="empty">No sync status available. Connect to see peers.</div>`;
    }
    return html`
      <div class="grid">
        ${local ? html`
          <div class="card">
            <h3>Local Peer</h3>
            <div class="row"><span class="label">Device Name</span><span>${local.deviceName}</span></div>
            <div class="row"><span class="label">SDK Language</span><span>${local.sdkLanguage}</span></div>
            <div class="row"><span class="label">SDK Platform</span><span>${local.sdkPlatform}</span></div>
            <div class="row"><span class="label">SDK Version</span><span>${local.sdkVersion}</span></div>
          </div>
        ` : nothing}
        ${remote.map(r => html`
          <div class="card">
            <h3>${r.deviceName ?? r.id.slice(0, 12)}…</h3>
            <div class="row"><span class="label">Peer ID</span><span style="font-family: var(--vscode-editor-font-family); font-size: 11px">${r.id.slice(0, 24)}…</span></div>
            <div class="row"><span class="label">OS</span><span>${r.os ?? 'unknown'}</span></div>
            <div class="row"><span class="label">SDK Version</span><span>${r.sdkVersion ?? 'unknown'}</span></div>
            <div class="row"><span class="label">Connections</span><span>${r.connections.length}</span></div>
            ${r.connections.map(c => html`
              <div class="row"><span class="pill">${c.type}</span><span style="font-size: 11px; color: var(--vscode-descriptionForeground)">${c.address ?? ''}</span></div>
            `)}
            <div class="row"><span class="label">Last update</span><span>${new Date(r.lastUpdate).toLocaleTimeString()}</span></div>
          </div>
        `)}
      </div>
    `;
  }

  private renderGraphPlaceholder() {
    return html`<div class="placeholder">Presence Graph — coming soon.<br><br>The force-directed network visualization is planned for a future release.</div>`;
  }
}
```

- [ ] **Step 2: Replace the peers entry point**

Replace `webview-ui/peers/main.ts`:
```ts
import './peers-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-peer-listing');
  root.appendChild(el);
}
```

- [ ] **Step 3: Build and manually test**

Run:
```bash
npm run build
```

Press `F5`. Connect to a database. Click `Peer Listing`. The panel shows:
- Header with sync dot (green if active) and Stop/Start Sync button.
- Tabs: `Connected Peers` (active) and `Presence Graph`.
- A `Local Peer` card with the local device's info.
- Remote peer cards (if any peers are reachable on LAN/Cloud — depends on your setup; "No sync status available" if none).
- Switch to `Presence Graph` tab → "Coming soon" placeholder.

Click Stop Sync — the dot flips to red and the button label changes. Click again — it flips back.

- [ ] **Step 4: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(peers): implement Lit-based PeerListing UI with peer cards and graph placeholder"
```

---

## Task 14: Subscription editor panel — extension host

**Goal:** Wire up the panel host for create / edit subscription. Hooks into `SubscriptionStore` and `DittoManager`.

**Files:**
- Create: `src/panels/SubscriptionEditorPanel.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Implement the host**

Create file `src/panels/SubscriptionEditorPanel.ts`:
```ts
import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { StoredSubscription } from '../models/DittoConfig.js';
import type { SubIn, SubOut } from '../ipc/messages.js';

export class SubscriptionEditorPanel {
  private static current: SubscriptionEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    subs: SubscriptionStore,
    manager: DittoManager,
    databaseId: string,
    existing?: StoredSubscription
  ) {
    if (SubscriptionEditorPanel.current) {
      SubscriptionEditorPanel.current.panel.reveal();
      SubscriptionEditorPanel.current.init(databaseId, existing);
      return;
    }
    SubscriptionEditorPanel.current = new SubscriptionEditorPanel(context, subs, manager, databaseId, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private databaseId: string;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly subs: SubscriptionStore,
    private readonly manager: DittoManager,
    databaseId: string,
    existing?: StoredSubscription
  ) {
    this.databaseId = databaseId;
    this.panel = vscode.window.createWebviewPanel(
      'dittoSubscriptionEditor',
      existing ? `Edit Subscription — ${existing.name}` : 'New Subscription',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'subscription.js')
    );
    this.panel.webview.html = panelHtml({
      title: 'Subscription',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });
    this.panel.webview.onDidReceiveMessage((msg: SubIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    setTimeout(() => this.init(databaseId, existing), 50);
  }

  private init(databaseId: string, existing?: StoredSubscription) {
    this.databaseId = databaseId;
    const payload: SubOut = {
      type: 'sub.init',
      id: existing?.id,
      name: existing?.name ?? '',
      query: existing?.query ?? ''
    };
    this.panel.webview.postMessage(payload);
  }

  private async handle(msg: SubIn) {
    if (msg.type === 'sub.cancel') { this.panel.dispose(); return; }
    if (msg.type === 'sub.save') {
      if (!msg.name.trim() || !msg.query.trim()) {
        vscode.window.showErrorMessage('Name and query are required.');
        return;
      }
      const sub: StoredSubscription = {
        id: msg.id ?? cryptoRandomId(),
        name: msg.name.trim(),
        query: msg.query.trim()
      };
      await this.subs.save(this.databaseId, sub);

      // If active, register/replace with the SDK (Task 16 wires retrofit).
      if (this.manager.getActiveConfigId() === this.databaseId) {
        this.manager.cancelSubscription(sub.id);
        this.manager.registerSubscription(sub.id, sub.query);
      }
      vscode.window.showInformationMessage(`Saved subscription "${sub.name}".`);
      this.panel.dispose();
    }
  }

  private dispose() {
    SubscriptionEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Wire into `extension.ts`**

Replace the `dittoVsce.newSubscription` registration:
```ts
vscode.commands.registerCommand('dittoVsce.newSubscription', (node) => {
  const databaseId = node?.kind === 'subscriptionsParent'
    ? node.databaseId
    : manager.getActiveConfigId();
  if (!databaseId) {
    vscode.window.showWarningMessage('Connect to a database first.');
    return;
  }
  SubscriptionEditorPanel.show(context, subscriptionStore, manager, databaseId);
}),
vscode.commands.registerCommand('dittoVsce.editSubscription', (node) => {
  if (node?.kind !== 'subscription') { return; }
  SubscriptionEditorPanel.show(context, subscriptionStore, manager, node.databaseId, node.sub);
}),
```

Add the import:
```ts
import { SubscriptionEditorPanel } from './panels/SubscriptionEditorPanel.js';
```

- [ ] **Step 3: Add command + menu entries to `package.json`**

Add to `commands` array:
```json
{ "command": "dittoVsce.editSubscription", "title": "Edit Subscription", "icon": "$(edit)" }
```

Add to `view/item/context` menu:
```json
{ "command": "dittoVsce.editSubscription", "when": "view == dittoDatabases && viewItem == subscription", "group": "1@0" }
```

- [ ] **Step 4: Build and verify panel opens (placeholder UI)**

Run:
```bash
npm run build
```

Press `F5`. Connect to a database. Click the inline `＋` button next to `Subscriptions` (in the tree row, on hover). The subscription editor opens with the placeholder text "Subscription editor — UI under construction." (real UI in next task).

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(panels): add SubscriptionEditorPanel host"
```

---

## Task 15: Subscription editor panel — Lit UI

**Goal:** Implement the small create/edit form: Name + multi-line Query + Save/Cancel.

**Files:**
- Create: `webview-ui/subscription/sub-element.ts`
- Modify: `webview-ui/subscription/main.ts`

- [ ] **Step 1: Implement the Lit element**

Create file `webview-ui/subscription/sub-element.ts`:
```ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

type In = { type: 'sub.init'; id?: string; name: string; query: string };

@customElement('ditto-subscription-editor')
export class SubscriptionEditor extends LitElement {
  @state() private id: string | undefined;
  @state() private name = '';
  @state() private query = '';

  static styles = css`
    :host { display: block; padding: 24px; max-width: 640px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    h2 { margin-top: 24px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input, textarea {
      width: 100%; padding: 6px 8px; box-sizing: border-box;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font: inherit;
    }
    textarea { font-family: var(--vscode-editor-font-family); min-height: 160px; resize: vertical; }
    .help { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer button { padding: 6px 16px; cursor: pointer; border: none; }
    .footer .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'sub.init') { this.id = msg.id; this.name = msg.name; this.query = msg.query; }
    });
  }

  private isValid() { return this.name.trim().length > 0 && this.query.trim().length > 0; }
  private save() { postToHost({ type: 'sub.save', id: this.id, name: this.name, query: this.query }); }
  private cancel() { postToHost({ type: 'sub.cancel' }); }

  render() {
    return html`
      <h2>Basic Information</h2>
      <label>Name</label>
      <input type="text" .value=${this.name} @input=${(e: Event) => this.name = (e.target as HTMLInputElement).value} />

      <h2>Query</h2>
      <textarea .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLTextAreaElement).value}></textarea>
      <div class="help">Ex: SELECT * FROM collectionName</div>

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.save}>Save</button>
      </div>
    `;
  }
}
```

- [ ] **Step 2: Replace the entry point**

Replace `webview-ui/subscription/main.ts`:
```ts
import './sub-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-subscription-editor');
  root.appendChild(el);
}
```

- [ ] **Step 3: Build and manually test**

Run:
```bash
npm run build
```

Press `F5`. Connect to a database. Hover over `Subscriptions`, click the `＋` inline button.
- The subscription editor opens with empty Name and Query fields.
- Save is disabled.
- Type Name = "tasks-all", Query = "SELECT * FROM tasks". Save enables.
- Click Save. Toast "Saved subscription 'tasks-all'." appears. Panel closes.
- The tree now shows `tasks-all   SELECT * FROM tasks` as a leaf under `Subscriptions`.
- Right-click the leaf → "Edit Subscription". Editor reopens prefilled.
- Right-click → "Delete Subscription" → confirm. Leaf disappears.

- [ ] **Step 4: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(subscription): implement Lit-based SubscriptionEditor"
```

---

## Task 16: Re-register stored subscriptions on connect

**Goal:** When a database becomes active, re-register every stored subscription with the SDK so they sync immediately. Add a smoke test that proves the round-trip.

**Files:**
- Modify: `src/ditto/DittoManager.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Extend `DittoManager.connect` to accept a list of initial subs**

In `src/ditto/DittoManager.ts`, replace the entire `connect` method with:
```ts
async connect(
  config: StoredDittoConfig,
  secrets: SecretSet,
  initialSubs: StoredSubscription[] = []
): Promise<void> {
  if (this.session) { await this.disconnect(); }
  this.setStatus('activating', config.id);
  try {
    const persistenceDir = path.join(this.context.globalStorageUri.fsPath, 'dittoData', config.id);
    fs.mkdirSync(persistenceDir, { recursive: true });

    const dittoCfg = new DittoConfig(
      config.databaseId,
      config.mode === 'server'
        ? { mode: 'server', url: config.authUrl }
        : { mode: 'smallPeersOnly' as const },
      persistenceDir
    );
    const ditto = await Ditto.open(dittoCfg);

    ditto.updateTransportConfig((c: any) => {
      c.peerToPeer.bluetoothLE.isEnabled = false;
      c.peerToPeer.awdl.isEnabled = false;
      c.peerToPeer.lan.isEnabled = true;
      c.peerToPeer.lan.isMdnsEnabled = true;
      c.peerToPeer.lan.isMulticastEnabled = true;
    });

    if (config.mode === 'server' && ditto.auth.loginSupported) {
      await ditto.auth.setExpirationHandler(async (instance: any) => {
        if (instance.auth.loginSupported) {
          await instance.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
        }
      });
      const result = await ditto.auth.login(secrets.token, Authenticator.DEVELOPMENT_PROVIDER);
      if ((result as any).error) { throw new Error(`Login failed: ${(result as any).error}`); }
    }

    ditto.sync.start();

    this.session = { configId: config.id, ditto, subscriptionHandles: new Map() };
    this.attachPresenceObserver(ditto);

    // Re-register persisted subscriptions
    for (const sub of initialSubs) {
      try {
        const handle = ditto.sync.registerSubscription(sub.query);
        this.session.subscriptionHandles.set(sub.id, handle);
      } catch (err) {
        this.output.appendLine(`Failed to register subscription "${sub.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.setStatus('active', config.id);
    this.output.appendLine(`Connected to "${config.name}".`);
  } catch (err) {
    this.output.appendLine(`Connect failed: ${err instanceof Error ? err.stack : String(err)}`);
    this.setStatus('error', config.id);
    throw err;
  }
}
```

Add the import at top:
```ts
import type { StoredSubscription } from '../models/DittoConfig.js';
```

- [ ] **Step 2: Pass stored subs from `extension.ts`**

In `src/extension.ts`, update the `dittoVsce.connect` handler:
```ts
vscode.commands.registerCommand('dittoVsce.connect', async (node) => {
  if (node?.kind !== 'database') { return; }
  const secrets = await secretStore.read(node.config.id);
  const initialSubs = subscriptionStore.list(node.config.id);
  try {
    await manager.connect(node.config, secrets, initialSubs);
  } catch (err) {
    vscode.window.showErrorMessage(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}),
```

- [ ] **Step 3: Build and manually verify**

Run:
```bash
npm run build
```

Press `F5`. With a connected database that has at least one subscription saved (from T7), disconnect, then reconnect. Open the Output panel. There should be no "Failed to register subscription" lines. The subscription leaf is still visible after reconnect.

To prove the SDK actually registered the subscription, you can confirm by adding a doc through your SwiftUI Edge Studio app to the same collection — it should sync into the VS Code extension's Ditto instance, and re-appearing in `presence` (no UI for collection viewing in this POC, but it demonstrates the wiring).

- [ ] **Step 4: Manual test recipe**

Append to `docs/MANUAL_TESTING.md`:
```markdown
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
```

- [ ] **Step 5: Commit**

Run:
```bash
git add .
git commit -m "feat(ditto): re-register stored subscriptions on connect"
```

---

## Task 17: Polish — error handling, README, final manual-test docs

**Goal:** Tighten user-facing error surfaces, document the full plan, and verify a clean `vsce package`.

**Files:**
- Modify: `src/extension.ts` (global error handler)
- Modify: `README.md`
- Modify: `docs/MANUAL_TESTING.md` (Troubleshooting section)
- Modify: `package.json` (add `vsce` to devDeps)

- [ ] **Step 1: Add a global error logger to `extension.ts`**

In `src/extension.ts`, after `output.appendLine('Ditto Edge Studio extension activated.');`, add:
```ts
process.on('uncaughtException', (err) => {
  output.appendLine(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on('unhandledRejection', (reason) => {
  output.appendLine(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
```

- [ ] **Step 2: Write a usable `README.md`**

Replace `README.md`:
```markdown
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
```

- [ ] **Step 3: Append a Troubleshooting section to `MANUAL_TESTING.md`**

Append to `docs/MANUAL_TESTING.md`:
```markdown
## Troubleshooting

### The Output panel shows `SPIKE: failed: …`

The `@dittolive/ditto` native binary couldn't load. Check:
- `node --version` is ≥ 20.
- `ls node_modules/@dittolive/ditto/dist/*.node` lists a binary matching your platform/arch (e.g. `ditto-darwin-arm64.node` on Apple Silicon).
- `npm install` ran without errors.

### Connect transitions `○` → `◐` → `⊗` (error)

Open the Output panel. The error log shows the failing call. Common causes:
- Invalid token (expired or wrong) — re-issue from https://portal.ditto.live.
- Wrong Auth URL or Websocket URL.
- No network connectivity.

### Peer Listing shows "No sync status available"

Cause: no Ditto peers are reachable. Either no other peers exist on your LAN / Cloud account, or the SDK's presence observer hasn't yet emitted a snapshot. Wait ~10 seconds, then check.

### Tree view appears empty even though a database was registered

A possible globalState key collision. Open the Command Palette → "Developer: Reload Window" in the Extension Development Host. If still empty, run "Help → Toggle Developer Tools" and inspect `Storage → Local Storage` for the `dittoConfigs.v1` key.

### Reset everything

To wipe stored configs and secrets during development, open the Extension Development Host's Command Palette → "Developer: Reset Extension Host". This clears `globalState` and `SecretStorage` for the dev profile.
```

- [ ] **Step 4: Add `@vscode/vsce` and a `package` script**

Run:
```bash
npm install --save-dev @vscode/vsce
```

Add to the `scripts` block in `package.json`:
```json
"package": "vsce package --no-dependencies"
```

> `--no-dependencies` skips npm-rewriting; we rely on the bundled `dist/extension.js` plus the shipped `node_modules/@dittolive/ditto`. For real publication later we'd revisit this.

- [ ] **Step 5: Smoke-test the package**

Run:
```bash
npm run build
npm run package
```

Expected: a `ditto-vsce-0.0.1.vsix` file appears in the project root.

- [ ] **Step 6: Final manual smoke (full end-to-end)**

In the main VS Code window, run `Extensions: Install from VSIX…` and pick the new `.vsix`. Reload the window. Walk through T1 through T8 in `docs/MANUAL_TESTING.md` against the *installed* extension (not the dev host). Everything should still work.

> If installation succeeds but activation logs an error about loading `@dittolive/ditto`, the `.vsix` is missing native binaries (a `.vscodeignore` issue or `vsce` filtering). Inspect with `unzip -l ditto-vsce-0.0.1.vsix | grep '\.node$'`. If empty, add a `.vscodeignore` that explicitly *includes* `node_modules/@dittolive/ditto/dist/**`.

- [ ] **Step 7: Commit**

Run:
```bash
git add .
git commit -m "chore: polish error handling, README, packaging, troubleshooting docs"
```

---

## Done

The POC ships:
- A registered-databases tree in the activity bar with status dots.
- Lit-based registration form covering both auth modes.
- One active Ditto SDK instance at a time, driven by `DittoManager`.
- Persisted subscriptions, registered with the SDK on connect.
- A peer-listing panel with a connected-peers grid (and a `Coming soon` placeholder for the presence graph).
- An installable `.vsix` for sharing with teammates.

Next likely follow-ups (out of scope here):
- Presence graph (vis-network or D3 force layout).
- Collections viewer + ad-hoc query editor.
- Observers tab.
- Marketplace publication pipeline + telemetry.
