# Ditto Edge Studio (VS Code) — Cross-platform build, validation, and release

**Date:** 2026-05-17
**Status:** Draft (pending review)
**Depends on:** Database Lifecycle (`2026-05-09-database-lifecycle-design.md`) for the
manager surface the e2e test drives.
**Blocks:** First tagged release (`v0.1.0`).

## 1. Overview

The repo currently produces a single `.vsix` via `vsce package --no-dependencies`
that **cannot actually load `@dittolive/ditto` at install time** — `node_modules`
is excluded and the SDK is marked `external` in esbuild. There is no CI, no
per-platform packaging, and no validation that a built artifact works on the
operating systems Ditto's native binaries target.

This spec defines:

- A **build-and-validate workflow** that on-demand produces a working `.vsix`
  for each supported platform and exercises it end-to-end against a dedicated
  Ditto CI app.
- A **release workflow** that on tag push produces, validates, and publishes
  those `.vsix` files as a GitHub Release, with hand-written release notes as
  the single source of truth.
- A small **packaging-gap fix** in the repo so the produced `.vsix` is
  actually installable.
- A **terminology rename pass** to bring user-facing strings, env-file keys,
  and docs in line with the Portal's current vocabulary
  (App ID → Database ID, Playground Token → Development Token, Auth URL → URL).
- A **README installation guide** with step-by-step instructions for
  installing the released `.vsix` in VS Code, Cursor, and Google Antigravity
  — the three VS Code-family editors developers commonly use.

### 1.1 References

- Current build: `esbuild.config.mjs`, `package.json` (`scripts.build`/`package`),
  `.vscodeignore`
- Existing tests: `src/test/**/*.test.ts` (Node built-in test runner)
- Existing config model: `src/models/DittoConfig.ts`
- Existing manager surface used by e2e test: `src/ditto/DittoManager.ts`
- Logger / secret scrubbing: `src/test/secrets.test.ts`, `src/test/Logger.test.ts`
- Auto-memory note: `ditto-portal-terminology.md` records the rename

### 1.2 Goals

- **Cross-platform packaging that actually works.** Each `.vsix` ships with
  exactly the native binary for its target.
- **Manual, on-demand validation** with selectable depth so cheap checks stay
  cheap and full e2e is opt-in.
- **End-to-end signal** — for the full-depth runs, the `.vsix` is installed
  into a clean VS Code, the extension activates, and a real sync session to
  the CI Ditto app succeeds.
- **Releaseable artifacts** with hand-written notes, gated on the
  `package.json` version matching the tag.
- **Secrets handled correctly** — repo-scoped, env-injected only into the
  step that needs them, never echoed.

### 1.3 Non-goals

- **No auto-trigger on push/PR.** All CI is `workflow_dispatch` or tag-push.
  Cost is high; the user explicitly opted into manual.
- **No pre-release tag support** (`v*-rc*`, `v*-beta*`) in v1. Strict
  `v<MAJOR>.<MINOR>.<PATCH>` only.
- **No auto-generated changelog addendum.** Hand-written notes are the only
  release content.
- **No Marketplace publication.** Same as project-wide stance.
- **No retries** on flaky e2e — failures stay visible.

## 2. Supported targets

Four targets, matching the platforms `@dittolive/ditto` 5.x ships native
binaries for. No `darwin-x64`, no `win32-arm64`.

| target          | GitHub runner       | Node | `vsce --target`   |
| --------------- | ------------------- | ---- | ----------------- |
| `darwin-arm64`  | `macos-14`          | 22   | `darwin-arm64`    |
| `linux-x64`     | `ubuntu-24.04`      | 22   | `linux-x64`       |
| `linux-arm64`   | `ubuntu-24.04-arm`  | 22   | `linux-arm64`     |
| `win32-x64`     | `windows-2022`      | 22   | `win32-x64`       |

Node 22 LTS (Active LTS through 2027). Bumps `engines.node` to `>=22` and
`@types/node` to `^22.x`.

## 3. Packaging-gap fix

These edits are prerequisites for either workflow to produce an installable
`.vsix`. They live in the same PR as the workflow files.

### 3.1 `package.json` dependencies reclassification

Every entry in `dependencies` other than `@dittolive/ditto` is bundled at
build time by esbuild — none need to live in the published `node_modules`.

