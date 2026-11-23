import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretStore } from '../storage/SecretStore.js';
import type { SecretSet } from '../models/DittoConfig.js';

class FakeSecretStorage {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

test('write() then read() returns the saved secrets', async () => {
  const store = new SecretStore(new FakeSecretStorage());
  const secrets: SecretSet = { token: 't', secretKey: 'sk', httpApiKey: 'hk', encryptionKey: 'test-value' };
  await store.write('cfg-1', secrets);
  assert.deepEqual(await store.read('cfg-1'), secrets);
});

test('read() returns empty object when nothing stored', async () => {
  const store = new SecretStore(new FakeSecretStorage());
  assert.deepEqual(await store.read('cfg-1'), { token: '' });
});

test('write() with optional fields undefined deletes them', async () => {
  const store = new SecretStore(new FakeSecretStorage());
  await store.write('cfg-1', { token: 't', secretKey: 'sk', httpApiKey: 'hk' });
  await store.write('cfg-1', { token: 't2' });
  const s = await store.read('cfg-1');
  assert.equal(s.token, 't2');
  assert.equal(s.secretKey, undefined);
  assert.equal(s.httpApiKey, undefined);
});

test('deleteAll(id) clears every secret for that id', async () => {
  const store = new SecretStore(new FakeSecretStorage());
  await store.write('cfg-1', { token: 't', secretKey: 'sk', httpApiKey: 'hk', encryptionKey: 'test-value' });
  await store.deleteAll('cfg-1');
  const s = await store.read('cfg-1');
  assert.equal(s.token, '');
  assert.equal(s.secretKey, undefined);
  assert.equal(s.httpApiKey, undefined);
  assert.equal(s.encryptionKey, undefined);
});
