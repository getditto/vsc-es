/** Identifier names whose values are secrets and must never reach a sink. */
export const SECRET_KEYS = ['token', 'secretKey', 'httpApiKey'] as const;

/** True if the given formatted log string appears to contain a secret. */
export function containsSecret(formatted: string): boolean {
  if (/Bearer\s+\S+/i.test(formatted)) return true;
  for (const key of SECRET_KEYS) {
    // Match `"key":"<non-empty>"` in JSON context.
    const re = new RegExp(`"${key}"\\s*:\\s*"[^"]+"`);
    if (re.test(formatted)) return true;
  }
  return false;
}
