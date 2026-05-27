# Get Quickstarts — Design

**Date:** 2026-05-20
**Status:** Approved
**Owner:** Ditto Edge Studio team
**Target release:** v0.7.0 or later (post-0.6.0)

## Background

The SwiftUI Edge Studio app (`/Users/labeaaa/Developer/ditto-edge-studio/SwiftUI/EdgeStudio`) ships a **Get Quickstarts** action under its Help menu. When clicked it:

1. Downloads the `getditto/quickstart` repo into a folder the user picks.
2. Walks the extracted tree and writes `.env` files at three hard-coded locations using values pulled from the database the user has selected.
3. Also writes a `quickstart_config.yaml` into the `edge-server/` subfolder.
4. If no database is selected, warns the user that the `.env` files will not be configured and offers to proceed with the code-only download.

The VS Code extension currently has only a passive "Quickstart Repos" link in the Help tree that opens the GitHub page. We want feature parity: a one-click action that fetches the quickstarts and configures their `.env` (and YAML) using the user's active connection.

The reference SwiftUI service is `QuickstartDownloadService.swift`. The upstream repo is <https://github.com/getditto/quickstart>.

## Decisions captured during brainstorming

| Decision | Choice |
| --- | --- |
| What counts as "open configuration" | **Active connection only** (`DittoManager.session`). Snapshot at command-invocation time. If none, warn and offer code-only download. |
| Fetch mechanism | **`git clone` via Node's `spawn`** (args array, no shell). No new npm dep; assumes `git` is on PATH. Enables a trivial future "Update Quickstarts" (`git pull`). |
| Existing folder behavior | **Always prompt** before touching anything. Three explicit choices: Pull latest, Replace, Cancel. Never silent overwrite or silent pull. |
| Edge Server YAML | **Yes** — match SwiftUI 1:1, write `edge-server/quickstart_config.yaml` when the `edge-server/` directory exists. |
| `.env` destinations | **Hard-code SwiftUI's three**: repo root, `flutter_app/`, `go-tui/`. Add a comment pointing at this if the upstream list changes. Discovery-by-`.env.sample` is a future iteration if the hard-coded list stops scaling. |
| Entry points | **Help tree action** + **Welcome screen card** + **Command Palette**. No Database tree title-bar button (keeps the title bar uncluttered). |
| Single vs multi-command | **Single command** for v1. A separate "Reconfigure `.env`" command can be added in a future iteration if users ask for it. |
| Active-connection snapshot timing | Read once at command start. If the user disconnects mid-clone, the in-flight write still uses the snapshot. |

## Architecture

### New files

| Path | Purpose |
| --- | --- |
| `src/quickstart/QuickstartService.ts` | UI-free service. Git ops (clone, pull, target inspection) and file writing (`.env`, YAML). Returns plain result types so the flow controller renders progress and the service is trivially testable. |
| `src/quickstart/quickstart-projects.ts` | Single source of truth for the 17 hard-coded project names (`directoryName → displayName`), the three `.env` destinations, and the edge-server YAML path. |
| `src/test/QuickstartService.test.ts` | Unit tests. Content-generation snapshots for `.env` and YAML, `inspectTarget()` against a tmpdir, conditional-on-parent-exists behavior for `writeEnvFiles()`, mocked subprocess for the three clone/pull modes. |

### Modified files

| Path | Change |
| --- | --- |
| `src/extension.ts` | Register `dittoVsce.getQuickstarts`. Construct `QuickstartService` with the shared logger. Snapshot the active connection via `DittoManager` at command invocation. |
| `src/tree/HelpTreeProvider.ts` | Add `{ kind: 'action', label: 'Get Quickstarts', icon: 'cloud-download', command: 'dittoVsce.getQuickstarts' }` above the existing `Quickstart Repos` link. The link remains — it serves a different purpose (browse GitHub). |
| `package.json` | Add the `dittoVsce.getQuickstarts` command contribution. No new `activationEvents` entry required (the extension activates on view registration). |
| `webview-ui/welcome/welcome-element.ts` | New "Try a quickstart" card. Primary button posts a `welcome.getQuickstarts` IPC message; host fires the command. Secondary link goes to the upstream GitHub repo. |
| `src/ipc/messages.ts` | Add the `welcome.getQuickstarts` message type. |
| `README.md` | Append a "Quickstarts" subsection under Features. ~5 lines: what the command does, where it puts files, the warn-on-no-connection behavior, link to the upstream repo. |
| `docs/Developer.md` | Implementation notes — where the hard-coded project list lives, how to add a per-project `.env` destination, and the future path to discovery-by-`.env.sample`. |

