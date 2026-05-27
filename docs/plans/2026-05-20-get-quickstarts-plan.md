# Get Quickstarts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Get Quickstarts" feature that clones the `getditto/quickstart` repo into a user-chosen folder and pre-fills `.env` files (and the Edge Server YAML) from the currently active connection. Reachable from the Help tree, Welcome card, and Command Palette.

**Architecture:** A UI-free `QuickstartService` handles git ops and file writes via an injected `GitRunner` interface (Node `spawn`-backed by default; tests stub it). A flow controller in `extension.ts` glues the service to VS Code dialogs and a single `withProgress` notification. SwiftUI's `QuickstartDownloadService.swift` is the byte-exact reference for `.env` / YAML content.

**Tech Stack:** TypeScript, VS Code Extension API, Node `child_process` (`spawn` only — argument-array form, no shell), Lit (existing welcome webview), Node test runner (`node --import tsx --test`).

**Reference docs:**
- Spec: `docs/specs/2026-05-20-get-quickstarts-design.md`
- SwiftUI reference: `/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/EdgeStudio/Data/QuickstartDownloadService.swift`
- Upstream quickstart repo: <https://github.com/getditto/quickstart>

---

## Task 1: Add quickstart-projects constants module

**Files:**
- Create: `src/quickstart/quickstart-projects.ts`
- Create: `src/test/quickstart-projects.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test/quickstart-projects.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICKSTART_PROJECTS,
  QUICKSTART_REPO_URL,
  QUICKSTART_FOLDER_NAME,
  ENV_DESTINATIONS,
  EDGE_SERVER_RELATIVE_DIR,
  EDGE_SERVER_YAML_NAME,
} from '../quickstart/quickstart-projects.js';

test('QUICKSTART_PROJECTS — every entry has non-empty directoryName and displayName', () => {
  assert.ok(QUICKSTART_PROJECTS.length > 0, 'must list at least one project');
  for (const p of QUICKSTART_PROJECTS) {
    assert.ok(p.directoryName.length > 0, `empty directoryName in entry ${JSON.stringify(p)}`);
    assert.ok(p.displayName.length > 0, `empty displayName in entry ${JSON.stringify(p)}`);
  }
});

test('QUICKSTART_PROJECTS — directoryNames are unique', () => {
  const seen = new Set<string>();
  for (const p of QUICKSTART_PROJECTS) {
    assert.equal(seen.has(p.directoryName), false, `duplicate directoryName: ${p.directoryName}`);
    seen.add(p.directoryName);
  }
});

test('ENV_DESTINATIONS — matches SwiftUI: root + flutter_app + go-tui', () => {
  assert.deepEqual(ENV_DESTINATIONS, ['.env', 'flutter_app/.env', 'go-tui/.env']);
});

test('Repo URL and folder name match SwiftUI/upstream', () => {
  assert.equal(QUICKSTART_REPO_URL, 'https://github.com/getditto/quickstart.git');
  assert.equal(QUICKSTART_FOLDER_NAME, 'quickstart');
  assert.equal(EDGE_SERVER_RELATIVE_DIR, 'edge-server');
  assert.equal(EDGE_SERVER_YAML_NAME, 'quickstart_config.yaml');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import tsx --test src/test/quickstart-projects.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` for `../quickstart/quickstart-projects.js`.

- [ ] **Step 3: Create the constants module**

Create `src/quickstart/quickstart-projects.ts`:

```ts
/**
 * Single source of truth for what we know about the upstream
 * `getditto/quickstart` repo. Update here when the repo restructures
 * or adds a new per-project .env destination.
 *
 * Mirrors SwiftUI Edge Studio's `QuickstartDownloadService.swift`
 * — keep the two lists in sync when upstream changes.
 */

export interface QuickstartProject {
  /** Directory name in the cloned repo. */
  readonly directoryName: string;
  /** Human-readable label for UI surfaces. */
  readonly displayName: string;
}

export const QUICKSTART_REPO_URL = 'https://github.com/getditto/quickstart.git';

/** Default sub-directory name produced by `git clone <repo>` with no rename. */
export const QUICKSTART_FOLDER_NAME = 'quickstart';

/**
 * Relative paths (from the cloned repo root) where we write `.env`.
 * Hard-coded to match SwiftUI exactly — see design doc § ".env destinations".
 */
export const ENV_DESTINATIONS: readonly string[] = [
  '.env',
  'flutter_app/.env',
  'go-tui/.env',
];

/** Subfolder containing the Edge Server YAML; only configured when present. */
export const EDGE_SERVER_RELATIVE_DIR = 'edge-server';
export const EDGE_SERVER_YAML_NAME = 'quickstart_config.yaml';

/** Hard-coded project list, sorted by displayName for deterministic UI. */
export const QUICKSTART_PROJECTS: readonly QuickstartProject[] = [
  { directoryName: 'android-java',          displayName: 'Android Java' },
  { directoryName: 'android-kotlin',        displayName: 'Android Kotlin' },
  { directoryName: 'cpp-tui',               displayName: 'C++ TUI' },
  { directoryName: 'dotnet-maui',           displayName: '.NET MAUI' },
  { directoryName: 'dotnet-tui',            displayName: '.NET TUI' },
  { directoryName: 'dotnet-winforms',       displayName: '.NET WinForms' },
  { directoryName: 'edge-server',           displayName: 'Edge Server' },
  { directoryName: 'flutter_app',           displayName: 'Flutter' },
  { directoryName: 'go-tui',                displayName: 'Go TUI' },
  { directoryName: 'java-server',           displayName: 'Java Server' },
  { directoryName: 'javascript-tui',        displayName: 'JavaScript TUI' },
  { directoryName: 'javascript-web',        displayName: 'JavaScript Web' },
  { directoryName: 'kotlin-multiplatform',  displayName: 'Kotlin Multiplatform' },
  { directoryName: 'react-native',          displayName: 'React Native' },
  { directoryName: 'react-native-expo',     displayName: 'React Native Expo' },
  { directoryName: 'rust-tui',              displayName: 'Rust TUI' },
  { directoryName: 'swift',                 displayName: 'Swift' },
];
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import tsx --test src/test/quickstart-projects.test.ts`

Expected: 4 tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/quickstart/quickstart-projects.ts src/test/quickstart-projects.test.ts
git commit -m "feat(quickstart): add quickstart-projects constants module

Hard-coded SwiftUI-parity project list, .env destinations, and edge-server
YAML path. Single source of truth for what we know about the upstream
getditto/quickstart repo structure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: QuickstartService — content generators + writeEnvFiles

