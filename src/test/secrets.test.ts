import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, redactSecrets, SECRET_KEYS } from '../logging/secrets.js';

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