## QuickstartService API

```ts
type EnvValues = {
  databaseId: string;
  token: string;
  authUrl: string;
  websocketUrl: string;
};

type EdgeServerValues = Omit<EnvValues, 'websocketUrl'>;

type WriteResult =
  | { path: string; outcome: 'written' }
  | { path: string; outcome: 'skipped-no-parent' }
  | { path: string; outcome: 'failed'; error: string };

type TargetInspection =
  | { kind: 'absent' }
  | { kind: 'git-checkout'; head: string }   // .git directory present
  | { kind: 'non-git-folder' };              // exists but no .git

type CloneMode = 'fresh-clone' | 'pull-existing' | 'replace-and-clone';

class QuickstartService {
  constructor(private readonly log: Logger);

  /** Pre-flight: is `git` on PATH and runnable? Used to refuse early with a clear error. */
  isGitAvailable(): Promise<boolean>;

  /** Classify the would-be clone target. The "non-git-folder" case is the dangerous one — never overwrite without consent. */
  inspectTarget(parentDir: string): Promise<TargetInspection>;

  /** Performs the requested git operation. Streams stderr to logger (it carries the progress lines). */
  cloneOrPull(
    parentDir: string,
    mode: CloneMode,
    onProgress: (msg: string) => void,
    abort: AbortSignal,
  ): Promise<{ repoRoot: string }>;

  /** Writes `.env` to root, flutter_app/, go-tui/. Each location only written when the parent directory exists. */
  writeEnvFiles(repoRoot: string, values: EnvValues): WriteResult[];

  /** Writes edge-server/quickstart_config.yaml when edge-server/ exists. */
  writeEdgeServerYaml(repoRoot: string, values: EdgeServerValues): WriteResult;
}
```

The service has no VS Code or DittoManager imports — everything it needs is passed in.

### Why these contracts

- **`inspectTarget` returns a discriminated union, not a boolean.** The "non-git-folder" case is the dangerous one — a folder named `quickstart/` that isn't our clone could be the user's own work. A boolean would conflate this with the safe "pull-latest" case.
- **`cloneOrPull` takes an explicit `mode` and an `AbortSignal`.** The service doesn't pick its own destruction strategy; the flow controller does, after the user has confirmed it. Cancellation flows through the standard `AbortSignal` plumbing.
- **`WriteResult[]` for `.env`, single `WriteResult` for YAML.** Mirrors the actual call sites (three potential `.env` files vs. one YAML file) and lets the flow controller summarize per-file outcomes.

### Subprocess invocation pattern

`cloneOrPull` uses Node's `spawn(command, args, options)` form — argument-array style, **no `shell: true`**, and the `command` is the literal string `'git'`. All variable inputs (`parentDir`, `mode`) flow only into the `args` array (e.g. `['clone', '--depth', '1', repoUrl, targetDir]`). This is the standard injection-safe pattern: no shell metacharacter interpretation, no concatenated command strings. `isGitAvailable` follows the same shape with `spawn('git', ['--version'])`.

## Flow controller

The `dittoVsce.getQuickstarts` command handler in `extension.ts` orchestrates:

