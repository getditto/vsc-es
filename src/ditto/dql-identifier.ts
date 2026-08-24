/**
 * Safe interpolation of identifiers (collection names, field paths, index
 * names) into DQL statement text.
 *
 * DQL has no bind parameters for identifiers — only for values — so anything
 * that names a collection or field has to be concatenated into the statement.
 * Per the DQL reference, an *unquoted* identifier may contain only letters,
 * digits, and underscores, and must start with a letter or an underscore.
 * Anything else has to be backtick-quoted, and a literal backtick inside a
 * quoted identifier is written as two backticks.
 *
 * Quoting is preferred over rejecting. A validator that only accepts
 * `[A-Za-z0-9_]+` locks the user out of collections they legitimately have
 * (`order-items`, `Bestellungen`, a name with a space) while *still* accepting
 * `9foo`, which DQL rejects unquoted. Quoting is both safer and less
 * restrictive: the backtick is the only character with meaning inside a quoted
 * identifier, and doubling it removes the only way out.
 */

/** The characters DQL allows in an identifier written without backticks. */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown for input that cannot be expressed as a DQL identifier at all. */
export class InvalidIdentifierError extends Error {
  constructor(kind: string, reason: string) {
    super(`Invalid ${kind}: ${reason}`);
    this.name = 'InvalidIdentifierError';
  }
}

/**
 * Backtick-quote a single identifier for interpolation into DQL.
 *
 * Always quotes, even when the name would be legal bare — an unconditional
 * quote is one less branch to get wrong, and DQL treats a quoted identifier
 * that needs no quoting as the same identifier.
 */
export function quoteIdentifier(name: string, kind = 'identifier'): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidIdentifierError(kind, 'name is empty');
  }
  // A NUL would terminate the statement early in some parsers, and newlines
  // inside an identifier make logged DQL unreadable. Neither can appear in a
  // real Ditto collection name.
  if (/[\0\r\n]/.test(name)) {
    throw new InvalidIdentifierError(kind, 'name contains a control character');
  }
  return `\`${name.replace(/`/g, '``')}\``;
}

/**
 * Quote a dotted field path segment by segment: `a.b.c` → `` `a`.`b`.`c` ``.
 *
 * Dots are treated as path separators, matching how the Add Index UI and the
 * rest of the extension read a field path. A key that genuinely contains a dot
 * is therefore not expressible here — the same limitation the UI already has.
 */
export function quoteFieldPath(path: string, kind = 'field'): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new InvalidIdentifierError(kind, 'name is empty');
  }
  const segments = path.split('.');
  if (segments.some(s => s.length === 0)) {
    throw new InvalidIdentifierError(kind, `"${path}" has an empty path segment`);
  }
  return segments.map(s => quoteIdentifier(s, kind)).join('.');
}

/** True when `name` needs no backticks. Exported for tests and for callers
 *  that build a display string rather than executable DQL. */
export function isBareIdentifier(name: string): boolean {
  return BARE_IDENTIFIER.test(name);
}
