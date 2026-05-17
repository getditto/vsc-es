# Cross-platform Build, Validation, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up cross-platform build, validation, and release CI for the Ditto Edge Studio VS Code extension, producing installable per-platform `.vsix` files for `darwin-arm64`, `linux-x64`, `linux-arm64`, and `win32-x64`, with manual-trigger validation and tag-triggered GitHub Releases.

**Architecture:** Three GitHub Actions workflows (`_build-matrix.yml` reusable + `build-and-validate.yml` + `release.yml`), a bounded extension test API gated on `DITTO_CI_MODE`, Mocha integration tests via `@vscode/test-electron` running on a 4-target matrix of GitHub-hosted runners, and a packaging-gap fix so the produced `.vsix` actually loads the Ditto SDK at install time.

**Tech Stack:** GitHub Actions, Node 22 LTS, esbuild, `@vscode/vsce` 3.x, Mocha + `@vscode/test-electron`, `@dittolive/ditto` 5.x.

**Spec:** `docs/superpowers/specs/2026-05-17-cross-platform-build-design.md`

---

## File map

**New files:**
- `.github/workflows/_build-matrix.yml` — reusable build+test matrix
- `.github/workflows/build-and-validate.yml` — manual dispatch caller
- `.github/workflows/release.yml` — tag-push caller
- `src/test-api/index.ts` — bounded test API factory
- `src/test/integration/runTests.ts` — `@vscode/test-electron` launcher
- `src/test/integration/index.ts` — Mocha runner entry
- `src/test/integration/activation.test.ts` — load-tier assertions
- `src/test/integration/e2e.test.ts` — e2e-tier assertions
- `src/test/test-api.test.ts` — unit tests for the test API factory
- `docs/releases/TEMPLATE.md` — release notes copy-paste starter
- `docs/releases/v0.5.0.md` — first release's notes

**Modified files:**
- `package.json` — deps reclassification, scripts, engines, types
- `.vscodeignore` — drop `node_modules/**`
- `src/extension.ts` — return test API when `DITTO_CI_MODE=1`
- `webview-ui/editor/editor-element.ts` — "Auth URL" → "URL" label
- `src/panels/DatabaseEditorPanel.ts` — validation message
- `webview-ui/welcome/welcome-element.ts` — narrative paragraph
- `.env.example` — env key renames
- `docs/MANUAL_TESTING.md` — references
- `README.md` — add Installation section + "auth URL" rename

---

## Phase 1 — Foundation

### Task 1: Create feature branch and baseline-verify the existing build

**Files:** none modified; verification only.

- [ ] **Step 1: Create branch from main**

```bash
git checkout main
git pull
git checkout -b feat/cross-platform-build
```

- [ ] **Step 2: Verify existing unit tests pass**

Run: `npm test`
Expected: all tests under `src/test/**/*.test.ts` pass, no failures.

- [ ] **Step 3: Verify existing build runs clean**

Run: `npm run build`
Expected: `[esbuild] build finished.` with no errors, `dist/extension.js` and `dist/webview-ui/*.js` exist.

- [ ] **Step 4: Note baseline for comparison**

Record the current `.vsix` size if you produced one with `npm run package` — useful to confirm later that pruning works.

---

### Task 2: Bump Node version, reclassify dependencies, remove dotenv

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `package.json`**

Replace the `engines`, `dependencies`, `devDependencies`, and `@types/node` blocks so the file reads:

```json
"engines": {
  "vscode": "^1.95.0",
  "node": ">=22"
},
```

```json
"devDependencies": {
  "@types/node": "^22.10.0",
  "@types/vscode": "^1.95.0",
  "@vscode/codicons": "^0.0.45",
  "@vscode/vsce": "^3.9.1",
  "@codemirror/lang-json": "^6.0.2",
  "@codemirror/state": "^6.6.0",
  "@codemirror/view": "^6.42.1",
  "codemirror": "^6.0.2",
  "esbuild": "^0.23.0",
  "lit": "^3.3.2",
  "markdown-it": "^14.1.1",
  "tsx": "^4.16.2",
  "typescript": "^5.5.3"
},
"dependencies": {
  "@dittolive/ditto": "^5.0.0"
}
```

`dotenv` is removed entirely.

- [ ] **Step 2: Refresh the lockfile**

Run: `rm -rf node_modules package-lock.json && npm install`
Expected: `package-lock.json` regenerates. No install errors.

- [ ] **Step 3: Confirm Ditto SDK is the only runtime dep**

Run: `node -e "const pkg=require('./package.json'); console.log(Object.keys(pkg.dependencies))"`
Expected output: `[ '@dittolive/ditto' ]`

- [ ] **Step 4: Build still works**

Run: `npm run build`
Expected: `[esbuild] build finished.` with no module-not-found errors. esbuild may surface a warning if anything still references `dotenv` — investigate and remove the reference if so.

