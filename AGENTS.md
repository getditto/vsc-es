# Ditto Edge Studio agent guide

## Project shape

- This is a Node 22+, TypeScript, ESM-source VS Code extension.
- Extension-host code lives in `src/`; Lit webviews live in `webview-ui/`.
- Host/webview messages are discriminated unions in `src/ipc/messages.ts`.
- `package.json` is the source of truth for commands, views, menus, settings, and scripts.
- `engines.vscode` is `^1.106.0` because `contributes.viewsContainers.secondarySidebar`
  (the Inspector's container) only became stable in VS Code 1.106. Lowering it makes
  the Inspector fall back to the Explorer without any error.
- Treat `dist/` as generated output. Do not hand-edit it.
- Read `docs/Developer.md` for architecture and `docs/MANUAL_TESTING.md` only when a change needs Extension Development Host verification.

## Working agreements

- Preserve unrelated working-tree changes. Inspect `git status --short` before editing.
- Use `.js` suffixes in relative TypeScript imports (NodeNext convention).
- Keep SDK and VS Code APIs in the extension host. Webviews communicate through typed `postMessage` contracts and must not import `vscode` or `@dittolive/ditto`.
- When changing a host/webview feature, update both sides of its IPC union and exhaustively handle message types.
- Extend `scripts/vscode-stub.mjs` when unit tests need another VS Code API; do not add
  scattered ad-hoc mocks. It already fakes webview panels — see `createdWebviewPanels`
  and `__resetStub()` — so panels are unit-testable without an Extension Development Host.
- Interpolate collection/field/index names into DQL through `quoteIdentifier` /
  `quoteFieldPath` (`src/ditto/dql-identifier.ts`). Never hand-roll a character
  whitelist: DQL allows any name once backtick-quoted, and a whitelist both rejects
  legitimate names and misses invalid bare identifiers like a leading digit.
- Subscribe webviews to host messages with the `HostMessages` controller
  (`webview-ui/shared/messaging.ts`), not a hand-written
  `connectedCallback`/`disconnectedCallback` pair. VS Code re-parents webview panels
  between editor groups, so a missing disposer means every later message is handled
  once per past mount.
- Wrap async `onDidReceiveMessage` handlers in `webviewMessageHandler`
  (`src/panels/webview-utils.ts`). `onDidReceiveMessage` ignores the listener's return
  value, so a bare `async handle(msg)` — or `void this.handle(msg)` — turns a rejection
  into a silent no-op the user reads as "the button did nothing".
- Keep credentials out of source, logs, fixtures, and docs. Secrets belong in `vscode.SecretStorage`; non-secret metadata belongs in `globalState`.
- Avoid changing historical plans/specs unless the task explicitly concerns them. Current code and developer documentation override historical implementation notes.
- Do not add dependencies or change public extension contributions without calling it out in the handoff.

## Verification

Run the narrowest relevant test while iterating, then before handoff run:

```sh
npm run validate   # typecheck + lint + unit tests
npm run build
```

`npm run validate` is what CI runs on every pull request (`.github/workflows/validate.yml`).
Note that `npm run build` does **not** typecheck — esbuild strips types without
checking them — so `npm run typecheck` is a separate, non-redundant gate.

For documentation-only or agent-instruction-only changes, use Markdown/link inspection and `git diff --check`; a full build is unnecessary. For UI, SDK lifecycle, packaging, or VS Code contribution changes, also identify the relevant recipes in `docs/MANUAL_TESTING.md` and report any manual checks not run.

## Review priorities

- Flag lifecycle leaks: undisposed observers, subscriptions, listeners, timers, and panels.
- Flag untrusted webview HTML, missing CSP/nonces, secret exposure, and shell command construction from user input.
- Flag mismatches between `package.json` contributions, registered handlers, IPC contracts, and webview implementations.
- Flag tests that pass without exercising assertions or that bypass the VS Code stub unexpectedly.
- Flag `throw` inside a `finally` block: it replaces any in-flight exception rather than
  deferring to it, which silently discards the original cause.
- Flag character-whitelist validation of anything interpolated into DQL — quote it instead.
