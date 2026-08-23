import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../util/id.js';

test('randomId: default is 24 lowercase hex characters (12 bytes)', () => {
  const id = randomId();
  assert.equal(id.length, 24);
  assert.match(id, /^[0-9a-f]+$/);
});

test('randomId: byteLength controls output length', () => {
  assert.equal(randomId(8).length, 16);
  assert.equal(randomId(16).length, 32);
});

test('randomId: a batch of ids has no collisions', () => {
  // Statistical sanity, not a proof — 1000 draws at 96 bits must not repeat.
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i += 1) { ids.add(randomId()); }
  assert.equal(ids.size, 1000);
});