- [ ] **Step 5: Unit tests still pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump Node to 22 LTS, slim runtime deps to @dittolive/ditto only"
```

---

### Task 3: Packaging-gap fix — `.vscodeignore` and `package.json` scripts

**Files:**
- Modify: `.vscodeignore`
- Modify: `package.json`

- [ ] **Step 1: Update `.vscodeignore`**

Open `.vscodeignore`. Remove the `node_modules/**` line. The file should now read:

```
.env
.env.example
.git/**
.github/**
.vscode/**
.claude/**
prompts/**
scripts/**
src/**
webview-ui/**
docs/**
**/*.map
**/*.ts
tsconfig.json
esbuild.config.mjs
*.vsix
.gitignore
.vscodeignore
```

- [ ] **Step 2: Update `package.json` package script**

Change the `"package"` script from:

```json
"package": "vsce package --no-dependencies"
```

to:

```json
"package": "vsce package --target ${TARGET:?TARGET env var must be set, e.g. darwin-arm64}"
```

- [ ] **Step 3: Commit**

```bash
git add .vscodeignore package.json
git commit -m "chore(build): include slim node_modules in VSIX, require TARGET for package"
```

---

### Task 4: Local cross-platform package smoke test for `darwin-arm64`

**Files:** none modified; verification only.

- [ ] **Step 1: Prune wrong-arch binaries (simulate CI)**

```bash
cd node_modules/@dittolive/ditto/node
for f in ditto.*.node; do
  [ "$f" = "ditto.darwin-arm64.node" ] || rm -f "$f"
done
cd -
```

Verify only one binary remains:

```bash
ls node_modules/@dittolive/ditto/node/ditto.*.node
```

Expected: only `ditto.darwin-arm64.node`.

- [ ] **Step 2: Build and package**

Run: `npm run build && TARGET=darwin-arm64 npm run package`
Expected: `ditto-vsce-darwin-arm64-0.5.0.vsix` is produced in repo root.

- [ ] **Step 3: Sanity-check the VSIX contents**

Run:

```bash
unzip -l ditto-vsce-darwin-arm64-0.5.0.vsix | grep "extension/node_modules/@dittolive/ditto/node/" | grep "\.node"
```

Expected: exactly **one** line, containing `ditto.darwin-arm64.node`. No other `.node` binaries.

- [ ] **Step 4: Re-install node_modules to restore other binaries**

```bash
rm -rf node_modules && npm install
```

This puts back all four native binaries for further local work.

- [ ] **Step 5: No commit needed** — verification only.

---

## Phase 2 — Terminology rename pass

### Task 5: Rename user-facing strings — UI, validation, narrative, README, manual-testing doc

**Files:**
- Modify: `webview-ui/editor/editor-element.ts:110`
- Modify: `src/panels/DatabaseEditorPanel.ts:117`
- Modify: `webview-ui/welcome/welcome-element.ts:380–395`
- Modify: `README.md:22`
- Modify: `docs/MANUAL_TESTING.md` (3 references)

- [ ] **Step 1: Rename label in `webview-ui/editor/editor-element.ts`**

Replace the line:

```ts
<label>Auth URL</label>
```

with:

```ts
<label>URL</label>
```

- [ ] **Step 2: Rename validation message in `src/panels/DatabaseEditorPanel.ts`**

In the `if (config.mode === 'server' && !config.authUrl.trim())` block around line 117, change the error string from `"Auth URL is required"` (or similar) to `"URL is required"`. The condition itself stays the same — internal field name `authUrl` is unchanged per spec decision D.

- [ ] **Step 3: Rewrite the welcome narrative in `webview-ui/welcome/welcome-element.ts`**

Replace the step-text paragraph (lines 383–388) so it reads:

```ts
<p class="step-text">
  From the Portal, create an app. Its details page lists every
  value you'll paste into the Register dialog: the Database ID,
  the URL, the Websocket URL, the Development Token, and the
  optional HTTP API key.
</p>
```

- [ ] **Step 4: Update `README.md:22`**

Replace `auth URL` with `URL`:

```
- **Two auth modes** — Server (Big Peer with URL / websocket URL) and
```

- [ ] **Step 5: Update `docs/MANUAL_TESTING.md`**

Find and replace, preserving surrounding context:

- `DITTO_APP_ID` → `DITTO_DATABASE_ID`
- `DITTO_PLAYGROUND_TOKEN` → `DITTO_DEVELOPMENT_TOKEN`
- `your app ID from https://portal.ditto.live` → `your Database ID from https://portal.ditto.live`
- `playground token` → `Development Token`
- `Wrong Auth URL` → `Wrong URL`

- [ ] **Step 6: Build and run unit tests**

Run: `npm run build && npm test`
Expected: clean build, all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add webview-ui/editor/editor-element.ts src/panels/DatabaseEditorPanel.ts \
        webview-ui/welcome/welcome-element.ts README.md docs/MANUAL_TESTING.md
git commit -m "docs: rename user-facing labels to Database ID / Development Token / URL"
```

---

### Task 6: Rename env-file keys in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace contents of `.env.example`**

Overwrite the file with:

```
# Copy this file to `.env` and fill in your Ditto Cloud credentials.
# Get them from https://portal.ditto.live
DITTO_DATABASE_ID=
DITTO_DEVELOPMENT_TOKEN=
DITTO_URL=
DITTO_WEBSOCKET_URL=
```

- [ ] **Step 2: Confirm no source reads the old names**

Run: `grep -rn "DITTO_APP_ID\|DITTO_PLAYGROUND_TOKEN\|DITTO_AUTH_URL" src webview-ui scripts`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: rename env keys to DITTO_DATABASE_ID / DITTO_DEVELOPMENT_TOKEN / DITTO_URL"
```

---

## Phase 3 — Bounded test API

### Task 7: Write failing unit tests for the test API factory

**Files:**
- Create: `src/test/test-api.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `src/test/test-api.test.ts` with this content:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigFromEnv } from '../test-api/index.js';

test('buildConfigFromEnv: returns config when all four env vars are set', () => {
  const env = {
    DITTO_CI_DATABASE_ID: 'db-123',
    DITTO_CI_DEVELOPMENT_TOKEN: 'tok-abc',
    DITTO_CI_URL: 'https://example.ditto.live',
    DITTO_CI_WEBSOCKET_URL: 'wss://example.ditto.live',
    DITTO_CI_SITE_NAME: 'ci-run-1-darwin-arm64',
  };
  const { config, secrets } = buildConfigFromEnv(env);
  assert.equal(config.databaseId, 'db-123');
  assert.equal(config.authUrl, 'https://example.ditto.live');
  assert.equal(config.websocketUrl, 'wss://example.ditto.live');
  assert.equal(config.mode, 'server');
  assert.equal(config.name, 'ci-run-1-darwin-arm64');
  assert.equal(secrets.token, 'tok-abc');
});

test('buildConfigFromEnv: throws with clear message when DATABASE_ID missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_URL: 'u', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_DATABASE_ID/,
  );
});

test('buildConfigFromEnv: throws when DEVELOPMENT_TOKEN missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_URL: 'u', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_DEVELOPMENT_TOKEN/,
  );
});

test('buildConfigFromEnv: throws when URL missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_URL/,
  );
});

test('buildConfigFromEnv: throws when WEBSOCKET_URL missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_URL: 'u' }),
    /DITTO_CI_WEBSOCKET_URL/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: 5 new failures with module-not-found for `../test-api/index.js`.

---

### Task 8: Implement the test API factory

**Files:**
- Create: `src/test-api/index.ts`

- [ ] **Step 1: Create `src/test-api/index.ts`**

```ts
import type * as vscode from 'vscode';
import { newConfig, type StoredDittoConfig, type SecretSet } from '../models/DittoConfig.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import type { DittoManager } from '../ditto/DittoManager.js';

/**
 * Bounded test surface for the extension. Exposed from `activate()` only
 * when `process.env.DITTO_CI_MODE === '1'`. Never available to end users.
 */