**Files:**
- Create: `src/quickstart/QuickstartService.ts` (initial skeleton + env writing)
- Create: `src/test/QuickstartService.test.ts`

- [ ] **Step 1: Write the failing test for writeEnvFiles**

Create `src/test/QuickstartService.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuickstartService } from '../quickstart/QuickstartService.js';
import type { Logger, LogLevel } from '../logging/types.js';

function makeStubLogger(): Logger {
  const noop: any = () => {};
  const logger: any = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    withTag: () => logger,
    getChannelLevel: (): LogLevel => 'info',
    setChannelLevel: noop,
    onDidChangeChannelLevel: () => ({ dispose: noop }),
  };
  return logger as Logger;
}

function failingGit(): never {
  throw new Error('GitRunner.run should not be called in this test');
}
const stubGit = { run: failingGit, version: async () => null as string | null };

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.realpathSync(os.tmpdir()), prefix));
}

const EXPECTED_ENV =
  '#!/usr/bin/env bash\n' +
  '\n' +
  '# Auto-configured by Edge Studio\n' +
  'DITTO_APP_ID="abc-123"\n' +
  'DITTO_PLAYGROUND_TOKEN="tok-456"\n' +
  'DITTO_AUTH_URL="https://auth.example"\n' +
  'DITTO_WEBSOCKET_URL="wss://ws.example"';

test('writeEnvFiles writes root .env and per-project .env where parent exists', () => {
  const root = tmpdir('qs-env-');
  try {
    // Create flutter_app/ but NOT go-tui/
    fs.mkdirSync(path.join(root, 'flutter_app'));

    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const results = svc.writeEnvFiles(root, {
      databaseId: 'abc-123',
      token: 'tok-456',
      authUrl: 'https://auth.example',
      websocketUrl: 'wss://ws.example',
    });

    assert.equal(results.length, 3);
    const byPath = new Map(results.map((r) => [r.path, r]));

    // Root .env written
    const rootEnvPath = path.join(root, '.env');
    assert.equal(byPath.get(rootEnvPath)?.outcome, 'written');
    assert.equal(fs.readFileSync(rootEnvPath, 'utf-8'), EXPECTED_ENV);

    // flutter_app/.env written
    const flutterEnvPath = path.join(root, 'flutter_app', '.env');
    assert.equal(byPath.get(flutterEnvPath)?.outcome, 'written');
    assert.equal(fs.readFileSync(flutterEnvPath, 'utf-8'), EXPECTED_ENV);

    // go-tui/.env skipped — parent absent
    const goEnvPath = path.join(root, 'go-tui', '.env');
    assert.equal(byPath.get(goEnvPath)?.outcome, 'skipped-no-parent');
    assert.equal(fs.existsSync(goEnvPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeEnvFiles reports failed outcome and continues on write error', () => {
  const root = tmpdir('qs-env-fail-');
  try {
    // Create flutter_app/.env as a directory so the file write fails
    fs.mkdirSync(path.join(root, 'flutter_app'));
    fs.mkdirSync(path.join(root, 'flutter_app', '.env'));

    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const results = svc.writeEnvFiles(root, {
      databaseId: 'a', token: 'b', authUrl: 'c', websocketUrl: 'd',
    });

    const flutterResult = results.find((r) => r.path.endsWith(path.join('flutter_app', '.env')));
    assert.equal(flutterResult?.outcome, 'failed');

    // Root .env still got written
    const rootResult = results.find((r) => r.path === path.join(root, '.env'));
    assert.equal(rootResult?.outcome, 'written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: `ERR_MODULE_NOT_FOUND` for `../quickstart/QuickstartService.js`.

- [ ] **Step 3: Create the service with env writing**

Create `src/quickstart/QuickstartService.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logging/types.js';
import { ENV_DESTINATIONS } from './quickstart-projects.js';

/** Values written to each .env file. */
export interface EnvValues {
  databaseId: string;
  token: string;
  authUrl: string;
  /** May be empty for newer Portal configs — written as the empty string. */
  websocketUrl: string;
}

/** Values written to the edge-server YAML — same minus websocketUrl. */
export type EdgeServerValues = Omit<EnvValues, 'websocketUrl'>;

export type WriteResult =
  | { path: string; outcome: 'written' }
  | { path: string; outcome: 'skipped-no-parent' }
  | { path: string; outcome: 'failed'; error: string };

export type TargetInspection =
  | { kind: 'absent' }
  | { kind: 'git-checkout'; head: string }
  | { kind: 'non-git-folder' };

export type CloneMode = 'fresh-clone' | 'pull-existing' | 'replace-and-clone';

/**
 * Abstraction over git invocation. Default implementation uses Node's
 * `child_process.spawn` with argument-array form (no shell). Tests inject
 * a stub.
 */
export interface GitRunner {
  /** Returns the trimmed `git --version` output, or null if git is missing. */
  version(): Promise<string | null>;

  /**
   * Runs `git <args>` with optional cwd. `onStderr` receives each chunk
   * decoded as UTF-8 (git emits progress on stderr). The promise resolves
   * to the exit code. Reject only on inability to spawn at all.
   */
  run(
    args: string[],
    cwd: string | null,
    onStderr: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<number>;
}

export class QuickstartService {
  constructor(
    private readonly log: Logger,
    private readonly git: GitRunner,
  ) {}

  /**
   * Writes `.env` to every destination in ENV_DESTINATIONS, skipping any
   * whose parent directory does not exist. File bytes match SwiftUI's
   * `QuickstartDownloadService.configureEnvFiles` exactly — see design doc.
   */
  writeEnvFiles(repoRoot: string, values: EnvValues): WriteResult[] {
    const content = renderEnvContent(values);
    return ENV_DESTINATIONS.map((rel) => this.writeOne(repoRoot, rel, content));
  }