- **Move to `devDependencies`**: `@codemirror/lang-json`, `@codemirror/state`,
  `@codemirror/view`, `codemirror`, `lit`.
- **Remove entirely**: `dotenv` (unused — confirmed by grep across `src/`,
  `webview-ui/`, `scripts/`).
- **Keep in `dependencies`**: `@dittolive/ditto` only.

Result: `npm ci --omit=dev` in CI produces a `node_modules/` containing only
the Ditto SDK and its transitive deps.

### 3.2 `.vscodeignore` update

- Remove the `node_modules/**` line (we now want the slim node_modules in
  the package).
- No new include rules needed — vsce respects the (now smaller) tree.

### 3.3 `package.json` scripts

- Drop `--no-dependencies` from `scripts.package`.
- Parameterize target:
  ```json
  "package": "vsce package --target ${TARGET}"
  ```
- For local use, set `TARGET=darwin-arm64` (or whichever) in the shell. CI
  sets it from the matrix.

### 3.4 CI pre-package step — prune wrong-arch binaries

Runs after `npm ci --omit=dev` and before `vsce package`:

```bash
cd node_modules/@dittolive/ditto/node
for f in ditto.*.node; do
  [ "$f" = "ditto.${TARGET}.node" ] || rm -f "$f"
done
```

### 3.5 Sanity assertion

After `vsce package`, the workflow verifies the `.vsix` carries exactly one
`.node` file and that it matches the target. Failure aborts the leg before
artifact upload.

```bash
COUNT=$(unzip -l ./*.vsix \
  | awk '/extension\/node_modules\/@dittolive\/ditto\/node\/ditto\..*\.node$/{c++} END{print c+0}')
test "$COUNT" = "1" || { echo "Expected 1 native binary, got $COUNT"; exit 1; }
```

## 4. Test infrastructure

### 4.1 Existing unit tests — unchanged

Continue to run under the Node built-in test runner via:

```
node --import tsx --import ./scripts/register-vscode-stub.mjs --test 'src/test/**/*.test.ts'
```

These are pure-logic tests using the existing `vscode` stub. They run in
the same `package` depth (cheap) and act as a smoke check before bothering
to install into a real VS Code.

### 4.2 New integration tests — Mocha + `@vscode/test-electron`

- New tree: `src/test/integration/`
  - `runTests.ts` — launcher (downloads VS Code, installs the freshly-built
    `.vsix` via `--install-extension`, opens an empty workspace, runs the
    suite).
  - `index.ts` — Mocha-style runner entry.
  - `activation.test.ts` — load-tier assertions.
  - `e2e.test.ts` — e2e-tier assertions (skipped if `DITTO_CI_MODE !== '1'`).

- New devDependencies: `@vscode/test-electron`, `mocha`, `@types/mocha`,
  `glob` (for test discovery).

- New `package.json` scripts:
  - `test:integration:load` — runs only `activation.test.ts`.
  - `test:integration:e2e` — runs the full suite including `e2e.test.ts`.

- Linux runners wrap the launcher in `xvfb-run`. macOS and Windows runners
  do not need it.

### 4.3 Load-tier assertions (`activation.test.ts`)

After install + workspace open:

- `vscode.extensions.getExtension('ditto.ditto-vsce')` is defined.
- `.isActive === true` (forced via `await ext.activate()` if needed).
- No uncaught exceptions logged during activation (Mocha fails if any
  `unhandledRejection` / `uncaughtException` fires during the test).
- The `dittoVsce` view container is present in `vscode.window`.

Failures here indicate platform/binary-loading issues (glibc mismatch,
codesign, ABI), packaging gaps, or activation regressions.

### 4.4 E2E-tier assertions (`e2e.test.ts`)

Gated on `process.env.DITTO_CI_MODE === '1'`. When the flag is absent the
suite is `it.skip`'d, so a local `npm run test:integration:load` doesn't
require Ditto credentials.

Sequence:

1. `const api = await ext.activate();` — fetch the test API.
2. `await api.registerFromEnv();` — reads `DITTO_CI_DATABASE_ID`,
   `DITTO_CI_DEVELOPMENT_TOKEN`, `DITTO_CI_URL`, `DITTO_CI_WEBSOCKET_URL`
   from env; writes a config to `globalState` and the secret to
   `SecretStorage` the same way a real user interaction would.
