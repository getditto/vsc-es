/** Identifier names whose values are secrets and must never reach a sink. */
export const SECRET_KEYS = ['token', 'secretKey', 'httpApiKey'] as const;

/** URL query-parameter names that carry credentials (SDK auth/transport
 *  logs are where token-bearing URLs show up). */
const SECRET_QUERY_PARAMS = ['token', 'access_token', 'api_key', 'secretKey', 'httpApiKey'] as const;

// All patterns compile ONCE at module load. The key lists are fixed, so a
// single combined alternation per family covers exactly the same ground as
// the previous per-key `new RegExp(...)` — which rebuilt ~8 RegExps on every
// log line. Case-insensitive throughout: SDK and server payloads are not
// consistent about casing, and `{"Token":"…"}` is exactly as much of a leak
// as `{"token":"…"}`.
const JSON_KEY_ALT = SECRET_KEYS.join('|');
const QUERY_PARAM_ALT = SECRET_QUERY_PARAMS.join('|');

const BEARER_TEST = /Bearer\s+\S+/i;
const BEARER_REDACT = /Bearer\s+\S+/gi;
const JSON_KEY_TEST = new RegExp(`"(?:${JSON_KEY_ALT})"\\s*:\\s*"[^"]+"`, 'i');
const JSON_KEY_REDACT = new RegExp(`("(?:${JSON_KEY_ALT})"\\s*:\\s*")[^"]+(")`, 'gi');
const QUERY_TEST = new RegExp(`[?&](?:${QUERY_PARAM_ALT})=[^\\s&"']+`, 'i');
const QUERY_REDACT = new RegExp(`([?&](?:${QUERY_PARAM_ALT})=)[^\\s&"']+`, 'gi');

/** The placeholder every redaction path uses, so exports look uniform no
 *  matter which path scrubbed the line. */
const REDACTION_PLACEHOLDER = '[redacted]';

/** True if the given formatted log string appears to contain a secret. */
export function containsSecret(formatted: string): boolean {
  return BEARER_TEST.test(formatted)
    || JSON_KEY_TEST.test(formatted)
    || QUERY_TEST.test(formatted);
}

/** Redact secret-bearing substrings from a log message string. Detection
 *  (containsSecret) decides WHETHER a line needs scrubbing; this does the
 *  scrubbing — the two must cover the same patterns or a detected secret
 *  would sail through to the sinks untouched. */
export function redactSecrets(message: string): string {
  return message
    .replace(BEARER_REDACT, `Bearer ${REDACTION_PLACEHOLDER}`)
    .replace(JSON_KEY_REDACT, `$1${REDACTION_PLACEHOLDER}$2`)
    .replace(QUERY_REDACT, `$1${REDACTION_PLACEHOLDER}`);
}

/** True if `line` contains any of the registered exact secret values.
 *  Values are matched as literal substrings — no pattern matching — so any
 *  token shape the SDK hands us is covered. */
export function containsKnownSecret(line: string, known: readonly string[]): boolean {
  for (const value of known) {
    if (value.length > 0 && line.includes(value)) return true;
  }
  return false;
}

/** Replace every exact occurrence of a registered secret value with the
 *  shared placeholder. Literal split/join, not RegExp — a secret must never
 *  need escaping, and a value containing regex metacharacters would
 *  otherwise corrupt the pattern. */
export function redactKnownSecrets(line: string, known: readonly string[]): string {
  let out = line;
  for (const value of known) {
    if (value.length > 0 && out.includes(value)) {
      out = out.split(value).join(REDACTION_PLACEHOLDER);
    }
  }
  return out;
}
