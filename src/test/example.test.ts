import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConfig } from '../models/DittoConfig.js';

test('newConfig returns a default config', () => {
  const c = newConfig();
  assert.equal(c.mode, 'server');
  assert.equal(c.allowUntrustedCerts, false);
  assert.equal(c.logLevel, 'info');
});