3. `const cfgId = await api.connect();` — drive the existing connect path.
4. `await api.waitForPeerOrSyncStatus(30_000);` — resolves on the first
   `presence.observe` peer or `__sync_status` row from the SDK's
   already-wired read paths.
5. Assert: the await resolved (didn't time out).
6. `await api.disconnect();` — tears down the SDK.

Site name passed in via env (`DITTO_CI_SITE_NAME` = `ci-<run-id>-<target>`)
so concurrent matrix legs and reruns don't collide.

Timeout budget: 60s per test, 30s for the peer/sync wait, 20s slack for
SDK init and disconnect.

No automatic retry. A flake stays visible.

### 4.5 Bounded extension test API

A new entry point on the extension side, **only active when
`process.env.DITTO_CI_MODE === '1'`**:

```ts
// src/extension.ts
export async function activate(ctx: vscode.ExtensionContext): Promise<TestAPI | undefined> {
  // …existing activation…
  if (process.env.DITTO_CI_MODE === '1') {
    return makeTestApi(ctx, manager);
  }
  return undefined; // production: no test surface returned
}
```

`makeTestApi` exposes only the methods listed in 4.4. The factory itself
is in a new file `src/test-api/index.ts` and is referenced from the
production extension entry point only inside the `DITTO_CI_MODE` branch,
so a Marketplace-style audit can confirm it's gated.

The factory reads env vars by their CI names
(`DITTO_CI_DATABASE_ID`, `DITTO_CI_DEVELOPMENT_TOKEN`, `DITTO_CI_URL`,
`DITTO_CI_WEBSOCKET_URL`) and synthesizes a `StoredDittoConfig` whose
`authUrl` field is populated from `DITTO_CI_URL`. (Internal field name
stays `authUrl` per decision D in section 9.)

## 5. Workflows

Three files in `.github/workflows/`.

### 5.1 `_build-matrix.yml` — reusable workflow

`on: workflow_call` with inputs:

- `depth` (`package` | `load` | `e2e`, default `package`)

Strategy: `fail-fast: false`, matrix of the four targets in section 2.

Per leg:

```
checkout
  ↓
setup-node@v4 (Node 22, npm cache)
  ↓
npm ci
  ↓
npm run build
  ↓
prune wrong-arch native binaries (section 3.4)
  ↓
TARGET=<matrix.target> npm run package
  ↓
sanity-check .vsix (section 3.5)
  ↓
upload-artifact@v4: ditto-vsce-<target>-<run-id>
  ↓ if depth in (load, e2e)
npm run test:integration:load   (xvfb-run on linux)
  ↓ if depth == e2e
npm run test:integration:e2e   (xvfb-run on linux)
   env: DITTO_CI_MODE=1, DITTO_CI_DATABASE_ID, DITTO_CI_DEVELOPMENT_TOKEN,
        DITTO_CI_URL, DITTO_CI_WEBSOCKET_URL  (all from ${{ secrets.* }})
```

A final summary step (per leg) appends a row to `$GITHUB_STEP_SUMMARY` with
target, depth, duration, and artifact name.

### 5.2 `build-and-validate.yml` — manual dispatch caller

```yaml
on:
  workflow_dispatch:
    inputs:
      depth:
        type: choice
        options: [package, load, e2e]
        default: e2e

jobs:
  matrix:
    uses: ./.github/workflows/_build-matrix.yml
    with:
      depth: ${{ inputs.depth }}
    secrets: inherit
```

Triggered from the GitHub UI ("Run workflow") or `gh workflow run
build-and-validate.yml -f depth=e2e`.

### 5.3 `release.yml` — tag-push caller

```yaml
on:
  push:
    tags: ['v[0-9]+.[0-9]+.[0-9]+']  # strict semver, no pre-release suffix

jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - checkout
      - Assert tag matches package.json version  (see 5.3.1)
      - Assert release notes file exists         (see 5.3.2)

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
      - download-artifact@v4 (all four ditto-vsce-* artifacts)
      - softprops/action-gh-release@v2:
          tag_name: ${{ github.ref_name }}
          name: ${{ github.ref_name }}
          body_path: docs/releases/${{ github.ref_name }}.md
          files: |
            ditto-vsce-*/ditto-vsce-*.vsix
          fail_on_unmatched_files: true
          prerelease: false
```

#### 5.3.1 Version-match gate

```bash
TAG="${GITHUB_REF_NAME#v}"
PKG=$(node -p "require('./package.json').version")
test "$TAG" = "$PKG" || {
  echo "Tag $GITHUB_REF_NAME does not match package.json version $PKG"
  exit 1
}
```

#### 5.3.2 Release notes gate

```bash
NOTES="docs/releases/${GITHUB_REF_NAME}.md"
test -f "$NOTES" || {
  echo "Release notes missing: $NOTES"
  echo "Create the file (see docs/releases/TEMPLATE.md) and re-tag."
  exit 1
}
```

#### 5.3.3 Failed releases

If `verify` fails: no release, no `.vsix` files produced. User deletes the
tag (`git tag -d v0.1.0; git push --delete origin v0.1.0`), fixes the
issue, re-tags.

If `matrix` fails on any platform: no release. Investigate via the matrix
run's logs, fix, re-tag.

## 6. Release notes

Per-version Markdown files at `docs/releases/v<MAJOR>.<MINOR>.<PATCH>.md`.

The release workflow reads the entire file verbatim as the release body —
no transformation, no merging with auto-generated content.

A one-time `docs/releases/TEMPLATE.md` is committed with the structure:

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

The template is not used at workflow time — it's a copy-paste starter for
humans. The brief pointer-to-README pattern keeps install instructions in
a single source of truth instead of duplicating them per release.

## 7. Secrets

Four repository secrets on `getditto/vsc-es` (already set):

| name                        | source                                        |
| --------------------------- | --------------------------------------------- |
| `DITTO_CI_DATABASE_ID`      | Ditto Portal → CI app → Overview              |
| `DITTO_CI_DEVELOPMENT_TOKEN`| Ditto Portal → CI app → Auth                  |
| `DITTO_CI_URL`              | Ditto Portal → CI app → URLs                  |
| `DITTO_CI_WEBSOCKET_URL`    | Ditto Portal → CI app → URLs                  |

Injection: env-var only, only into the `e2e` test step, only when `depth ==
'e2e'`. Never echoed to logs, never passed as command-line args.

The integration test setup aborts with a clear "missing required env var"
message before any SDK call if any of the four are empty when
`DITTO_CI_MODE=1`.

Rotation: regenerate in Portal → `gh secret set <NAME> --repo
getditto/vsc-es` → next workflow run picks up the new value.

## 8. README installation guide

The README gets a new top-level **Installation** section with a complete,
self-contained walkthrough for installing the released `.vsix` in the
three major VS Code-family editors developers actually use.

### 8.1 Section structure

1. **Pick your platform** — link to the latest GitHub Release with a table
   mapping platform → asset filename.
2. **Install in your editor** — three sub-sections (VS Code, Cursor,
   Google Antigravity), each with both a UI path and a CLI path.
3. **Reload and verify** — Command Palette → "Developer: Reload Window",
   then confirm the Ditto icon appears in the activity bar.
4. **Not supported** — explicit callout for `darwin-x64` (Intel Mac) and
   `win32-arm64` (Windows on ARM) since the SDK doesn't ship binaries for
   them.

### 8.2 Content

The README section reads roughly as:

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

Then install in your editor. All three editors share VS Code's extension
format, so the steps are nearly identical — only the CLI binary name
differs.

### VS Code

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from
  VSIX…** → pick the downloaded file.
- **CLI**: `code --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Cursor

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from
  VSIX…** → pick the downloaded file.
- **CLI**: `cursor --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`

### Google Antigravity

- **UI**: Extensions sidebar → `…` (More Actions) menu → **Install from
  VSIX…** → pick the downloaded file.
- **CLI**: `antigravity --install-extension /path/to/ditto-vsce-<target>-<ver>.vsix`
  *(verify exact binary name in your Antigravity install — older builds
  may use a different CLI command)*

### Reload and verify

After installing, open the Command Palette (`Cmd+Shift+P` /
`Ctrl+Shift+P`) and run **Developer: Reload Window**. The Ditto icon
should appear in the activity bar.

### Not supported

- **Intel Mac (`darwin-x64`)** — the `@dittolive/ditto` SDK does not ship
  a binary for this target.
- **Windows on ARM (`win32-arm64`)** — same reason.
````

### 8.3 Verification during implementation

The implementation plan includes a manual verification step on each
editor (where available locally) confirming the **Install from VSIX…**
menu path and CLI command are accurate at the time of v0.1.0. The
Antigravity CLI binary name in particular should be confirmed against
its current docs before the README ships — it's the youngest of the
three editors and naming conventions may still be evolving.

### 8.4 Cross-references

- `README.md` — the new **Installation** section.
- `docs/releases/TEMPLATE.md` — the brief Install snippet points back to
  this section (section 6 of this spec).
- The existing terminology rename pass (section 9) does NOT need to
  touch the new Installation section — it's net-new content and uses
  current vocabulary.

## 9. Terminology rename

The Ditto Portal renamed three concepts. Repo state as of this spec:

- **Already done**: `appID` → `databaseId` in `StoredDittoConfig`.
- **To rename**: user-facing strings, env-file keys, doc references.
- **Internal field decision (D)**: `authUrl` stays as the internal field
  name to minimize churn. User-facing strings say "URL"; the code field
  stays `authUrl`. Small drift accepted.

| domain                      | change                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `webview-ui/editor/editor-element.ts:110` | `<label>Auth URL</label>` → `<label>URL</label>`      |
| `src/panels/DatabaseEditorPanel.ts:117`   | validation error string "Auth URL is..." → "URL is..." |
| `webview-ui/welcome/welcome-element.ts:380–395` | narrative paragraph rewritten ("App ID (used as the Database ID)... Auth URL... playground token" → "Database ID... URL... Development Token") |
| `.env.example`              | `DITTO_APP_ID` / `DITTO_PLAYGROUND_TOKEN` / `DITTO_AUTH_URL` → `DITTO_DATABASE_ID` / `DITTO_DEVELOPMENT_TOKEN` / `DITTO_URL` |
| `docs/MANUAL_TESTING.md`    | 3 references updated                                                |
| `README.md:22`              | "auth URL" → "URL"                                                  |

Out of scope: SDK call sites that already use the SDK's own `url` property
name (`{ mode: 'server', url: config.authUrl }`) — that's the SDK's API.

## 10. Acceptance criteria

The plan is complete when:

1. Running `gh workflow run build-and-validate.yml -f depth=package` on the
   default branch produces four `.vsix` artifacts named
   `ditto-vsce-<target>-<run-id>`, each ~25–50 MB, each containing exactly
   one `ditto.<target>.node` binary.
2. Running `gh workflow run build-and-validate.yml -f depth=load` on the
   same branch also asserts each `.vsix` installs into a clean VS Code and
   activates without exceptions.
3. Running `gh workflow run build-and-validate.yml -f depth=e2e` on the
   same branch also succeeds in opening a real Ditto session to the CI
   app and observing at least one `presence` peer or `__sync_status` row
   within 30s.
4. Tagging `v0.1.0` (after bumping `package.json` and writing
   `docs/releases/v0.1.0.md`) results in a GitHub Release at
   `https://github.com/getditto/vsc-es/releases/tag/v0.1.0` with the four
   platform `.vsix` files attached and the release notes file's content as
   the body.
5. Tagging with a mismatched `package.json` version fails the workflow at
   the verify step. No release is created.
6. Tagging without a corresponding `docs/releases/v<tag>.md` file fails
   the workflow at the verify step. No release is created.
7. All four secrets remain unreferenced in any log output, regardless of
   workflow depth.
8. The README contains an **Installation** section with UI + CLI
   instructions for VS Code, Cursor, and Google Antigravity, a platform →
   asset-filename table, a reload-and-verify step, and an explicit
   "Not supported" callout for Intel Mac and Windows on ARM. A reviewer
   following only the README can install the released `.vsix` in their
   editor of choice without consulting other docs.

## 11. Open follow-ups (out of scope for this spec)

- Pre-release tag pattern support (`v*-rc*`, `v*-beta*`).
- Auto-generated "what's changed" addendum to release notes.
- Slack/email notification on release publish.
- Auto-trigger on push/PR (deliberately deferred for cost).
- GitHub Marketplace publication.
- Notarization / codesigning on macOS (the `.vsix` is a zip, not a signed
  binary — VS Code itself runs the code unsigned-by-extensions today).