```
1. git available?
     no  → showErrorMessage "Git is required for Get Quickstarts. Install git and retry."
            with an "Open install docs" action linking to https://git-scm.com/downloads
     yes → continue

2. activeConnection = dittoManager.getActiveSession()
     none → showWarningMessage(modal: true,
              "No active connection — `.env` files will not be configured. Continue with code-only download?",
              "Continue", "Cancel")
            cancel → return
            continue → proceed with values = null

3. uri = showOpenDialog({ canSelectFolders: true, canSelectMany: false,
                          openLabel: "Select parent folder" })
     dismissed → return
     ok → parentDir = uri.fsPath

4. inspection = service.inspectTarget(path.join(parentDir, 'quickstart'))
     absent          → mode = 'fresh-clone'
     git-checkout    → showInformationMessage(modal: true,
                          "A quickstart checkout already exists at <path>.",
                          "Pull latest", "Replace", "Cancel")
                       cancel/dismiss → return
                       pull          → mode = 'pull-existing'
                       replace       → mode = 'replace-and-clone'
     non-git-folder  → showWarningMessage(modal: true,
                          "A non-git folder named 'quickstart' exists at <path>. Replace it?",
                          "Replace", "Cancel")
                       cancel/dismiss → return
                       replace       → mode = 'replace-and-clone'

5. withProgress({ location: Notification, title: "Setting up Quickstarts", cancellable: true }, async (progress, token) => {
     const abort = new AbortController();
     token.onCancellationRequested(() => abort.abort());
     progress.report({ message: mode === 'pull-existing' ? "Updating clone…" : "Cloning…" })
     const { repoRoot } = await service.cloneOrPull(parentDir, mode, msg => progress.report({ message: msg }), abort.signal)

     let envResults: WriteResult[] = []
     let yamlResult: WriteResult | null = null
     if (values) {
       progress.report({ message: "Writing .env files…" })
       envResults = service.writeEnvFiles(repoRoot, values)
       progress.report({ message: "Writing edge-server config…" })
       yamlResult = service.writeEdgeServerYaml(repoRoot, edgeServerValuesFrom(values))
     }
     return { repoRoot, envResults, yamlResult }
   })

6. Summarize results into an output-channel log line + a final notification:
   - If values were written:
       showInformationMessage("Quickstarts ready at <path>. Configured N .env file(s) + edge-server YAML.",
                              "Open Folder", "Show Log")
   - If code-only:
       showInformationMessage("Quickstarts cloned at <path>. Open a connection and re-run to configure .env files.",
                              "Open Folder", "Show Log")
```

On cancel, the `AbortSignal` kills the subprocess and the flow controller cleans up partial state: for `fresh-clone` / `replace-and-clone`, remove the partial directory; for `pull-existing`, leave the existing checkout untouched.

## Content specs

### `.env` (root, flutter_app/, go-tui/)

Identical bytes at all three locations:

```bash
#!/usr/bin/env bash

# Auto-configured by Ditto Edge Studio
DITTO_APP_ID="<databaseId>"
DITTO_PLAYGROUND_TOKEN="<token>"
DITTO_AUTH_URL="<authUrl>"
DITTO_WEBSOCKET_URL="<websocketUrl>"
```

The env-var names use the **old** terminology (`DITTO_APP_ID`, `DITTO_PLAYGROUND_TOKEN`) by design — that's what the quickstart code actually reads. A file with the new names would not be loaded by any quickstart project until the upstream code is renamed. When upstream renames, update the constants in `quickstart-projects.ts` and bump the file format version comment.

### `edge-server/quickstart_config.yaml`

```yaml
resources:
  my_ditto_db:
    resource_type: DittoDatabase
    db_id: "<databaseId>"
    device_name: "edge-studio-quickstart"
    subscriptions:
      - "SELECT * FROM tasks"
    auth:
      server:
        access_token: "<token>"
        auth_url: "<authUrl>"
        provider: "__playgroundProvider"
  my_http_server:
    resource_type: HttpServer
    listen_addr: "0.0.0.0:8080"
    databases:
      my_db:
        db_id: "<databaseId>"
        base_path: my_server
        http_api: true
```

Byte-for-byte match with SwiftUI. The `subscriptions`, `device_name`, `provider`, and HTTP server defaults are intentional — they're what the Edge Server quickstart expects when the user follows the upstream README.

## Error handling

| Failure | Behavior |
| --- | --- |
| Git not on PATH | Pre-flight refuses early. Error notification with "Open install docs" action. No partial state. |
| `git clone` network/auth failure | Error notification with the trimmed `stderr` tail. Full output in the extension's output channel. Folder created during the failed run is removed; pre-existing folders are left untouched. |
| `git pull` on dirty working tree or diverged history | Error notification: "Pull failed (dirty work tree or diverged history). Choose Replace next time to reset, or resolve manually." No automatic `git reset --hard`. |
| `.env` / YAML write failure (permissions, ENOENT race) | Per-file warning logged. Other writes continue. The final summary lists every file with outcome. User can re-run "Get Quickstarts" and the flow detects the existing checkout, offering Pull latest (which re-runs the writes). |
| No active connection + Continue chosen | All writes skipped. Success message says "Code-only — open a connection then re-run to configure `.env` files." |
| User cancels mid-clone | Subprocess killed via the `AbortSignal`. For fresh/replace clone, the partial directory is removed. For pull, the existing checkout is left as-is. Notification: "Cancelled." |

