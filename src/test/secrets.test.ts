import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, redactSecrets, SECRET_KEYS, containsKnownSecret, redactKnownSecrets } from '../logging/secrets.js';

test('containsSecret: clean message returns false', () => {
  assert.equal(containsSecret('Connected to db-A'), false);
});

test('containsSecret: bearer token literal flagged', () => {
  assert.equal(containsSecret('Authorization: Bearer abc123xyz'), true);
});

test('containsSecret: JSON-embedded "token" key flagged', () => {
  assert.equal(containsSecret('Login OK {"token":"sk_live_xxx","mode":"server"}'), true);
});

test('containsSecret: JSON-embedded secretKey flagged', () => {
  assert.equal(containsSecret('Config {"secretKey":"shh"}'), true);
});

test('SECRET_KEYS includes the documented set', () => {
  assert.ok(SECRET_KEYS.includes('token'));
  assert.ok(SECRET_KEYS.includes('secretKey'));
  assert.ok(SECRET_KEYS.includes('httpApiKey'));
});

test('containsSecret: URL query token flagged', () => {
  assert.equal(containsSecret('GET https://api.example.com/v5/store/execute?token=abc123'), true);
  assert.equal(containsSecret('wss://relay.example.com/?access_token=xyz&scope=rw'), true);
});

test('redactSecrets: every detected pattern is actually scrubbed', () => {
  // Detection without redaction is how secrets reach log exports — the
  // two must cover the same ground.
  const cases = [
    ['Authorization: Bearer abc123xyz', /abc123xyz/],
    ['Login OK {"token":"sk_live_xxx","mode":"server"}', /sk_live_xxx/],
    ['Config {"secretKey":"shh"}', /"shh"/],
    ['key is {"httpApiKey":"pk_9"}', /pk_9/],
    ['GET https://api.example.com/x?token=abc123&y=1', /abc123/],
    ['wss://relay.example.com/?access_token=xyz&scope=rw', /xyz/],
  ] as const;
  for (const [input, secret] of cases) {
    assert.equal(containsSecret(input), true, `detected: ${input}`);
    assert.doesNotMatch(redactSecrets(input), secret, `scrubbed: ${input}`);
  }
  // And the non-secret surroundings survive.
  assert.match(redactSecrets('GET https://api.example.com/x?token=abc123&y=1'), /&y=1/);
});

test('containsSecret/redactSecrets: JSON keys are matched regardless of casing', () => {
  // The query-parameter patterns were already case-insensitive; the JSON
  // ones were not, so `{"Token":"…"}` was neither detected nor scrubbed.
  for (const key of ['Token', 'TOKEN', 'SecretKey', 'HttpApiKey']) {
    const msg = `Login OK {"${key}":"sk_live_xxx"}`;
    assert.equal(containsSecret(msg), true, `detected: ${key}`);
    assert.doesNotMatch(redactSecrets(msg), /sk_live_xxx/, `scrubbed: ${key}`);
  }
});

test('containsSecret: hoisted combined patterns cover every key (regression for per-key loops)', () => {
  // The patterns compile once at module load as combined alternations; this
  // proves the combination did not drop any single key from either family.
  assert.equal(containsSecret('{"httpApiKey":"x"}'), true);
  assert.equal(containsSecret('https://h/?api_key=zzz'), true);
  assert.equal(containsSecret('https://h/?secretKey=zzz'), true);
  assert.equal(containsSecret('https://h/?httpApiKey=zzz'), true);
});

test('containsKnownSecret: literal substring match only', () => {
  const known = ['sk_live_abcdef123', 'token.with*metachars'];
  assert.equal(containsKnownSecret('connecting with sk_live_abcdef123 ok', known), true);
  // Regex metacharacters in a secret must be matched literally, not as a pattern.
  assert.equal(containsKnownSecret('value token.with*metachars here', known), true);
  assert.equal(containsKnownSecret('nothing to see here', known), false);
  assert.equal(containsKnownSecret('anything', []), false);
  assert.equal(containsKnownSecret('value ', ['']), false);
});

test('redactKnownSecrets: replaces every exact occurrence with the shared placeholder', () => {
  const known = ['sk_live_abcdef123'];
  assert.equal(
    redactKnownSecrets('a sk_live_abcdef123 b sk_live_abcdef123 c', known),
    'a [redacted] b [redacted] c',
  );
  // Non-matching text passes through untouched.
  assert.equal(redactKnownSecrets('clean line', known), 'clean line');
  // Overlapping values: callers pass them longest-first so a prefix value
  // cannot destroy the longer one.
  const out = redactKnownSecrets('sk_live_abcdef123', ['sk_live_abcdef123', 'sk_live']);
  assert.equal(out, '[redacted]');
});