  private writeOne(repoRoot: string, relativePath: string, content: string): WriteResult {
    const fullPath = path.join(repoRoot, relativePath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      this.log.info('Quickstart: skipping .env, parent missing', { path: fullPath });
      return { path: fullPath, outcome: 'skipped-no-parent' };
    }
    try {
      fs.writeFileSync(fullPath, content, { encoding: 'utf-8' });
      this.log.info('Quickstart: wrote .env', { path: fullPath });
      return { path: fullPath, outcome: 'written' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.warn('Quickstart: .env write failed', { path: fullPath, error });
      return { path: fullPath, outcome: 'failed', error };
    }
  }
}

/**
 * Byte-exact reproduction of SwiftUI's envContent — no trailing newline,
 * single comment line credited to "Edge Studio" (the product name shared
 * by SwiftUI and VS Code editions).
 */
function renderEnvContent(v: EnvValues): string {
  return [
    '#!/usr/bin/env bash',
    '',
    '# Auto-configured by Edge Studio',
    `DITTO_APP_ID="${v.databaseId}"`,
    `DITTO_PLAYGROUND_TOKEN="${v.token}"`,
    `DITTO_AUTH_URL="${v.authUrl}"`,
    `DITTO_WEBSOCKET_URL="${v.websocketUrl}"`,
  ].join('\n');
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 2 tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/quickstart/QuickstartService.ts src/test/QuickstartService.test.ts
git commit -m "feat(quickstart): add QuickstartService with env file writing

Service skeleton plus writeEnvFiles. Content bytes match SwiftUI's
QuickstartDownloadService.configureEnvFiles exactly. Per-destination
WriteResult lets the caller surface partial-success state to users.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: QuickstartService — writeEdgeServerYaml

**Files:**
- Modify: `src/quickstart/QuickstartService.ts`
- Modify: `src/test/QuickstartService.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/test/QuickstartService.test.ts`:

```ts
const EXPECTED_YAML =
  'resources:\n' +
  '  my_ditto_db:\n' +
  '    resource_type: DittoDatabase\n' +
  '    db_id: "abc-123"\n' +
  '    device_name: "edge-studio-quickstart"\n' +
  '    subscriptions:\n' +
  '      - "SELECT * FROM tasks"\n' +
  '    auth:\n' +
  '      server:\n' +
  '        access_token: "tok-456"\n' +
  '        auth_url: "https://auth.example"\n' +
  '        provider: "__playgroundProvider"\n' +
  '  my_http_server:\n' +
  '    resource_type: HttpServer\n' +
  '    listen_addr: "0.0.0.0:8080"\n' +
  '    databases:\n' +
  '      my_db:\n' +
  '        db_id: "abc-123"\n' +
  '        base_path: my_server\n' +
  '        http_api: true';

test('writeEdgeServerYaml writes config when edge-server/ exists', () => {
  const root = tmpdir('qs-yaml-');
  try {
    fs.mkdirSync(path.join(root, 'edge-server'));
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = svc.writeEdgeServerYaml(root, {
      databaseId: 'abc-123', token: 'tok-456', authUrl: 'https://auth.example',
    });
    assert.equal(result.outcome, 'written');
    const written = fs.readFileSync(path.join(root, 'edge-server', 'quickstart_config.yaml'), 'utf-8');
    assert.equal(written, EXPECTED_YAML);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeEdgeServerYaml skips when edge-server/ is absent', () => {
  const root = tmpdir('qs-yaml-absent-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = svc.writeEdgeServerYaml(root, {
      databaseId: 'a', token: 'b', authUrl: 'c',
    });
    assert.equal(result.outcome, 'skipped-no-parent');
    assert.equal(fs.existsSync(path.join(root, 'edge-server', 'quickstart_config.yaml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, verify the new tests fail**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 2 new tests fail with `TypeError: svc.writeEdgeServerYaml is not a function`.

- [ ] **Step 3: Implement writeEdgeServerYaml**

Modify `src/quickstart/QuickstartService.ts`:

Add to imports at the top:

```ts
import { ENV_DESTINATIONS, EDGE_SERVER_RELATIVE_DIR, EDGE_SERVER_YAML_NAME } from './quickstart-projects.js';
```

(Replace the existing `ENV_DESTINATIONS`-only import.)

Add this method inside the `QuickstartService` class, after `writeEnvFiles`:

```ts
  /**
   * Writes `edge-server/quickstart_config.yaml` when the edge-server
   * directory exists in the cloned repo. Content matches SwiftUI's
   * QuickstartDownloadService.configureEdgeServerYaml exactly.
   */
  writeEdgeServerYaml(repoRoot: string, values: EdgeServerValues): WriteResult {
    const dir = path.join(repoRoot, EDGE_SERVER_RELATIVE_DIR);
    const fullPath = path.join(dir, EDGE_SERVER_YAML_NAME);
    if (!fs.existsSync(dir)) {
      this.log.info('Quickstart: skipping edge-server YAML, dir missing', { dir });
      return { path: fullPath, outcome: 'skipped-no-parent' };
    }
    try {
      fs.writeFileSync(fullPath, renderEdgeServerYaml(values), { encoding: 'utf-8' });
      this.log.info('Quickstart: wrote edge-server YAML', { path: fullPath });
      return { path: fullPath, outcome: 'written' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.warn('Quickstart: edge-server YAML write failed', { path: fullPath, error });
      return { path: fullPath, outcome: 'failed', error };
    }
  }
```

Add this helper at the bottom of the file, after `renderEnvContent`:

```ts
function renderEdgeServerYaml(v: EdgeServerValues): string {
  return [
    'resources:',
    '  my_ditto_db:',
    '    resource_type: DittoDatabase',
    `    db_id: "${v.databaseId}"`,
    '    device_name: "edge-studio-quickstart"',
    '    subscriptions:',
    '      - "SELECT * FROM tasks"',
    '    auth:',
    '      server:',
    `        access_token: "${v.token}"`,
    `        auth_url: "${v.authUrl}"`,
    '        provider: "__playgroundProvider"',
    '  my_http_server:',
    '    resource_type: HttpServer',
    '    listen_addr: "0.0.0.0:8080"',
    '    databases:',
    '      my_db:',
    `        db_id: "${v.databaseId}"`,
    '        base_path: my_server',
    '        http_api: true',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/quickstart/QuickstartService.ts src/test/QuickstartService.test.ts
git commit -m "feat(quickstart): write edge-server YAML when present

Matches SwiftUI configureEdgeServerYaml byte-for-byte. Skipped when the
edge-server/ subdirectory is absent in the cloned repo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: QuickstartService — inspectTarget

**Files:**
- Modify: `src/quickstart/QuickstartService.ts`
- Modify: `src/test/QuickstartService.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/test/QuickstartService.test.ts`:

```ts
test('inspectTarget — absent', async () => {
  const root = tmpdir('qs-inspect-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(path.join(root, 'quickstart'));
    assert.equal(result.kind, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — non-git folder', async () => {
  const root = tmpdir('qs-inspect-nongit-');
  try {
    fs.mkdirSync(path.join(root, 'quickstart'));
    fs.writeFileSync(path.join(root, 'quickstart', 'README.md'), 'mine');
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(path.join(root, 'quickstart'));
    assert.equal(result.kind, 'non-git-folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — git checkout reports head sha', async () => {
  const root = tmpdir('qs-inspect-git-');
  try {
    const target = path.join(root, 'quickstart');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    fs.writeFileSync(path.join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    // Simulate a git ls-files via the GitRunner stub
    const gitStub: GitRunner = {
      version: async () => 'git version 2.45.0',
      run: async (args, cwd) => {
        assert.deepEqual(args, ['rev-parse', 'HEAD']);
        assert.equal(cwd, target);
        return 0;
      },
    };
    // Need to capture stdout — extend GitRunner.run to support stdout capture.
    // For this test we accept that 'head' may be 'unknown' if the stub doesn't
    // emit stdout; assert kind only.
    const svc = new QuickstartService(makeStubLogger(), gitStub);
    const result = await svc.inspectTarget(target);
    assert.equal(result.kind, 'git-checkout');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

Also add `import type { GitRunner } from '../quickstart/QuickstartService.js';` to the test file imports if not present (the `GitRunner` type is referenced inline).

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 3 new tests fail (`TypeError: svc.inspectTarget is not a function`).

- [ ] **Step 3: Implement inspectTarget**

Add to `src/quickstart/QuickstartService.ts` inside the class, after `writeEdgeServerYaml`:

```ts
  /**
   * Classify a would-be clone target. We detect a `.git` directory inline
   * (no git invocation needed) and only mark the directory as "git-checkout"
   * when that marker exists. Returns 'non-git-folder' for anything else —
   * the flow controller treats this as the dangerous case and prompts.
   */
  async inspectTarget(targetDir: string): Promise<TargetInspection> {
    if (!fs.existsSync(targetDir)) {
      return { kind: 'absent' };
    }
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return { kind: 'non-git-folder' };
    }
    const dotGit = path.join(targetDir, '.git');
    if (!fs.existsSync(dotGit)) {
      return { kind: 'non-git-folder' };
    }
    // Best-effort head sha — useful for the dialog text. Failure isn't fatal.
    let head = 'unknown';
    try {
      const headFile = path.join(dotGit, 'HEAD');
      if (fs.existsSync(headFile)) {
        head = fs.readFileSync(headFile, 'utf-8').trim();
      }
    } catch {
      /* leave as 'unknown' */
    }
    return { kind: 'git-checkout', head };
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/quickstart/QuickstartService.ts src/test/QuickstartService.test.ts
git commit -m "feat(quickstart): inspectTarget classifies clone destinations

Three return shapes (absent / git-checkout / non-git-folder) so the flow
controller can distinguish safe pull from dangerous overwrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: QuickstartService — isGitAvailable

**Files:**
- Modify: `src/quickstart/QuickstartService.ts`
- Modify: `src/test/QuickstartService.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `src/test/QuickstartService.test.ts`:

```ts
test('isGitAvailable — returns true when GitRunner.version resolves to a string', async () => {
  const gitStub: GitRunner = {
    version: async () => 'git version 2.45.0',
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), true);
});

test('isGitAvailable — returns false when GitRunner.version resolves to null', async () => {
  const gitStub: GitRunner = {
    version: async () => null,
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), false);
});

test('isGitAvailable — returns false when GitRunner.version throws', async () => {
  const gitStub: GitRunner = {
    version: async () => { throw new Error('ENOENT'); },
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 3 new tests fail with `svc.isGitAvailable is not a function`.

- [ ] **Step 3: Implement isGitAvailable**

Add inside the `QuickstartService` class, after `inspectTarget`:

```ts
  async isGitAvailable(): Promise<boolean> {
    try {
      const v = await this.git.version();
      return v !== null && v.length > 0;
    } catch (err) {
      this.log.warn('Quickstart: git version probe failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/quickstart/QuickstartService.ts src/test/QuickstartService.test.ts
git commit -m "feat(quickstart): isGitAvailable pre-flight check

Used by the flow controller to refuse early when git is not on PATH.
Treats both null version and thrown errors as 'not available'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: QuickstartService — cloneOrPull

**Files:**
- Modify: `src/quickstart/QuickstartService.ts`
- Modify: `src/test/QuickstartService.test.ts`

This task implements all three `CloneMode` values (`fresh-clone`, `pull-existing`, `replace-and-clone`) and cancellation. Each mode gets its own test cycle.

- [ ] **Step 1: Add a recording GitRunner helper to the test file**

Append to `src/test/QuickstartService.test.ts`:

```ts
interface RecordedCall {
  args: string[];
  cwd: string | null;
}

function recordingGit(exitCode = 0): { git: GitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const git: GitRunner = {
    version: async () => 'git version 2.45.0',
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      return exitCode;
    },
  };
  return { git, calls };
}
```

- [ ] **Step 2: Write the failing test for fresh-clone mode**

Append:

```ts
import { QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME } from '../quickstart/quickstart-projects.js';

test('cloneOrPull fresh-clone runs `git clone` into the parent dir', async () => {
  const parent = tmpdir('qs-clone-');
  try {
    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'fresh-clone', () => {}, ac.signal);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME]);
    assert.equal(calls[0].cwd, parent);
    assert.equal(result.repoRoot, path.join(parent, QUICKSTART_FOLDER_NAME));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run, verify failure**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: `svc.cloneOrPull is not a function`.

- [ ] **Step 4: Implement cloneOrPull (fresh-clone only)**

Add inside the `QuickstartService` class, after `isGitAvailable`:

```ts
  async cloneOrPull(
    parentDir: string,
    mode: CloneMode,
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<{ repoRoot: string }> {
    const repoRoot = path.join(parentDir, QUICKSTART_FOLDER_NAME);
    const onStderr = (chunk: string) => {
      // Git progress arrives on stderr (e.g. "Receiving objects: 12% …").
      // Forward the last non-empty line as a status string.
      const last = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0).pop();
      if (last) { onProgress(last.trim()); }
    };

    if (mode === 'fresh-clone') {
      const exit = await this.git.run(
        ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME],
        parentDir,
        onStderr,
        signal,
      );
      if (exit !== 0) { throw new Error(`git clone failed with exit ${exit}`); }
      return { repoRoot };
    }

    throw new Error(`cloneOrPull mode not implemented: ${mode}`);
  }
```

Add the import at the top:

```ts
import {
  ENV_DESTINATIONS,
  EDGE_SERVER_RELATIVE_DIR,
  EDGE_SERVER_YAML_NAME,
  QUICKSTART_REPO_URL,
  QUICKSTART_FOLDER_NAME,
} from './quickstart-projects.js';
```

(Replace the existing import to add the two new symbols.)

- [ ] **Step 5: Run, verify fresh-clone test passes**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 11 tests pass.

- [ ] **Step 6: Write the failing test for pull-existing mode**

Append:

```ts
test('cloneOrPull pull-existing runs `git pull` inside the existing checkout', async () => {
  const parent = tmpdir('qs-pull-');
  try {
    fs.mkdirSync(path.join(parent, QUICKSTART_FOLDER_NAME, '.git'), { recursive: true });
    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'pull-existing', () => {}, ac.signal);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['pull', '--ff-only']);
    assert.equal(calls[0].cwd, path.join(parent, QUICKSTART_FOLDER_NAME));
    assert.equal(result.repoRoot, path.join(parent, QUICKSTART_FOLDER_NAME));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 7: Run, verify failure**

Expected: `cloneOrPull mode not implemented: pull-existing`.

- [ ] **Step 8: Extend cloneOrPull for pull-existing**

Replace the `throw new Error(\`cloneOrPull mode not implemented: …\`);` at the bottom of `cloneOrPull` with:

```ts
    if (mode === 'pull-existing') {
      const exit = await this.git.run(['pull', '--ff-only'], repoRoot, onStderr, signal);
      if (exit !== 0) {
        throw new Error(
          `git pull failed with exit ${exit}. The local checkout may be dirty or diverged — ` +
          `choose Replace from the prompt next time to reset.`,
        );
      }
      return { repoRoot };
    }

    if (mode === 'replace-and-clone') {
      onProgress('Removing existing folder…');
      fs.rmSync(repoRoot, { recursive: true, force: true });
      const exit = await this.git.run(
        ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME],
        parentDir,
        onStderr,
        signal,
      );
      if (exit !== 0) { throw new Error(`git clone failed with exit ${exit}`); }
      return { repoRoot };
    }

    throw new Error(`cloneOrPull mode not implemented: ${String(mode)}`);
```

- [ ] **Step 9: Run, verify pull-existing test passes**

Expected: 12 tests pass.

- [ ] **Step 10: Write the failing test for replace-and-clone**

Append:

```ts
test('cloneOrPull replace-and-clone removes existing folder then clones', async () => {
  const parent = tmpdir('qs-replace-');
  try {
    const target = path.join(parent, QUICKSTART_FOLDER_NAME);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'stale.txt'), 'stale');

    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'replace-and-clone', () => {}, ac.signal);

    // Stale file gone before clone ran
    assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME]);
    assert.equal(result.repoRoot, target);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull throws on non-zero git exit', async () => {
  const parent = tmpdir('qs-clone-fail-');
  try {
    const { git } = recordingGit(128);
    const svc = new QuickstartService(makeStubLogger(), git);
    await assert.rejects(
      () => svc.cloneOrPull(parent, 'fresh-clone', () => {}, new AbortController().signal),
      /git clone failed with exit 128/,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 11: Run, verify both tests pass**

Run: `node --import tsx --test src/test/QuickstartService.test.ts`

Expected: 14 tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/quickstart/QuickstartService.ts src/test/QuickstartService.test.ts
git commit -m "feat(quickstart): cloneOrPull with three modes and progress reporting

fresh-clone runs git clone, pull-existing runs ff-only pull inside the
checkout, replace-and-clone rms the folder before cloning. Stderr is
parsed line-by-line and the last non-empty line surfaces as progress.
Non-zero exit codes throw with an actionable message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: NodeGitRunner — real subprocess implementation

**Files:**
- Modify: `src/quickstart/QuickstartService.ts` (export factory)

No new tests — this glue is exercised end-to-end via manual verification. Unit-testing real spawn calls would require an actual git binary and network.

- [ ] **Step 1: Add the NodeGitRunner factory**

Append to `src/quickstart/QuickstartService.ts`:

```ts
import { spawn } from 'node:child_process';

/**
 * Default {@link GitRunner} backed by Node's child_process.spawn. Uses the
 * argument-array form with no shell — injection-safe by construction.
 * Wires an AbortSignal to kill the subprocess on cancellation.
 */
export function createNodeGitRunner(): GitRunner {
  return {
    async version(): Promise<string | null> {
      return new Promise((resolve) => {
        try {
          const child = spawn('git', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout?.on('data', (b) => { out += b.toString('utf-8'); });
          child.on('error', () => resolve(null));
          child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
        } catch {
          resolve(null);
        }
      });
    },
    run(args, cwd, onStderr, signal): Promise<number> {
      return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
          cwd: cwd ?? undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal,
        });
        child.stderr?.on('data', (b) => onStderr(b.toString('utf-8')));
        child.on('error', (err) => {
          // AbortError surfaces here when the signal is fired.
          reject(err);
        });
        child.on('close', (code) => resolve(code ?? -1));
      });
    },
  };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`

Expected: `TypeScript: No errors found`.

- [ ] **Step 3: Commit**

```bash
git add src/quickstart/QuickstartService.ts
git commit -m "feat(quickstart): NodeGitRunner default backed by spawn

Args-array, no shell, AbortSignal-aware. Exported factory so the
flow controller composes it; tests keep their stub runner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Flow controller + command registration in extension.ts

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Inspect extension.ts for the command registration block**

Run: `grep -n "registerCommand\|HelpTreeProvider\|createOutputChannel" src/extension.ts`

Note the line number of `vscode.commands.registerCommand('dittoVsce.openWelcome'`. The new command will be registered immediately after that (and inside the same `context.subscriptions.push(...)` block if one exists).

- [ ] **Step 2: Add imports**

At the top of `src/extension.ts`, alongside the other relative imports, add:

```ts
import * as path from 'path';
import { QuickstartService, createNodeGitRunner } from './quickstart/QuickstartService.js';
import type { EnvValues, CloneMode } from './quickstart/QuickstartService.js';
import { QUICKSTART_FOLDER_NAME } from './quickstart/quickstart-projects.js';
```

(`path` may already be imported — skip the duplicate if so.)

- [ ] **Step 3: Add the command registration and handler**

Find the existing `vscode.commands.registerCommand('dittoVsce.openWelcome', …)` block. Immediately after it, add:

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('dittoVsce.getQuickstarts', async () => {
    const log = logger.withTag('ext:quickstart');
    const service = new QuickstartService(log, createNodeGitRunner());

    // 1. Pre-flight: git on PATH?
    if (!(await service.isGitAvailable())) {
      const pick = await vscode.window.showErrorMessage(
        'Git is required for Get Quickstarts. Install git and try again.',
        'Open install docs',
      );
      if (pick === 'Open install docs') {
        vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/downloads'));
      }
      return;
    }

    // 2. Snapshot active connection values (or null for code-only).
    const activeId = manager.getActiveConfigId();
    let values: EnvValues | null = null;
    if (activeId) {
      const cfg = configs.get(activeId);
      const sec = await secrets.read(activeId);
      if (cfg) {
        values = {
          databaseId: cfg.databaseId,
          token: sec.token,
          authUrl: cfg.authUrl,
          websocketUrl: cfg.websocketUrl ?? '',
        };
      }
    }
    if (!values) {
      const pick = await vscode.window.showWarningMessage(
        'No active connection — .env files will not be configured. Continue with code-only download?',
        { modal: true },
        'Continue',
      );
      if (pick !== 'Continue') { return; }
    }

    // 3. Parent folder picker.
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select parent folder for quickstart',
    });
    if (!picked || picked.length === 0) { return; }
    const parentDir = picked[0].fsPath;
    const targetDir = path.join(parentDir, QUICKSTART_FOLDER_NAME);

    // 4. Inspect target, prompt if needed.
    const inspection = await service.inspectTarget(targetDir);
    let mode: CloneMode = 'fresh-clone';
    if (inspection.kind === 'git-checkout') {
      const pick = await vscode.window.showInformationMessage(
        `A quickstart checkout already exists at ${targetDir}.`,
        { modal: true },
        'Pull latest', 'Replace',
      );
      if (pick === 'Pull latest') { mode = 'pull-existing'; }
      else if (pick === 'Replace') { mode = 'replace-and-clone'; }
      else { return; }
    } else if (inspection.kind === 'non-git-folder') {
      const pick = await vscode.window.showWarningMessage(
        `A non-git folder named 'quickstart' exists at ${targetDir}. Replace it?`,
        { modal: true },
        'Replace',
      );
      if (pick !== 'Replace') { return; }
      mode = 'replace-and-clone';
    }

    // 5. Progress notification + the actual work.
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Setting up Quickstarts', cancellable: true },
        async (progress, token) => {
          const ac = new AbortController();
          token.onCancellationRequested(() => ac.abort());

          progress.report({ message: mode === 'pull-existing' ? 'Updating clone…' : 'Cloning…' });
          const { repoRoot } = await service.cloneOrPull(
            parentDir,
            mode,
            (m) => progress.report({ message: m }),
            ac.signal,
          );

          if (values) {
            progress.report({ message: 'Writing .env files…' });
            const envResults = service.writeEnvFiles(repoRoot, values);
            progress.report({ message: 'Writing edge-server config…' });
            const yamlResult = service.writeEdgeServerYaml(repoRoot, {
              databaseId: values.databaseId,
              token: values.token,
              authUrl: values.authUrl,
            });
            return { repoRoot, envResults, yamlResult };
          }
          return { repoRoot, envResults: [], yamlResult: null };
        },
      );

      // 6. Success notification with summary.
      const writtenCount = result.envResults.filter((r) => r.outcome === 'written').length
        + (result.yamlResult?.outcome === 'written' ? 1 : 0);
      const msg = values
        ? `Quickstarts ready at ${result.repoRoot}. Configured ${writtenCount} config file(s).`
        : `Quickstarts cloned at ${result.repoRoot}. Open a connection and re-run to configure .env files.`;
      const pick = await vscode.window.showInformationMessage(msg, 'Open Folder', 'Show Log');
      if (pick === 'Open Folder') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(result.repoRoot));
      } else if (pick === 'Show Log') {
        logger.show();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Get Quickstarts failed', { err: msg });
      // Clean up partial fresh/replace clone on failure (best effort).
      if (mode !== 'pull-existing') {
        try { (await import('fs')).rmSync(targetDir, { recursive: true, force: true }); }
        catch { /* ignore cleanup failures */ }
      }
      vscode.window.showErrorMessage(`Get Quickstarts failed: ${msg}`, 'Show Log').then((pick) => {
        if (pick === 'Show Log') { logger.show(); }
      });
    }
  }),
);
```

(Substitute the actual variable names — `logger`, `manager`, `configs`, `secrets` — used in `activate()`; double-check by grepping for `getActiveConfigId` and using the same names that appear in nearby `registerCommand` blocks.)

- [ ] **Step 4: Add the command contribution to package.json**

In `package.json`, find the `"contributes": { "commands": [ … ] }` array. Add a new entry alphabetically near the other `dittoVsce.*` entries:

```json
{
  "command": "dittoVsce.getQuickstarts",
  "title": "Ditto: Get Quickstarts…",
  "category": "Ditto"
}
```

- [ ] **Step 5: Verify typecheck and build**

Run: `npx tsc --noEmit && npm run build`

Expected: `TypeScript: No errors found` followed by `[esbuild] build finished.`

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(quickstart): register dittoVsce.getQuickstarts command + flow

Glues QuickstartService to the VS Code dialog/progress APIs. Snapshot
active connection at command start, prompt before touching existing
folders, run withProgress(Notification) for clone + writes, surface
results with Open Folder / Show Log actions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Help tree action

**Files:**
- Modify: `src/tree/HelpTreeProvider.ts`

- [ ] **Step 1: Add the new action row**

Modify the `ITEMS` array in `src/tree/HelpTreeProvider.ts`. Insert a new entry just after the `'Welcome to Ditto'` action and before `"What's New"`:

```ts
  { kind: 'action', label: 'Get Quickstarts',       icon: 'cloud-download', command: 'dittoVsce.getQuickstarts' },
