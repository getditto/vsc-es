import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCollectionName,
  isSystemCollection,
  toImportableSubscriptions,
  type SmallPeerInfo,
} from '../ditto/import-subscription-parser.js';
import type { StoredSubscription } from '../models/DittoConfig.js';

// ─── extractCollectionName ────────────────────────────────────────────

test('extractCollectionName: SELECT * FROM <name>', () => {
  assert.equal(extractCollectionName('SELECT * FROM tasks'), 'tasks');
});

test('extractCollectionName: case-insensitive on FROM keyword', () => {
  assert.equal(extractCollectionName('select * from tasks'), 'tasks');
});

test('extractCollectionName: SELECT * FROM COLLECTION <name>', () => {
  assert.equal(extractCollectionName('SELECT * FROM COLLECTION __presence WHERE x = 1'), '__presence');
});

test('extractCollectionName: ignores extra whitespace', () => {
  assert.equal(extractCollectionName('SELECT  *  FROM   tasks'), 'tasks');
});

test('extractCollectionName: returns null when no FROM clause', () => {
  assert.equal(extractCollectionName('UPDATE tasks SET done = true'), null);
});

test('extractCollectionName: a backticked name survives verbatim, whitespace included', () => {
  // A whitespace-first split would cut `my coll` in half; the token must come
  // back whole so callers can unquote + re-quote for DQL construction.
  assert.equal(extractCollectionName('SELECT * FROM `my coll`'), '`my coll`');
  assert.equal(extractCollectionName('SELECT * FROM COLLECTION `my coll`'), '`my coll`');
  assert.equal(extractCollectionName('SELECT * FROM `odd``tick`'), '`odd``tick`');
  assert.equal(extractCollectionName('SELECT * FROM `my coll`  WHERE x = 1'), '`my coll`');
});

// ─── isSystemCollection ───────────────────────────────────────────────

test('isSystemCollection: __ prefix matches', () => {
  assert.equal(isSystemCollection('__small_peer_info'), true);
  assert.equal(isSystemCollection('__presence'), true);
});

test('isSystemCollection: user collections do not match', () => {
  assert.equal(isSystemCollection('tasks'), false);
  assert.equal(isSystemCollection('_legacy'), false); // single underscore is NOT system
});

// ─── toImportableSubscriptions ────────────────────────────────────────

const peer = (overrides: Partial<SmallPeerInfo> = {}): SmallPeerInfo => ({
  _id: 'peer-1',
  device_name: 'iPhone 15',
  ditto_sdk_platform: 'iOS',
  ditto_sdk_version: '4.7.0',
  local_subscriptions: { queries: [] },
  ...overrides,
});

const sub = (id: string, query: string): StoredSubscription => ({ id, name: id, query });

test('toImportableSubscriptions: simple happy path', () => {
  const peers: SmallPeerInfo[] = [
    peer({ local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] } }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.collectionName, 'tasks');
  assert.equal(result[0]?.query, 'SELECT * FROM tasks');
  assert.equal(result[0]?.deviceName, 'iPhone 15');
  assert.equal(result[0]?.deviceInfo, 'iOS 4.7.0');
});

test('toImportableSubscriptions: filters out system collections', () => {
  const peers: SmallPeerInfo[] = [
    peer({
      local_subscriptions: {
        queries: [
          { query: 'SELECT * FROM tasks' },
          { query: 'SELECT * FROM __small_peer_info' },
          { query: 'SELECT * FROM COLLECTION __presence' },
        ],
      },
    }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.collectionName, 'tasks');
});

test('toImportableSubscriptions: filters out queries already in local store', () => {
  const peers: SmallPeerInfo[] = [
    peer({
      local_subscriptions: {
        queries: [
          { query: 'SELECT * FROM tasks' },
          { query: 'SELECT * FROM users' },
        ],
      },
    }),
  ];
  const existing = [sub('s1', 'SELECT * FROM tasks')];
  const result = toImportableSubscriptions(peers, existing);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.collectionName, 'users');
});

test('toImportableSubscriptions: dedupes identical queries across peers (keeps first peer)', () => {
  const peers: SmallPeerInfo[] = [
    peer({
      _id: 'peer-A',
      device_name: 'Alpha',
      local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] },
    }),
    peer({
      _id: 'peer-B',
      device_name: 'Beta',
      local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] },
    }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.deviceName, 'Alpha');
});

test('toImportableSubscriptions: id is stable across runs (derived from query)', () => {
  const peers: SmallPeerInfo[] = [
    peer({ local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] } }),
  ];
  const a = toImportableSubscriptions(peers, []);
  const b = toImportableSubscriptions(peers, []);
  assert.equal(a[0]?.id, b[0]?.id);
});

test('toImportableSubscriptions: falls back to peer _id when device_name missing', () => {
  const peers: SmallPeerInfo[] = [
    peer({
      _id: 'abc-123',
      device_name: undefined,
      local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] },
    }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result[0]?.deviceName, 'abc-123');
});

test('toImportableSubscriptions: skips peers with no local_subscriptions', () => {
  const peers: SmallPeerInfo[] = [
    peer({ local_subscriptions: undefined }),
    peer({
      _id: 'peer-2',
      local_subscriptions: { queries: [{ query: 'SELECT * FROM tasks' }] },
    }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result.length, 1);
});

test('toImportableSubscriptions: skips queries with no FROM clause', () => {
  const peers: SmallPeerInfo[] = [
    peer({ local_subscriptions: { queries: [{ query: 'NOT A REAL DQL' }] } }),
  ];
  const result = toImportableSubscriptions(peers, []);
  assert.equal(result.length, 0);
});
