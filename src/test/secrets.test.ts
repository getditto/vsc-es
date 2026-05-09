import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, SECRET_KEYS } from '../logging/secrets.js';

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
