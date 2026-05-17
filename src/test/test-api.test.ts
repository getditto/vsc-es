import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigFromEnv } from '../test-api/index.js';

test('buildConfigFromEnv: returns config when all four env vars are set', () => {
  const env = {
    DITTO_CI_DATABASE_ID: 'db-123',
    DITTO_CI_DEVELOPMENT_TOKEN: 'tok-abc',
    DITTO_CI_URL: 'https://example.ditto.live',
    DITTO_CI_WEBSOCKET_URL: 'wss://example.ditto.live',
    DITTO_CI_SITE_NAME: 'ci-run-1-darwin-arm64',
  };
  const { config, secrets } = buildConfigFromEnv(env);
  assert.equal(config.databaseId, 'db-123');
  assert.equal(config.authUrl, 'https://example.ditto.live');
  assert.equal(config.websocketUrl, 'wss://example.ditto.live');
  assert.equal(config.mode, 'server');
  assert.equal(config.name, 'ci-run-1-darwin-arm64');
  assert.equal(secrets.token, 'tok-abc');
});

test('buildConfigFromEnv: throws with clear message when DATABASE_ID missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_URL: 'u', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_DATABASE_ID/,
  );
});

test('buildConfigFromEnv: throws when DEVELOPMENT_TOKEN missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_URL: 'u', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_DEVELOPMENT_TOKEN/,
  );
});

test('buildConfigFromEnv: throws when URL missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_WEBSOCKET_URL: 'w' }),
    /DITTO_CI_URL/,
  );
});

test('buildConfigFromEnv: throws when WEBSOCKET_URL missing', () => {
  assert.throws(
    () => buildConfigFromEnv({ DITTO_CI_DATABASE_ID: 'd', DITTO_CI_DEVELOPMENT_TOKEN: 't', DITTO_CI_URL: 'u' }),
    /DITTO_CI_WEBSOCKET_URL/,
  );
});

test('buildConfigFromEnv: throws when DATABASE_ID is whitespace-only', () => {
  assert.throws(
    () => buildConfigFromEnv({
      DITTO_CI_DATABASE_ID: '   ',
      DITTO_CI_DEVELOPMENT_TOKEN: 't',
      DITTO_CI_URL: 'u',
      DITTO_CI_WEBSOCKET_URL: 'w',
    }),
    /DITTO_CI_DATABASE_ID/,
  );
});