```

The existing `'Quickstart Repos'` link row stays — it serves a different purpose (browse GitHub).

- [ ] **Step 2: Verify typecheck and existing tests still pass**

Run: `npx tsc --noEmit && npm test`

Expected: typecheck clean; all 31 file-tests still pass.

- [ ] **Step 3: Commit**

```bash
git add src/tree/HelpTreeProvider.ts
git commit -m "feat(quickstart): add 'Get Quickstarts' to the Help tree

Sits above the existing 'Quickstart Repos' link, which stays — the
link browses upstream, the action clones and configures locally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Welcome screen card + IPC message

**Files:**
- Modify: `src/ipc/messages.ts`
- Modify: `src/panels/WelcomePanel.ts`
- Modify: `webview-ui/welcome/welcome-element.ts`

- [ ] **Step 1: Add the IPC message type**

In `src/ipc/messages.ts`, find the existing welcome-related types and add `welcome.getQuickstarts`. Locate this block:

```ts
| { type: 'welcome.registerDatabase' }
| { type: 'welcome.close' };
```

Replace with:

```ts
| { type: 'welcome.registerDatabase' }
| { type: 'welcome.getQuickstarts' }
| { type: 'welcome.close' };
```

- [ ] **Step 2: Handle the new message in the panel**

In `src/panels/WelcomePanel.ts`, find the `switch` block that handles `welcome.registerDatabase` / `welcome.close`. Add a new case:

