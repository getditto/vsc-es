# Ditto Edge Studio agent guide

## Project shape

- This is a Node 22+, TypeScript, ESM-source VS Code extension.
- Extension-host code lives in `src/`; Lit webviews live in `webview-ui/`.
- Host/webview messages are discriminated unions in `src/ipc/messages.ts`.
- `package.json` is the source of truth for commands, views, menus, settings, and scripts.
- Treat `dist/` as generated output. Do not hand-edit it.
- Read `docs/Developer.md` for architecture and `docs/MANUAL_TESTING.md` only when a change needs Extension Development Host verification.

## Working agreements

- Preserve unrelated working-tree changes. Inspect `git status --short` before editing.
- Use `.js` suffixes in relative TypeScript imports (NodeNext convention).
- Keep SDK and VS Code APIs in the extension host. Webviews communicate through typed `postMessage` contracts and must not import `vscode` or `@dittolive/ditto`.
- When changing a host/webview feature, update both sides of its IPC union and exhaustively handle message types.
- Extend `scripts/register-vscode-stub.mjs` when unit tests need another VS Code API; do not add scattered ad-hoc mocks.
- Keep credentials out of source, logs, fixtures, and docs. Secrets belong in `vscode.SecretStorage`; non-secret metadata belongs in `globalState`.
- Avoid changing historical plans/specs unless the task explicitly concerns them. Current code and developer documentation override historical implementation notes.
- Do not add dependencies or change public extension contributions without calling it out in the handoff.

## Verification

Run the narrowest relevant test while iterating, then before handoff run:

```sh
npm test
npm run build
```

For documentation-only or agent-instruction-only changes, use Markdown/link inspection and `git diff --check`; a full build is unnecessary. For UI, SDK lifecycle, packaging, or VS Code contribution changes, also identify the relevant recipes in `docs/MANUAL_TESTING.md` and report any manual checks not run.

## Review priorities

- Flag lifecycle leaks: undisposed observers, subscriptions, listeners, timers, and panels.
- Flag untrusted webview HTML, missing CSP/nonces, secret exposure, and shell command construction from user input.
- Flag mismatches between `package.json` contributions, registered handlers, IPC contracts, and webview implementations.
- Flag tests that pass without exercising assertions or that bypass the VS Code stub unexpectedly.