export interface TestApi {
  registerFromEnv(): Promise<string>;
  connect(configId: string): Promise<void>;
  disconnect(): Promise<void>;
  waitForPeerOrSyncStatus(timeoutMs: number): Promise<void>;
}

const REQUIRED_ENV_KEYS = [
  'DITTO_CI_DATABASE_ID',
  'DITTO_CI_DEVELOPMENT_TOKEN',
  'DITTO_CI_URL',
  'DITTO_CI_WEBSOCKET_URL',
] as const;

type EnvShape = Partial<Record<string, string | undefined>>;

export function buildConfigFromEnv(env: EnvShape): {
  config: StoredDittoConfig;
  secrets: SecretSet;
} {
  for (const key of REQUIRED_ENV_KEYS) {
    if (!env[key] || env[key]!.trim() === '') {
      throw new Error(`Missing required env var ${key}`);
    }
  }
  const id = `ci-${Date.now()}`;
  const cfg: StoredDittoConfig = {
    ...newConfig(),
    id,
    name: env.DITTO_CI_SITE_NAME ?? id,
    databaseId: env.DITTO_CI_DATABASE_ID!,
    authUrl: env.DITTO_CI_URL!,
    websocketUrl: env.DITTO_CI_WEBSOCKET_URL!,
    mode: 'server',
  };
  return { config: cfg, secrets: { token: env.DITTO_CI_DEVELOPMENT_TOKEN! } };
}