```ts
case 'welcome.getQuickstarts':
  vscode.commands.executeCommand('dittoVsce.getQuickstarts');
  return;
```

- [ ] **Step 3: Add the new card to the welcome webview**

In `webview-ui/welcome/welcome-element.ts`, find the section that renders the existing cards. Add a new card after the last onboarding card. Use the existing card markup pattern (inspect the file for the exact class names — they may be `card`, `welcome-card`, etc.). Inline the card with this content:

```html
<section class="card">
  <div class="card-icon"><i class="codicon codicon-cloud-download"></i></div>
  <h2>Try a quickstart in your favorite language</h2>
  <p>
    Edge Studio can clone Ditto's official quickstart projects (Swift, Kotlin,
    Flutter, Rust, .NET, JavaScript, and 11 more) onto your machine and pre-fill
    the <code>.env</code> files using whichever connection is currently active.
    New to Ditto? This is the fastest way to see sync working end-to-end.
  </p>
  <div class="card-actions">
    <button class="primary" @click=${() => this.onGetQuickstarts()}>Get Quickstarts</button>
    <a href="https://github.com/getditto/quickstart" target="_blank" rel="noopener">Browse on GitHub</a>
  </div>
</section>
```

Then add a method to the same Lit element class:

```ts
private onGetQuickstarts() {
  postToHost({ type: 'welcome.getQuickstarts' });
}
```

