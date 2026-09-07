import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { categorizeFiles, walkDataDir, snapshot } from '../storage/DatabaseMetricsService.js';
import type { DittoManager } from '../ditto/DittoManager.js';

// ─── categorizeFiles (pure) ────────────────────────────────────

test('categorizeFiles: WAL/SHM checked before everything else (priority)', () => {
  // A `*-wal` file inside /ditto_store/ must NOT double-count into the
  // store bucket — WAL has its own bucket and the rule is "suffix wins
  // over directory."
  const b = categorizeFiles([
    { path: '/x/ditto_store/db.sqlite3-wal', sizeInBytes: 100 },
    { path: '/x/ditto_store/db.sqlite3-shm', sizeInBytes: 50 },
    { path: '/x/ditto_store/db.sqlite3',     sizeInBytes: 200 },
  ]);
  assert.equal(b.walShmBytes, 150);
  assert.equal(b.storeBytes, 200);
});

test('categorizeFiles: logs win over dir match for .log / .log.gz suffix anywhere', () => {
  const b = categorizeFiles([
    { path: '/x/ditto_logs/a.log',         sizeInBytes: 10 },
    { path: '/x/ditto_logs/rotated.log.gz', sizeInBytes: 20 },
    { path: '/x/other/stray.log',           sizeInBytes: 30 },
  ]);
  assert.equal(b.logsBytes, 60);
  assert.equal(b.otherBytes, 0);
});

test('categorizeFiles: store, replication, attachments, auth, auth_tmp buckets', () => {
  const b = categorizeFiles([
    { path: '/x/ditto_store/main.sqlite3',       sizeInBytes: 1 },
    { path: '/x/ditto_replication/peer.dat',     sizeInBytes: 2 },
    { path: '/x/ditto_attachments/abc.bin',      sizeInBytes: 4 },
    { path: '/x/ditto_auth/token.json',          sizeInBytes: 8 },
    { path: '/x/ditto_auth_tmp/staging.json',    sizeInBytes: 16 },
  ]);
  assert.equal(b.storeBytes, 1);
  assert.equal(b.replicationBytes, 2);
  assert.equal(b.attachmentsBytes, 4);
  // auth + auth_tmp both fall into the auth bucket — see /ditto_auth
  // prefix match.
  assert.equal(b.authBytes, 8 + 16);
});

test('categorizeFiles: case-insensitive path matching', () => {
  const b = categorizeFiles([
    { path: '/X/DITTO_STORE/Main.SQLITE3', sizeInBytes: 100 },
  ]);
  assert.equal(b.storeBytes, 100);
});

test('categorizeFiles: unrecognised paths go to other', () => {
  const b = categorizeFiles([
    { path: '/x/ditto_metrics/snapshot.bin',  sizeInBytes: 1 },
    { path: '/x/ditto_system_info/info.json', sizeInBytes: 2 },
    { path: '/x/lock',                         sizeInBytes: 3 },
  ]);
  assert.equal(b.otherBytes, 6);
});

test('categorizeFiles: empty input → all zeros', () => {
  const b = categorizeFiles([]);
  assert.equal(b.storeBytes, 0);
  assert.equal(b.walShmBytes, 0);
  assert.equal(b.otherBytes, 0);
});

// ─── walkDataDir (integration against tmp dir) ─────────────────

test('walkDataDir: recursive file walk with sizes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-vsce-walk-'));
  try {
    await fs.mkdir(path.join(root, 'ditto_store'), { recursive: true });
    await fs.mkdir(path.join(root, 'ditto_attachments'), { recursive: true });
    await fs.writeFile(path.join(root, 'ditto_store', 'a.sqlite3'), Buffer.alloc(123));
    await fs.writeFile(path.join(root, 'ditto_store', 'a.sqlite3-wal'), Buffer.alloc(10));
    await fs.writeFile(path.join(root, 'ditto_attachments', 'blob.bin'), Buffer.alloc(50));

    const files = await walkDataDir(root);
    const byBase = new Map(files.map(f => [path.basename(f.path), f.sizeInBytes]));
    assert.equal(byBase.get('a.sqlite3'), 123);
    assert.equal(byBase.get('a.sqlite3-wal'), 10);
    assert.equal(byBase.get('blob.bin'), 50);
    assert.equal(files.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkDataDir: missing root returns empty list (no throw)', async () => {
  const result = await walkDataDir('/this/path/very/much/does/not/exist');
  assert.deepEqual(result, []);
});

test('walkDataDir + categorizeFiles end-to-end against a tmp tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-vsce-walk-'));
  try {
    await fs.mkdir(path.join(root, 'ditto_store'), { recursive: true });
    await fs.mkdir(path.join(root, 'ditto_replication'), { recursive: true });
    await fs.mkdir(path.join(root, 'ditto_logs'), { recursive: true });
    await fs.writeFile(path.join(root, 'ditto_store', 'db.sqlite3'), Buffer.alloc(1000));
    await fs.writeFile(path.join(root, 'ditto_store', 'db.sqlite3-wal'), Buffer.alloc(200));
    await fs.writeFile(path.join(root, 'ditto_replication', 'r.dat'), Buffer.alloc(50));
    await fs.writeFile(path.join(root, 'ditto_logs', 'live.log'), Buffer.alloc(25));

    const files = await walkDataDir(root);
    const b = categorizeFiles(files);
    assert.equal(b.storeBytes, 1000);
    assert.equal(b.walShmBytes, 200);
    assert.equal(b.replicationBytes, 50);
    assert.equal(b.logsBytes, 25);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ─── snapshot: mid-switch active guard ─────────────────────────

function fakeMetricsManager(collections: string[]): {
  manager: DittoManager;
  cborCalls: string[];
  /** Flip to simulate a database switch mid-scan. */
  activeCheck: { current: boolean };
} {
  const cborCalls: string[] = [];
  const activeCheck = { current: true };
  const manager = {
    executeRaw: async (query: string) => {
      if (query.includes('system:collections')) {
        return collections.map(name => ({ name }));
      }
      return [];
    },
    cborBytesForCollection: async (quoted: string) => {
      cborCalls.push(quoted);
      // The second collection onwards find the connection switched away.
      activeCheck.current = false;
      return { documentCount: 1, totalBytes: 64 };
    },
  } as unknown as DittoManager;
  return { manager, cborCalls, activeCheck };
}

test('snapshot stops scanning collections once the active connection changes mid-flight', async () => {
  // Regression: computeCollectionBreakdown had no mid-switch guard, so a
  // refresh that outlived a database switch kept running per-collection
  // CBOR scans (the extension's most expensive operation) against the
  // freshly-connected database for results the disposed panel discarded.
  const { manager, cborCalls, activeCheck } = fakeMetricsManager(['a', 'b', 'c']);
  activeCheck.current = true;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-vsce-guard-'));
  try {
    const snap = await snapshot(manager, root, () => activeCheck.current);
    assert.equal(cborCalls.length, 1,
      'stopped after the switch instead of scanning b and c on the new database');
    assert.deepEqual(snap.collectionBreakdown.map(c => c.name), ['a']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('snapshot without a guard predicate scans every collection (back-compatible)', async () => {
  const { manager, cborCalls } = fakeMetricsManager(['a', 'b']);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-vsce-noguard-'));
  try {
    const snap = await snapshot(manager, root);
    assert.equal(cborCalls.length, 2);
    assert.equal(snap.collectionPayloadBytes, 128);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
