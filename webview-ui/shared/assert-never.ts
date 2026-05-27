/** Exhaustiveness check for discriminated-union `switch` statements.
 *  TypeScript narrows the union as cases are handled; in the
 *  `default:` branch the type should be `never`, and `assertNever`
 *  enforces it at compile time. If a new variant is added to the
 *  union and not handled, the call to `assertNever(value)` will
 *  fail type-checking — the loudest possible signal for IPC drift.
 *
 *  At runtime it throws (rather than returns) so a forgotten case
 *  surfaces immediately during testing, not as a silent no-op.
 *
 *  Lives in webview-ui/shared/ because the IPC-handling switches
 *  that need it are all webview-side; the host's `if (msg.type ===)`
 *  chains type-check exhaustively via the type predicates on each
 *  branch. If a host-side switch ever needs it, move this file up
 *  to a shared location both bundles can import. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated-union value: ${JSON.stringify(value)}`);
}