If the exact class names in the existing welcome-element.ts differ from `card` / `card-actions` / `primary`, use whatever the existing register-database card uses — copy that card's structure and substitute the text + handler.

- [ ] **Step 4: Verify typecheck and build**

Run: `npx tsc --noEmit && npm run build`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/ipc/messages.ts src/panels/WelcomePanel.ts webview-ui/welcome/welcome-element.ts
git commit -m "feat(quickstart): welcome card with Get Quickstarts button

New card mirrors the SwiftUI Help-menu entry point. IPC message
flows through WelcomePanel to executeCommand('dittoVsce.getQuickstarts').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: README + Developer docs

**Files:**
- Modify: `README.md`
- Modify: `docs/Developer.md`

- [ ] **Step 1: Add a Quickstarts subsection to README.md**

In `README.md`, locate the "Features" section. Append this subsection (preserve the existing heading levels — match whatever h2/h3 the surrounding features use):

```markdown
### Get Quickstarts

One click clones the official [Ditto quickstart repo](https://github.com/getditto/quickstart)
into a folder you choose and pre-fills `.env` files for every quickstart project
(plus the Edge Server YAML) using the Database ID, Development Token, and URLs
from your currently active connection. If no connection is active, the command
offers a code-only download — open a connection and re-run to configure the
`.env` files later.

Available from:

- **Help** tree → **Get Quickstarts**
- The **Welcome** view → **Get Quickstarts** card
- Command Palette → **Ditto: Get Quickstarts…**

Requires `git` on your PATH.
```

