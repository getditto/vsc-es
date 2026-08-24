import { randomBytes } from 'node:crypto';

/**
 * Mint a lowercase hex identifier from a CSPRNG.
 *
 * `byteLength` controls the entropy: the output is always
 * `byteLength * 2` hex characters. Default 12 bytes (96 bits, 24 hex
 * chars) suits UI-scoped ids; callers picking ids for persisted records
 * historically used 16 bytes, in-memory-only records 8 — pass the
 * byteLength that matches the record's lifetime and blast radius.
 *
 * Never `Math.random()` for this: CSP nonces and record ids that gate
 * destructive actions must not be guessable.
 */
export function randomId(byteLength = 12): string {
  return randomBytes(byteLength).toString('hex');
}