The extension already has a logger with output-channel routing — every step posts an info or warn line so the user can pop open the channel via the "Show Log" action and see the full transcript.

## Welcome screen card

Inserted into `welcome-element.ts` after the existing onboarding cards and before any release-notes feed.

Visual: a card with a `cloud-download` codicon, title **Try a quickstart in your favorite language**, one-paragraph body:

> Edge Studio can clone Ditto's official quickstart projects (Swift, Kotlin, Flutter, Rust, .NET, JavaScript, and 11 more) onto your machine and pre-fill the `.env` files using whichever connection is currently active. New to Ditto? This is the fastest way to see sync working end-to-end.

Buttons:
- Primary: **Get Quickstarts** — posts `welcome.getQuickstarts` over IPC, host invokes the command.
- Secondary: **Browse on GitHub** — opens the upstream repo URL.

## Documentation

### README.md

Add a "Quickstarts" subsection under the existing Features list:

> **Get Quickstarts.** One click clones the official Ditto quickstart repo into a folder you choose and pre-fills `.env` files for every quickstart project (plus the Edge Server YAML config) using your active connection's Database ID, Development Token, and URLs. If you have no active connection it offers a code-only download.

Surface the entry points (Help tree action, Welcome card, Command Palette).

### docs/Developer.md

New "Quickstarts feature" section covering:
- The hard-coded project list at `src/quickstart/quickstart-projects.ts` and when to update it (add a new per-project `.env` destination, add a new display name).
- The env-var naming relationship to the upstream quickstart code (why we still emit `DITTO_APP_ID` even after the in-extension terminology rename).
- The future path: switching the `.env` resolution strategy to discovery-by-`.env.sample` if the hard-coded list stops scaling.

## Testing

| Layer | What's tested | Strategy |
| --- | --- | --- |
| `QuickstartService.writeEnvFiles` | Conditional-on-parent-exists, exact file bytes | tmpdir with a mix of present/absent subfolders, snapshot string match |
| `QuickstartService.writeEdgeServerYaml` | Skip when `edge-server/` absent, exact bytes when present | tmpdir, snapshot string match |
| `QuickstartService.inspectTarget` | All three return shapes | tmpdir with `.git`/no-`.git`/absent |
| `QuickstartService.cloneOrPull` | Three modes, cancellation, error capture | Inject a subprocess factory; the test injects a stub returning canned exit codes + stderr without spawning anything real |
| `QuickstartService.isGitAvailable` | true/false paths | Same factory injection |
| `quickstart-projects.ts` | List integrity | Sanity test: every entry has both `directoryName` and `displayName` non-empty |

No end-to-end test of the full flow controller — the dialogs are VS Code APIs we'd have to stub heavily. The flow controller stays thin enough to be readable end-to-end, and manual verification is in the Test Plan section of the implementation PR.

## Out of scope (deliberately deferred)

- Auto-discovery of `.env` locations via `.env.sample` scan. Captured in `Developer.md` as the planned upgrade.
- A separate "Reconfigure `.env`" command — single command for v1; revisit if users ask.
- A "default parent folder" user setting — minor convenience, can land in a follow-up.
- Updating the active connection's name into peer metadata of the cloned quickstarts — out of scope for this feature.
- Telemetry/analytics on quickstart usage — handled separately by the existing metrics layer if needed.

## Risks & mitigations

- **Upstream repo restructure.** If `getditto/quickstart` reorganizes directories (e.g. moves `flutter_app/` to `flutter/`), our hard-coded list misses the `.env`. *Mitigation:* the writes are best-effort; the user gets a per-file summary and can manually copy the root `.env` into the new subfolder. Owners watching upstream releases bump the constants and ship a patch release.
- **Git not on PATH.** Some users (especially on Windows without Git for Windows) won't have it. *Mitigation:* pre-flight detection with a clear install link.
- **Old terminology in env-var names.** Confusing relative to the in-extension UI which uses Database ID / Development Token. *Mitigation:* documented in `Developer.md`; comment in code explains the upstream dependency.
- **`git pull` failure on a customised checkout.** A user who has modified the quickstart code locally will fail pull. *Mitigation:* we don't auto-resolve; we surface the error and tell them to choose Replace or resolve manually.