- [ ] **Step 2: Add a Quickstarts feature section to docs/Developer.md**

Append to `docs/Developer.md`:

```markdown
## Get Quickstarts feature

The implementation lives in `src/quickstart/`:

- `quickstart-projects.ts` is the single source of truth for what we know
  about the upstream `getditto/quickstart` repo: the project list, the three
  hard-coded `.env` destinations (root, `flutter_app/`, `go-tui/`), and the
  edge-server YAML path. Update this file when upstream restructures or
  adds a new per-project `.env` destination. Mirrors SwiftUI Edge Studio's
  `QuickstartDownloadService.swift` — keep the two lists in sync.

- `QuickstartService.ts` does git ops via an injected `GitRunner`. The
  default `createNodeGitRunner()` is backed by `child_process.spawn` using
  the argument-array form (no shell). Tests inject a stub `GitRunner` so
  the suite never spawns a real subprocess.

- The flow controller is the `dittoVsce.getQuickstarts` registration in
  `src/extension.ts`. It owns the dialog tree and the `withProgress`
  notification; the service stays UI-free.

### Why we emit `DITTO_APP_ID` and `DITTO_PLAYGROUND_TOKEN`

The upstream quickstart code still reads the old env-var names even after
Edge Studio's UI rename to "Database ID" / "Development Token". A file
using the new names would not be loaded by any quickstart project. When
upstream renames, update the template in `QuickstartService.ts:renderEnvContent`
and bump the comment.

### Future iteration: auto-discovery

If the hard-coded list of `.env` destinations stops scaling (e.g. upstream
adds many new per-project envs at once), switch the resolution to scan for
every `.env.sample` in the cloned tree and write a sibling `.env` next to
each one. The single `renderEnvContent` template plus the destination
list are the only things that need to change — the rest of the service
keeps the same shape.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/Developer.md
git commit -m "docs: README and Developer notes for Get Quickstarts

User-facing README subsection covers the three entry points and the
git requirement. Developer.md captures the rationale for the
hard-coded list, the env-var-name divergence from in-extension
terminology, and the auto-discovery upgrade path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Manual verification + final typecheck

**Files:** none modified.

- [ ] **Step 1: Final typecheck + full test suite + build**

Run:

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: typecheck clean, all file-tests pass, esbuild finishes.

- [ ] **Step 2: Launch the Extension Development Host**

In VS Code with the repo open, press **F5** (or run the "Run Extension" launch config). Then in the Extension Development Host:

1. Open the Help tree in the Ditto activity bar — confirm **Get Quickstarts** appears between "Welcome to Ditto" and "What's New".
2. Open the Welcome panel (Help tree → Welcome, or Command Palette → "Ditto: Open Welcome") — confirm the new card with the **Get Quickstarts** button is visible.
3. Run **Command Palette → Ditto: Get Quickstarts…** — confirm the command is listed.

- [ ] **Step 3: Smoke-test the happy path**

In the Dev Host:

1. Register a connection if you have none. Connect to it.
2. Run **Get Quickstarts**.
3. Pick an empty parent folder (e.g. `~/tmp/qs/`).
4. Watch the progress notification stream `git clone --progress` output.
5. When the success notification appears, click **Open Folder** — confirm `<parent>/quickstart/` exists, contains the repo, and contains `.env` at root + `flutter_app/.env` + `go-tui/.env` + `edge-server/quickstart_config.yaml` with your active connection's values.

- [ ] **Step 4: Smoke-test the no-connection path**

In the Dev Host, disconnect from the active connection (Databases tree → connected entry → Disconnect). Run **Get Quickstarts**. Expected:

- Warning modal: "No active connection — .env files will not be configured. Continue with code-only download?"
- Click **Continue**. Pick a folder.
- Success notification says "Quickstarts cloned at … Open a connection and re-run to configure .env files."
- Verify no `.env` files exist inside the cloned tree.

- [ ] **Step 5: Smoke-test the existing-folder paths**

Run **Get Quickstarts** again pointing at the same parent folder used in step 3. Expected:

- Info modal: "A quickstart checkout already exists at …" with **Pull latest** and **Replace** buttons.
- Click **Pull latest** — progress shows `git pull` output, success notification appears, files are still in place.
- Run a third time, click **Replace** — folder is recreated and re-cloned.

- [ ] **Step 6: Smoke-test the non-git folder case**

In a terminal, `mkdir ~/tmp/qs2/quickstart && touch ~/tmp/qs2/quickstart/mine.txt`. In the Dev Host, run **Get Quickstarts** and pick `~/tmp/qs2/`. Expected:

- Warning modal: "A non-git folder named 'quickstart' exists at …. Replace it?"
- Cancel → flow exits, `mine.txt` still present.
- Re-run, click **Replace** → folder is recreated; `mine.txt` is gone.

- [ ] **Step 7: Smoke-test the git-missing path**

Temporarily move git off PATH (e.g. open a new terminal with `PATH=/usr/local/bin VS Code …` if your shell uses `/usr/local/bin/git`, or rename your git binary briefly). In the Dev Host, run **Get Quickstarts**. Expected:

- Error notification: "Git is required for Get Quickstarts. Install git and try again." with **Open install docs** action.
- Clicking the action opens `https://git-scm.com/downloads` in the system browser.

