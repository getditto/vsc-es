/** Identifier names whose values are secrets and must never reach a sink. */
export const SECRET_KEYS = ['token', 'secretKey', 'httpApiKey'] as const;

/** URL query-parameter names that carry credentials (SDK auth/transport
 *  logs are where token-bearing URLs show up). */
const SECRET_QUERY_PARAMS = ['token', 'access_token', 'api_key', 'secretKey', 'httpApiKey'] as const;

function jsonKeyPattern(key: string): RegExp {
  // Match `"key":"<non-empty>"` in JSON context.
  return new RegExp(`"${key}"\\s*:\\s*"[^"]+"`);
}

function queryParamPattern(key: string): RegExp {
  return new RegExp(`[?&]${key}=[^\\s&"']+`, 'i');
}

/** True if the given formatted log string appears to contain a secret. */
export function containsSecret(formatted: string): boolean {
  if (/Bearer\s+\S+/i.test(formatted)) return true;
  for (const key of SECRET_KEYS) {
    if (jsonKeyPattern(key).test(formatted)) return true;
  }
  for (const key of SECRET_QUERY_PARAMS) {
    if (queryParamPattern(key).test(formatted)) return true;
  }
  return false;
}

/** Redact secret-bearing substrings from a log message string. Detection
 *  (containsSecret) decides WHETHER a line needs scrubbing; this does the
 *  scrubbing — the two must cover the same patterns or a detected secret
 *  would sail through to the sinks untouched. */
export function redactSecrets(message: string): string {
  let out = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  for (const key of SECRET_KEYS) {
    out = out.replace(
      new RegExp(`("${key}"\\s*:\\s*")[^"]+(")`, 'g'),
      '$1[redacted]$2',
    );
  }
  for (const key of SECRET_QUERY_PARAMS) {
    out = out.replace(
      new RegExp(`([?&]${key}=)[^\\s&"']+`, 'gi'),
      '$1[redacted]',
    );
  }
  return out;
}
