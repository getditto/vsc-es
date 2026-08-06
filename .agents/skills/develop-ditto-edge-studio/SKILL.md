---
name: develop-ditto-edge-studio
description: Implement, debug, test, or review features in the Ditto Edge Studio VS Code extension. Use for work involving its TypeScript extension host, Lit webviews, typed IPC, Ditto SDK lifecycle, VS Code contributions, persistence, tests, or packaging; do not use for unrelated generic TypeScript questions.
---

# Develop Ditto Edge Studio

1. Read the root `AGENTS.md`. Inspect `git status --short` and preserve unrelated changes.
2. Locate the feature across these boundaries:
   - `package.json` for commands, views, menus, settings, and scripts
   - `src/extension.ts` for activation and command wiring
   - `src/ditto/` for SDK lifecycle and data access
   - `src/panels/` for webview hosts
   - `webview-ui/` for Lit UI
   - `src/ipc/messages.ts` for host/webview contracts
   - `src/test/` and `src/test/webview/` for tests
3. Read only the relevant sections of `docs/Developer.md`. Read `docs/MANUAL_TESTING.md` when the behavior needs a real Extension Development Host, credentials, native SDK, or UI interaction.
4. Implement the smallest coherent change. Keep SDK and VS Code access in the host, keep webviews renderer-only, and update typed IPC on both sides.
5. Add or update focused tests. Extend the shared VS Code stub when required.
6. Run the focused test during iteration. Before handoff, follow the verification matrix in `AGENTS.md` and report manual checks that remain.

When debugging, establish the failing boundary before editing: contribution/command registration, extension-host state, SDK operation, IPC transport, or webview rendering. Avoid speculative changes across every layer.

When reviewing, prioritize lifecycle cleanup, secret handling, CSP/webview safety, IPC exhaustiveness, contribution wiring, and meaningful test execution.
