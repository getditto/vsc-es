import test from 'node:test';
import assert from 'node:assert/strict';
import { newConfig, type SecretSet, type StoredDittoConfig } from '../models/DittoConfig.js';
import {
  ConnectionPersistenceError,
  assertEditorSaveIsCurrent,
  deleteConnectionAtomically,
  saveConnectionAtomically,
} from '../panels/save-connection.js';

function config(name: string): StoredDittoConfig {
  return { ...newConfig(), id: 'config-id', name, databaseId: 'database-id' };
}

test('saveConnectionAtomically persists config and secrets together', async () => {
  let storedConfig = config('old');
  let storedSecrets: SecretSet = { token: 'old-token' };
  await saveConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; },
    async delete() { throw new Error('unexpected delete'); },
  }, {
    async read() { return storedSecrets; },
    async write(_id, value) { storedSecrets = value; },
  }, config('new'), { token: 'new-token' });
  assert.equal(storedConfig.name, 'new');
  assert.equal(storedSecrets.token, 'new-token');
});

test('assertEditorSaveIsCurrent rejects cross-ID, deleted, stale, and collided saves', () => {
  const original = config('old');
  assert.throws(() => assertEditorSaveIsCurrent({
    expectedId: 'expected', incomingId: 'other', editingExisting: true, baseline: original, current: original,
  }), /identity changed/);
  assert.throws(() => assertEditorSaveIsCurrent({
    expectedId: original.id, incomingId: original.id, editingExisting: true, baseline: original, current: undefined,
  }), /deleted/);
  assert.throws(() => assertEditorSaveIsCurrent({
    expectedId: original.id, incomingId: original.id, editingExisting: true, baseline: original, current: config('newer'),
  }), /changed while/);
  assert.throws(() => assertEditorSaveIsCurrent({
    expectedId: original.id, incomingId: original.id, editingExisting: false, baseline: undefined, current: original,
  }), /already exists/);
});

test('deleteConnectionAtomically removes secrets before the config', async () => {
  let storedConfig: StoredDittoConfig | undefined = config('old');
  let storedSecrets: SecretSet = { token: 'old-token' };
  const order: string[] = [];
  await deleteConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; },
    async delete() { order.push('config'); storedConfig = undefined; },
  }, {
    async read() { return storedSecrets; },
    async write(_id, value) { storedSecrets = value; },
    async deleteAll() { order.push('secrets'); storedSecrets = { token: '' }; },
  }, 'config-id');
  assert.deepEqual(order, ['secrets', 'config']);
  assert.equal(storedConfig, undefined);
  assert.equal(storedSecrets.token, '');
});

test('deleteConnectionAtomically restores config and secrets after partial config deletion failure', async () => {
  const original = config('old');
  let storedConfig: StoredDittoConfig | undefined = original;
  let storedSecrets: SecretSet = { token: 'old-token' };
  let deletes = 0;
  await assert.rejects(deleteConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; },
    async delete() {
      storedConfig = undefined;
      if (++deletes === 1) { throw new Error('delete acknowledgement failed'); }
    },
  }, {
    async read() { return { ...storedSecrets }; },
    async write(_id, value) { storedSecrets = value; },
    async deleteAll() { storedSecrets = { token: '' }; },
  }, 'config-id'), ConnectionPersistenceError);
  assert.equal(storedConfig, original);
  assert.equal(storedSecrets.token, 'old-token');
});

test('saveConnectionAtomically restores an edited config after a partial secret failure', async () => {
  const original = config('old');
  let storedConfig = original;
  let storedSecrets: SecretSet = { token: 'old-token' };
  let secretWrites = 0;
  await assert.rejects(saveConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; },
    async delete() { throw new Error('unexpected delete'); },
  }, {
    async read() { return { ...storedSecrets }; },
    async write(_id, value) {
      secretWrites++;
      storedSecrets = value;
      if (secretWrites === 1) { throw new Error('partial SecretStorage failure'); }
    },
  }, config('new'), { token: 'new-token' }), ConnectionPersistenceError);
  assert.equal(storedConfig, original);
  assert.equal(storedSecrets.token, 'old-token');
});

test('the error names the operation that failed — delete vs save', async () => {
  // Users read this toast; "could not be saved" on a deliberate delete is
  // nonsense, so the action word is part of the message.
  let deleteErr: unknown;
  await deleteConnectionAtomically({
    get: () => config('old'),
    async save() {},
    async delete() { throw new Error('nope'); },
  }, {
    async read() { return { token: 'old-token' }; },
    async write() {},
    async deleteAll() {},
  }, 'config-id').catch((e) => { deleteErr = e; });
  assert.ok(deleteErr instanceof ConnectionPersistenceError);
  assert.match(deleteErr.message, /could not be deleted/);
  assert.doesNotMatch(deleteErr.message, /could not be saved/);

  let saveErr: unknown;
  await saveConnectionAtomically({
    get: () => config('old'),
    async save() { throw new Error('nope'); },
    async delete() {},
  }, {
    async read() { return { token: 'old-token' }; },
    async write() {},
  }, config('new'), { token: 'new-token' }).catch((e) => { saveErr = e; });
  assert.ok(saveErr instanceof ConnectionPersistenceError);
  assert.match(saveErr.message, /could not be saved/);
});

test('saveConnectionAtomically removes a newly created config after secret failure', async () => {
  let storedConfig: StoredDittoConfig | undefined;
  let deleted = false;
  await assert.rejects(saveConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; },
    async delete() { storedConfig = undefined; deleted = true; },
  }, {
    async read() { return { token: '' }; },
    async write() { throw new Error('SecretStorage unavailable'); },
  }, config('new'), { token: 'new-token' }), (error) => {
    assert.ok(error instanceof ConnectionPersistenceError);
    assert.equal(error.rollbackFailed, true);
    return true;
  });
  assert.equal(storedConfig, undefined);
  assert.equal(deleted, true);
});

test('saveConnectionAtomically does not touch secrets when config save fails', async () => {
  let secretWrites = 0;
  await assert.rejects(saveConnectionAtomically({
    get: () => config('old'),
    async save() { throw new Error('ConfigStore unavailable'); },
    async delete() {},
  }, {
    async read() { return { token: 'old-token' }; },
    async write() { secretWrites++; },
  }, config('new'), { token: 'new-token' }), ConnectionPersistenceError);
  assert.equal(secretWrites, 0);
});

test('saveConnectionAtomically restores an edited config when save mutates then rejects', async () => {
  const original = config('old');
  let storedConfig = original;
  let saves = 0;
  await assert.rejects(saveConnectionAtomically({
    get: () => storedConfig,
    async save(value) {
      storedConfig = value;
      if (++saves === 1) { throw new Error('commit acknowledgement failed'); }
    },
    async delete() {},
  }, {
    async read() { return { token: 'old-token' }; },
    async write() {},
  }, config('new'), { token: 'new-token' }), ConnectionPersistenceError);
  assert.equal(storedConfig, original);
});

test('saveConnectionAtomically deletes a new config when save mutates then rejects', async () => {
  let storedConfig: StoredDittoConfig | undefined;
  await assert.rejects(saveConnectionAtomically({
    get: () => storedConfig,
    async save(value) { storedConfig = value; throw new Error('commit acknowledgement failed'); },
    async delete() { storedConfig = undefined; },
  }, {
    async read() { return { token: '' }; },
    async write() {},
  }, config('new'), { token: 'new-token' }), ConnectionPersistenceError);
  assert.equal(storedConfig, undefined);
});