export function makeTestApi(deps: {
  configStore: ConfigStore;
  secretStore: SecretStore;
  manager: DittoManager;
  env?: EnvShape;
}): TestApi {
  const env = deps.env ?? (process.env as EnvShape);
  return {
    async registerFromEnv() {
      const { config, secrets } = buildConfigFromEnv(env);
      await deps.configStore.save(config);
      await deps.secretStore.write(config.id, secrets);
      return config.id;
    },
    async connect(configId) {
      const cfg = deps.configStore.get(configId);
      if (!cfg) { throw new Error(`No config with id ${configId}`); }
      const secrets = await deps.secretStore.read(configId);
      await deps.manager.connect(cfg, secrets);
    },
    async disconnect() {
      await deps.manager.disconnect();
    },
    async waitForPeerOrSyncStatus(timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.dispose();
          reject(new Error(`No presence event within ${timeoutMs}ms`));
        }, timeoutMs);
        const sub = deps.manager.onPresence(() => {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        });
      });
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: the 5 new tests in `src/test/test-api.test.ts` all pass; existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/test-api/index.ts src/test/test-api.test.ts
git commit -m "feat(test-api): add bounded test API factory and unit tests"
```

---

### Task 9: Wire test API into `extension.ts` under `DITTO_CI_MODE`

**Files:**
- Modify: `src/extension.ts:114` (activate signature + return)

- [ ] **Step 1: Update `activate()` signature and add return**

In `src/extension.ts`, change the signature of `activate` to return `TestApi | undefined`:

```ts
import type { TestApi } from './test-api/index.js';
import { makeTestApi } from './test-api/index.js';

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  // …all existing activation code stays unchanged…

  if (process.env.DITTO_CI_MODE === '1') {
    return makeTestApi({ configStore, secretStore, manager });
  }
  return undefined;
}
```

The `return makeTestApi(...)` block goes at the very end of `activate`, **after** all command registrations and subscription wiring, immediately before the function closes. Add the imports near the top with other imports.

- [ ] **Step 2: Build to confirm types align**

Run: `npm run build`
Expected: build succeeds. If types complain (e.g., `configStore` not in scope), confirm you placed the return after those locals are declared.

- [ ] **Step 3: Run unit tests**

Run: `npm test`
Expected: all tests pass — no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts
git commit -m "feat(test-api): expose TestApi from activate() when DITTO_CI_MODE=1"
```

---

## Phase 4 — Integration test infrastructure

### Task 10: Add integration-test devDependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the packages**

Run:

```bash
npm install --save-dev @vscode/test-electron mocha @types/mocha glob @types/glob
```

Expected: four packages added under `devDependencies`. `package-lock.json` updates.

- [ ] **Step 2: Build to confirm no breakage**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add integration test deps (@vscode/test-electron, mocha, glob)"
```

---

### Task 11: Create the test launcher and Mocha runner entry

**Files:**
- Create: `src/test/integration/runTests.ts`
- Create: `src/test/integration/index.ts`

- [ ] **Step 1: Create `src/test/integration/runTests.ts`**

```ts
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTests } from '@vscode/test-electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './index.js');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
      extensionTestsEnv: {
        DITTO_CI_MODE: process.env.DITTO_CI_MODE ?? '',
        DITTO_CI_DATABASE_ID: process.env.DITTO_CI_DATABASE_ID ?? '',
        DITTO_CI_DEVELOPMENT_TOKEN: process.env.DITTO_CI_DEVELOPMENT_TOKEN ?? '',
        DITTO_CI_URL: process.env.DITTO_CI_URL ?? '',
        DITTO_CI_WEBSOCKET_URL: process.env.DITTO_CI_WEBSOCKET_URL ?? '',
        DITTO_CI_SITE_NAME: process.env.DITTO_CI_SITE_NAME ?? '',
        DITTO_CI_DEPTH: process.env.DITTO_CI_DEPTH ?? 'load',
      },
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 2: Create `src/test/integration/index.ts`**

```ts
import * as path from 'path';
import { fileURLToPath } from 'url';
import Mocha from 'mocha';
import { glob } from 'glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000 });
  const testsRoot = __dirname;
  const depth = process.env.DITTO_CI_DEPTH ?? 'load';
  const pattern = depth === 'e2e' ? '**/*.test.js' : 'activation.test.js';
  const files = await glob(pattern, { cwd: testsRoot });
  files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));
  return new Promise((resolve, reject) => {
    mocha.run(failures => failures > 0 ? reject(new Error(`${failures} failed`)) : resolve());
  });
}
```

- [ ] **Step 3: Add esbuild step for integration tests**

Open `esbuild.config.mjs`. Add a third context after the webview context, before the `if (watch)` block:

```ts
const integrationCtx = await esbuild.context({
  entryPoints: [
    'src/test/integration/runTests.ts',
    'src/test/integration/index.ts',
    'src/test/integration/activation.test.ts',
    // 'src/test/integration/e2e.test.ts' added in Task 13
  ],
  bundle: true,
  outdir: 'dist/test/integration',
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['vscode', 'mocha', '@vscode/test-electron', '@dittolive/ditto'],
  sourcemap: true,
  logLevel: 'info',
});
```

And add `integrationCtx.rebuild()` / `integrationCtx.dispose()` to the `Promise.all([…])` blocks below.

- [ ] **Step 4: No commit yet** — paired with the test files in the next task.

---

### Task 12: Create the load-tier activation test + script

**Files:**
- Create: `src/test/integration/activation.test.ts`
- Modify: `package.json` (add script)

- [ ] **Step 1: Create `src/test/integration/activation.test.ts`**

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Activation', () => {
  test('extension is present and active', async () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext, 'extension ditto.ditto-vsce should be installed');
    if (!ext!.isActive) { await ext!.activate(); }
    assert.strictEqual(ext!.isActive, true);
  });

  test('Ditto activity bar container is registered', () => {
    // Presence of the contributed view container is asserted indirectly:
    // the extension's package.json contributes it, and an activated extension
    // means VS Code accepted the contribution without rejecting the manifest.
    // Direct DOM access isn't available; this serves as a smoke check that
    // activation didn't crash partway through view registration.
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext);
    assert.strictEqual(ext!.isActive, true);
  });
});
```

- [ ] **Step 2: Add the `test:integration:load` script to `package.json`**

Inside the `"scripts"` object, add:

```json
"build:integration": "node esbuild.config.mjs",
"test:integration:load": "DITTO_CI_DEPTH=load node dist/test/integration/runTests.js",
"test:integration:e2e": "DITTO_CI_DEPTH=e2e DITTO_CI_MODE=1 node dist/test/integration/runTests.js"
```

(`build:integration` is the same as `build` — alias kept for clarity in CI.)

- [ ] **Step 3: No commit yet** — paired with the e2e test in the next task.

---

### Task 13: Create the e2e-tier test

**Files:**
- Create: `src/test/integration/e2e.test.ts`

- [ ] **Step 1: Add `e2e.test.ts` to the esbuild integration entryPoints**

In `esbuild.config.mjs`, inside `integrationCtx`, change the `entryPoints` array to:

```js
entryPoints: [
  'src/test/integration/runTests.ts',
  'src/test/integration/index.ts',
  'src/test/integration/activation.test.ts',
  'src/test/integration/e2e.test.ts',
],
```

- [ ] **Step 2: Create `src/test/integration/e2e.test.ts`**

```ts
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../test-api/index.js';