Restore PATH / git binary when done.

- [ ] **Step 8: Push the branch and open a PR**

After all smoke-tests pass:

```bash
git push -u origin auto-git-quickstarts
gh pr create --title "feat: Get Quickstarts — clone repo and auto-config .env files" --body "$(cat <<'EOF'
## Summary

- New **Get Quickstarts** command (`dittoVsce.getQuickstarts`) clones `getditto/quickstart` and writes `.env` files at root, `flutter_app/`, `go-tui/` plus `edge-server/quickstart_config.yaml` using the active connection.
- Reachable from Help tree, Welcome card, and Command Palette.
- `git` clone-based with three modes (fresh / pull / replace), always prompts before touching an existing folder.
- If no active connection, warns and offers code-only download.

Mirrors the SwiftUI Edge Studio Help-menu feature; design doc at `docs/specs/2026-05-20-get-quickstarts-design.md`.

## Test plan

- [ ] `npx tsc --noEmit` and `npm test` clean
- [ ] Help tree shows **Get Quickstarts**
- [ ] Welcome card shows **Get Quickstarts** button
- [ ] Command Palette finds **Ditto: Get Quickstarts…**
- [ ] Happy path: fresh clone + .env writes
- [ ] No-connection path: warn + clone-only
- [ ] Existing-folder paths: pull / replace / cancel
- [ ] Non-git folder: warn + replace / cancel
- [ ] Git-missing path: error + install docs link

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

**Spec coverage:** Verified each section of `docs/specs/2026-05-20-get-quickstarts-design.md` maps to a task:

| Spec section | Implementing task(s) |
| --- | --- |
| Decisions captured | Drives Tasks 8 (flow controller behavior), 6 (modes), 4 (target inspection) |
| Architecture — new files | Tasks 1 (constants), 2–7 (service), 8 (flow controller test coverage via manual verify) |
| Architecture — modified files | Tasks 8 (extension.ts, package.json), 9 (HelpTreeProvider), 10 (IPC, WelcomePanel, welcome-element), 11 (README, Developer.md) |
| QuickstartService API | Tasks 2 (writeEnvFiles), 3 (writeEdgeServerYaml), 4 (inspectTarget), 5 (isGitAvailable), 6 (cloneOrPull), 7 (NodeGitRunner) |
| Subprocess invocation pattern | Task 7 (NodeGitRunner uses `spawn(cmd, args, opts)` — no shell) |
| Flow controller pseudocode | Task 8, full implementation |
| Content specs | Tasks 2 (env template), 3 (YAML template) — byte-exact tests |
| Error handling | Task 8 (git-missing pre-flight, partial-folder cleanup, error notification) + Tasks 2/3 (per-file failure outcome) + Task 6 (non-zero exit throws) |
| Welcome card | Task 10 |
| Documentation | Task 11 |
| Testing | Tasks 1–6 (unit tests), Task 12 (manual smoke tests) |
| Out of scope / Risks | Captured in Task 11's Developer.md section |

**Placeholder scan:** No "TBD" / "TODO" / "fill in later" / "similar to Task N" patterns. Every code-touching step contains the literal code to write or insert.

**Type consistency:** `QuickstartService` constructor signature `(log, git)` matches across Tasks 2, 3, 4, 5, 6, 7, 8. `EnvValues` shape unchanged from definition (Task 2) through use (Task 8). `CloneMode` values `'fresh-clone' | 'pull-existing' | 'replace-and-clone'` consistent across Tasks 6 and 8. `WriteResult` discriminator names `'written' | 'skipped-no-parent' | 'failed'` consistent across all uses. `GitRunner` shape (`version()`, `run(args, cwd, onStderr, signal)`) unchanged across Tasks 2–8.

**Spec-text divergences I want to call out:**
- Spec said "`git clone --depth 1`" was a possibility in the subprocess example; the plan uses full `git clone --progress` (no `--depth`) so `git pull` works on the resulting checkout. Spec is consistent with this — shallow clones can't always pull cleanly.
- Spec used `revealFileInOS` as the "Open Folder" command. That's a built-in VS Code command on macOS/Windows and Linux file managers. Plan uses the same. ✓
