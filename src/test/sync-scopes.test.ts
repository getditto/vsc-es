import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCollectionSyncScopes,
  normalizeCollectionSyncScopes,
  startSyncWithCollectionScopes,
  validateCollectionSyncScopes,
} from '../ditto/sync-scopes.js';
import type { CollectionSyncScopeEntry } from '../models/DittoConfig.js';

test('applyCollectionSyncScopes skips ALTER SYSTEM when no scopes are configured', async () => {
  let calls = 0;
  await applyCollectionSyncScopes({
    async execute() { calls += 1; },
  }, []);
  assert.equal(calls, 0);
});

test('applyCollectionSyncScopes binds every supported scope as query data', async () => {
  const entries: CollectionSyncScopeEntry[] = [
    { collection: 'all_data', scope: 'AllPeers' },
    { collection: 'server_data', scope: 'BigPeerOnly' },
    { collection: 'mesh_data', scope: 'SmallPeersOnly' },
    { collection: 'private_data', scope: 'LocalPeerOnly' },
  ];
  const calls: Array<{ query: string; args?: Record<string, unknown> | undefined }> = [];
  await applyCollectionSyncScopes({
    async execute(query, args) { calls.push({ query, args }); },
  }, entries);

  assert.deepEqual(calls, [{
    query: 'ALTER SYSTEM SET USER_COLLECTION_SYNC_SCOPES = :syncScopes',
    args: {
      syncScopes: {
        all_data: 'AllPeers',
        server_data: 'BigPeerOnly',
        mesh_data: 'SmallPeersOnly',
        private_data: 'LocalPeerOnly',
      },
    },
  }]);
});

test('normalizeCollectionSyncScopes trims collection names without changing order', () => {
  assert.deepEqual(normalizeCollectionSyncScopes([
    { collection: '  orders  ', scope: 'SmallPeersOnly' },
    { collection: 'audit', scope: 'BigPeerOnly' },
  ]), [
    { collection: 'orders', scope: 'SmallPeersOnly' },
    { collection: 'audit', scope: 'BigPeerOnly' },
  ]);
});

test('validateCollectionSyncScopes rejects blank, duplicate, system, and unknown scopes', () => {
  assert.match(validateCollectionSyncScopes([
    { collection: ' ', scope: 'AllPeers' },
  ]) ?? '', /required/);
  assert.match(validateCollectionSyncScopes([
    { collection: 'orders', scope: 'AllPeers' },
    { collection: 'orders', scope: 'LocalPeerOnly' },
  ]) ?? '', /more than one/);
  assert.match(validateCollectionSyncScopes([
    { collection: '__sync_status', scope: 'LocalPeerOnly' },
  ]) ?? '', /System collection/);
  assert.match(validateCollectionSyncScopes([
    { collection: 'orders', scope: 'Unknown' as any },
  ]) ?? '', /unsupported/);
});

test('validateCollectionSyncScopes rejects malformed runtime payloads without throwing', () => {
  assert.match(validateCollectionSyncScopes({}) ?? '', /must be a list/);
  assert.match(validateCollectionSyncScopes([null]) ?? '', /must be an object/);
  assert.match(validateCollectionSyncScopes([
    { collection: null, scope: 'AllPeers' },
  ]) ?? '', /must be text/);
});

test('applyCollectionSyncScopes propagates SDK execution failures', async () => {
  await assert.rejects(
    applyCollectionSyncScopes({
      async execute() { throw new Error('scope rejected'); },
    }, [{ collection: 'orders', scope: 'LocalPeerOnly' }]),
    /scope rejected/,
  );
});

test('startSyncWithCollectionScopes preserves scope, other config, then start ordering', async () => {
  const calls: string[] = [];
  const target = {
    store: {
      async execute(query: string) { calls.push(query.includes('USER_COLLECTION') ? 'scopes' : 'other'); },
    },
    sync: { start() { calls.push('start'); } },
  };
  await startSyncWithCollectionScopes(
    target,
    [{ collection: 'orders', scope: 'SmallPeersOnly' }],
    async () => { await target.store.execute('ALTER SYSTEM SET mesh = 12'); },
  );
  assert.deepEqual(calls, ['scopes', 'other', 'start']);
});

test('startSyncWithCollectionScopes does not start sync when scope application fails', async () => {
  let started = false;
  await assert.rejects(startSyncWithCollectionScopes({
    store: { async execute() { throw new Error('rejected'); } },
    sync: { start() { started = true; } },
  }, [{ collection: 'orders', scope: 'LocalPeerOnly' }], async () => {}), /rejected/);
  assert.equal(started, false);
});