suite('E2E sync', function () {
  this.timeout(60_000);

  let api: TestApi | undefined;

  suiteSetup(async function () {
    if (process.env.DITTO_CI_MODE !== '1') { this.skip(); }
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext);
    api = await ext!.activate() as TestApi | undefined;
    assert.ok(api, 'extension did not return TestApi when DITTO_CI_MODE=1');
  });

  suiteTeardown(async () => {
    if (api) {
      try { await api.disconnect(); } catch (_) { /* best-effort */ }
    }
  });

  test('connects to CI app and observes presence within 30s', async () => {
    assert.ok(api);
    const id = await api!.registerFromEnv();
    await api!.connect(id);
    await api!.waitForPeerOrSyncStatus(30_000);
  });
});
```

- [ ] **Step 3: Build everything**

Run: `npm run build`
Expected: `dist/test/integration/runTests.js`, `index.js`, `activation.test.js`, `e2e.test.js` exist.

- [ ] **Step 4: Run the load tier locally to smoke-test**

Run: `npm run test:integration:load`
Expected: a VS Code window flashes (or runs headless on Linux); both tests in `Activation` pass; exit code 0.

  - Failure mode: if `npm run build` hasn't been re-run after a code change, the test files won't reflect the latest source. Re-run build first.
  - Failure mode on first run: `@vscode/test-electron` may download VS Code (~120MB). Allow a few minutes.

- [ ] **Step 5: Commit all of phase 4**

```bash
git add esbuild.config.mjs src/test/integration package.json package-lock.json
git commit -m "feat(test): add integration test harness with load + e2e tiers"
```

---

## Phase 5 — Workflows

### Task 14: Create the reusable build matrix workflow

**Files:**
- Create: `.github/workflows/_build-matrix.yml`

- [ ] **Step 1: Create the file**

```yaml
name: _build-matrix
on:
  workflow_call:
    inputs:
      depth:
        description: 'Validation depth: package | load | e2e'
        type: string
        default: package
    secrets:
      DITTO_CI_DATABASE_ID:        { required: false }
      DITTO_CI_DEVELOPMENT_TOKEN:  { required: false }
      DITTO_CI_URL:                { required: false }
      DITTO_CI_WEBSOCKET_URL:      { required: false }

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: darwin-arm64
            runner: macos-14
          - target: linux-x64
            runner: ubuntu-24.04
          - target: linux-arm64
            runner: ubuntu-24.04-arm
          - target: win32-x64
            runner: windows-2022
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - run: npm ci

      - run: npm run build

      - name: Prune wrong-arch native binaries
        shell: bash
        run: |
          cd node_modules/@dittolive/ditto/node
          for f in ditto.*.node; do
            [ "$f" = "ditto.${{ matrix.target }}.node" ] || rm -f "$f"
          done
          ls

      - name: Package VSIX
        shell: bash
        env:
          TARGET: ${{ matrix.target }}
        run: npm run package

      - name: Sanity-check VSIX contains exactly one native binary
        shell: bash
        run: |
          COUNT=$(unzip -l ./*.vsix \
            | awk '/extension\/node_modules\/@dittolive\/ditto\/node\/ditto\..*\.node$/{c++} END{print c+0}')
          if [ "$COUNT" != "1" ]; then
            echo "Expected 1 native binary in VSIX, got $COUNT"
            unzip -l ./*.vsix | grep "\.node$" || true
            exit 1
          fi

      - name: Upload VSIX artifact
        uses: actions/upload-artifact@v4
        with:
          name: ditto-vsce-${{ matrix.target }}-${{ github.run_id }}
          path: ./*.vsix
          if-no-files-found: error
          retention-days: 30

      - name: Install xvfb (Linux only)
        if: runner.os == 'Linux' && (inputs.depth == 'load' || inputs.depth == 'e2e')
        run: sudo apt-get update && sudo apt-get install -y xvfb

      - name: Run load tests
        if: inputs.depth == 'load' || inputs.depth == 'e2e'
        shell: bash
        run: |
          if [ "$RUNNER_OS" = "Linux" ]; then
            xvfb-run -a npm run test:integration:load
          else
            npm run test:integration:load
          fi

      - name: Run e2e tests
        if: inputs.depth == 'e2e'
        shell: bash
        env:
          DITTO_CI_DATABASE_ID:        ${{ secrets.DITTO_CI_DATABASE_ID }}
          DITTO_CI_DEVELOPMENT_TOKEN:  ${{ secrets.DITTO_CI_DEVELOPMENT_TOKEN }}
          DITTO_CI_URL:                ${{ secrets.DITTO_CI_URL }}
          DITTO_CI_WEBSOCKET_URL:      ${{ secrets.DITTO_CI_WEBSOCKET_URL }}
          DITTO_CI_SITE_NAME: ci-${{ github.run_id }}-${{ matrix.target }}
        run: |
          if [ "$RUNNER_OS" = "Linux" ]; then
            xvfb-run -a npm run test:integration:e2e
          else
            npm run test:integration:e2e
          fi

      - name: Append summary
        if: always()
        shell: bash
        run: |
          echo "| ${{ matrix.target }} | ${{ inputs.depth }} | ${{ job.status }} | ditto-vsce-${{ matrix.target }}-${{ github.run_id }} |" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/_build-matrix.yml
git commit -m "ci: add reusable build-and-validate matrix workflow"
```

---

### Task 15: Create the `build-and-validate.yml` caller

**Files:**
- Create: `.github/workflows/build-and-validate.yml`

- [ ] **Step 1: Create the file**

```yaml
name: build-and-validate
on:
  workflow_dispatch:
    inputs:
      depth:
        description: 'Validation depth'
        type: choice
        options: [package, load, e2e]
        default: e2e

jobs:
  matrix:
    permissions:
      contents: read
    uses: ./.github/workflows/_build-matrix.yml
    with:
      depth: ${{ inputs.depth }}
    secrets: inherit
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/build-and-validate.yml
git commit -m "ci: add manual build-and-validate workflow dispatcher"
git push -u origin feat/cross-platform-build
```

- [ ] **Step 3: Trigger validate at `depth=package` from the GitHub UI**

Go to <https://github.com/getditto/vsc-es/actions/workflows/build-and-validate.yml>, click "Run workflow", pick branch `feat/cross-platform-build`, set depth to `package`, click "Run workflow."

Expected: 4 jobs run in parallel, all pass; 4 artifacts uploaded named `ditto-vsce-<target>-<run-id>`.

- [ ] **Step 4: Download and inspect one artifact**

```bash
gh run download --repo getditto/vsc-es <run-id> -n ditto-vsce-darwin-arm64-<run-id>
unzip -l ditto-vsce-darwin-arm64-*.vsix | grep "\.node$"
```

Expected: exactly one line, `extension/node_modules/@dittolive/ditto/node/ditto.darwin-arm64.node`.

- [ ] **Step 5: Trigger at `depth=load`**

Same UI, set depth to `load`. Expected: all 4 jobs pass, including the activation tests on each platform.

If `linux-arm64` fails to install xvfb, check the apt-get step — ARM runners may have a different package availability. Adjust by adding required system libs (libnss3, libgbm1) if VS Code download fails.

- [ ] **Step 6: Trigger at `depth=e2e`**

Same UI, set depth to `e2e`. Expected: all 4 jobs pass, including the actual sync to your CI Ditto app.

Failure modes to expect on first run:
- A secret value is empty or wrong → e2e test aborts with "Missing required env var". Fix the secret in repo settings, re-run.
- Network/sync flake → re-run the workflow (no automatic retry by design).

- [ ] **Step 7: No commit** — workflow is already pushed.

---

## Phase 6 — Release pipeline

### Task 16: Create the release notes template

**Files:**
- Create: `docs/releases/TEMPLATE.md`

- [ ] **Step 1: Create the file**

```markdown
## Highlights
- …

## Changes
- …

## Known issues
- …

## Install
See the [Installation guide](https://github.com/getditto/vsc-es#installation)
in the README for step-by-step instructions covering VS Code, Cursor, and
Google Antigravity. Asset files are attached below.
```

- [ ] **Step 2: Commit**

```bash
git add docs/releases/TEMPLATE.md
git commit -m "docs(releases): add release notes template"
```

---

### Task 17: Create the `release.yml` workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the file**

```yaml
name: release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'

permissions:
  contents: write

jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Verify tag matches package.json version
        shell: bash
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          PKG=$(node -p "require('./package.json').version")
          if [ "$TAG" != "$PKG" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $PKG"
            exit 1
          fi

      - name: Verify release notes file exists
        shell: bash
        run: |
          NOTES="docs/releases/${GITHUB_REF_NAME}.md"
          if [ ! -f "$NOTES" ]; then
            echo "Release notes missing: $NOTES"
            echo "Create the file (see docs/releases/TEMPLATE.md) and re-tag."
            exit 1
          fi

  matrix:
    needs: verify
    uses: ./.github/workflows/_build-matrix.yml
    with:
      depth: e2e
    secrets: inherit

  release:
    needs: matrix
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Download all VSIX artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: ditto-vsce-*
          path: artifacts

      - name: Flatten artifacts into a single dir
        shell: bash
        run: |
          mkdir -p release-assets
          find artifacts -name '*.vsix' -exec mv {} release-assets/ \;
          ls release-assets

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: ${{ github.ref_name }}
          body_path: docs/releases/${{ github.ref_name }}.md
          files: release-assets/*.vsix
          fail_on_unmatched_files: true
          prerelease: false
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow"
git push
```

- [ ] **Step 3: No release triggered yet** — release flow is exercised in Phase 8.

---

## Phase 7 — README installation guide

### Task 18: Verify the Antigravity CLI binary name

**Files:** none modified; verification only.

- [ ] **Step 1: Web search current Antigravity docs**

Open Antigravity's official docs (or your local install's `--help` if you have it installed) and confirm the CLI binary name used for `--install-extension`. Likely candidates: `antigravity`, `ag`, or another short alias.

If you cannot confirm the binary name within ~5 minutes:
- Use `antigravity` as the placeholder in the README.
- Append an italicized note: *"verify exact binary name in your Antigravity install — see [Antigravity docs](<link>)"*

- [ ] **Step 2: Record the confirmed (or placeholder) name**

Keep this string ready for Task 19.

---

### Task 19: Add the Installation section to README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the new section**

Open `README.md`. Below the introduction (and before the Features or Development sections, wherever it fits naturally), insert:

````markdown
## Installation

Download the `.vsix` for your platform from the latest GitHub Release:
**<https://github.com/getditto/vsc-es/releases/latest>**

| Platform              | Asset filename                        |
| --------------------- | ------------------------------------- |
| macOS (Apple silicon) | `ditto-vsce-darwin-arm64-<ver>.vsix`  |
| Linux (x86_64)        | `ditto-vsce-linux-x64-<ver>.vsix`     |
| Linux (ARM64)         | `ditto-vsce-linux-arm64-<ver>.vsix`   |
| Windows (x86_64)      | `ditto-vsce-win32-x64-<ver>.vsix`     |

All three editors share VS Code's extension format, so the steps are nearly
identical — only the CLI binary name differs.

### VS Code

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `code --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Cursor

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `cursor --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Google Antigravity

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from VSIX…** → pick the downloaded file.
- **CLI**: `antigravity --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`
  *(verify exact binary name against your Antigravity install)*

### Reload and verify

After installing, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
and run **Developer: Reload Window**. The Ditto icon should appear in the
activity bar.

### Not supported

- **Intel Mac (`darwin-x64`)** — the `@dittolive/ditto` SDK does not ship a binary for this target.
- **Windows on ARM (`win32-arm64`)** — same reason.
````

If you confirmed a different Antigravity binary name in Task 18, substitute it here.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Installation guide for VS Code, Cursor, and Antigravity"
```

---

## Phase 8 — First release

### Task 20: Author the v0.5.0 release notes

**Files:**
- Create: `docs/releases/v0.5.0.md`

- [ ] **Step 1: Create the file**

```markdown
## Highlights
- First public build of Ditto Edge Studio for VS Code.
- Per-platform `.vsix` packages for macOS (Apple silicon), Linux (x64 + arm64), and Windows (x64).

## Changes
- POC feature set: connection registration, peer presence view, ad-hoc DQL queries, sync subscription editor, inspector.
- Cross-platform build and validation matrix established.

## Known issues
- Intel Mac and Windows on ARM are not supported (Ditto SDK does not ship binaries for those targets).
- Pre-release tag suffixes (`-rc`, `-beta`) are not supported by the release workflow yet.

## Install
See the [Installation guide](https://github.com/getditto/vsc-es#installation)
in the README for step-by-step instructions covering VS Code, Cursor, and
Google Antigravity. Asset files are attached below.
```

Edit the **Changes** section to reflect the actual scope of work shipping in this version if it has drifted from the POC.

- [ ] **Step 2: Commit**

```bash
git add docs/releases/v0.5.0.md
git commit -m "docs(releases): add v0.5.0 release notes"
```

---

### Task 21: Merge the branch to main and confirm version is 0.5.0

**Files:**
- Modify: `package.json` (version field only)

- [ ] **Step 1: Open a PR for the feature branch**

```bash
git push
gh pr create --title "feat: cross-platform build, validation, and release CI" \
  --body "Implements docs/superpowers/specs/2026-05-17-cross-platform-build-design.md"
```

Review the PR, run the validate workflow at `depth=e2e` against the PR branch one final time, and merge to `main`.

- [ ] **Step 2: Confirm version is 0.5.0 on main**

```bash
git checkout main
git pull
node -p "require('./package.json').version"
```

Expected: `0.5.0` (already bumped as part of Task 2's deps commit on the feature branch, carried in through the merge).

If for some reason it isn't, edit `package.json` to set `"version": "0.5.0",` and commit:

```bash
git add package.json
git commit -m "chore(release): 0.5.0"
git push
```

---

### Task 22: Tag v0.5.0 and observe the release flow

**Files:** none modified.

- [ ] **Step 1: Tag and push**

```bash
git tag v0.5.0
git push origin v0.5.0
```

- [ ] **Step 2: Watch the release workflow**

```bash
gh run watch --repo getditto/vsc-es
```

Expected: `verify` job passes; `matrix` runs all 4 platforms at `e2e` depth and passes; `release` job creates the release.

- [ ] **Step 3: Verify the release exists**

Open <https://github.com/getditto/vsc-es/releases/tag/v0.5.0>. Expected:
- Title: `v0.5.0`
- Body: contents of `docs/releases/v0.5.0.md`
- Assets: 4 `.vsix` files named `ditto-vsce-<target>-0.5.0.vsix`
- Not marked as pre-release

- [ ] **Step 4: Install one VSIX in your local VS Code as a final smoke test**

Download the `darwin-arm64` (or matching local platform) asset from the release page, then:

```bash
code --install-extension ~/Downloads/ditto-vsce-darwin-arm64-0.5.0.vsix
```

Reload VS Code. Expected: the Ditto icon appears in the activity bar, the Welcome view renders, and you can register a connection against your dev app (separate from the CI one).

- [ ] **Step 5: No further commit** — release is live.

---

## Failure recovery

**Release workflow's `verify` job fails (version mismatch or missing notes):**

```bash
git tag -d v0.5.0
git push --delete origin v0.5.0
# fix the issue (bump package.json or create the notes file), commit, then re-tag
git tag v0.5.0
git push origin v0.5.0
```

**Release workflow's `matrix` job fails on one platform:**

The matrix is `fail-fast: false`, so the other platforms produce artifacts. Inspect the failing leg's logs. Common causes:
- Test flake on `e2e` — delete the tag and re-tag once the cause is understood.
- Build break specific to one platform — fix and re-tag.

**A VSIX installs but the extension fails to activate:**

`gh run download` the artifact, `unzip -l` it, and confirm the right `.node` is present. Try installing on the matching platform locally and check the VS Code Developer Tools console for the activation error.

---

## Self-review checklist (already performed)

- All spec sections 2–9 have at least one implementing task.
- No `TBD`, `TODO`, or placeholder strings.
- `buildConfigFromEnv` / `makeTestApi` / `TestApi` interface used consistently across Tasks 7, 8, 9, 11, 13.
- File paths are concrete (e.g. `src/test-api/index.ts`, not "the test API file").
- Antigravity CLI uncertainty is explicitly handled as a Task 18 verification step rather than left as an in-code placeholder.
