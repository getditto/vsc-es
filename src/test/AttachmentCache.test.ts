import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentCache } from '../inspector/AttachmentCache.js';

function bytes(size: number, fill = 0xab): Buffer {
  return Buffer.alloc(size, fill);
}

test('AttachmentCache: get on empty cache returns undefined', () => {
  const c = new AttachmentCache();
  assert.equal(c.get('db1', 'att1'), undefined);
});

test('AttachmentCache: set + get roundtrip preserves bytes/mime/filename', () => {
  const c = new AttachmentCache();
  const buf = bytes(1024);
  c.set('db1', 'att1', { bytes: buf, mimeType: 'image/png', filename: 'pic.png', sizeBytes: buf.length });
  const got = c.get('db1', 'att1');
  assert.ok(got, 'expected cache hit');
  assert.equal(got!.bytes, buf);
  assert.equal(got!.mimeType, 'image/png');
  assert.equal(got!.filename, 'pic.png');
  assert.equal(got!.sizeBytes, 1024);
});

test('AttachmentCache: clearDatabase only drops entries for that database', () => {
  const c = new AttachmentCache();
  c.set('db1', 'att1', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  c.set('db1', 'att2', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  c.set('db2', 'att1', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  c.clearDatabase('db1');
  assert.equal(c.get('db1', 'att1'), undefined);
  assert.equal(c.get('db1', 'att2'), undefined);
  // db2 untouched.
  assert.ok(c.get('db2', 'att1'));
  assert.equal(c.size(), 1);
});

test('AttachmentCache: clearAll drops everything and resets totalBytes', () => {
  const c = new AttachmentCache();
  c.set('db1', 'att1', { bytes: bytes(1000), mimeType: 'image/png', sizeBytes: 1000 });
  c.set('db2', 'att2', { bytes: bytes(2000), mimeType: 'image/png', sizeBytes: 2000 });
  c.clearAll();
  assert.equal(c.size(), 0);
  assert.equal(c.getTotalBytes(), 0);
  assert.equal(c.get('db1', 'att1'), undefined);
});

test('AttachmentCache: same key written twice replaces the entry and re-accounts size', () => {
  const c = new AttachmentCache();
  c.set('db', 'a', { bytes: bytes(1000), mimeType: 'image/png', sizeBytes: 1000 });
  c.set('db', 'a', { bytes: bytes(500), mimeType: 'image/jpeg', sizeBytes: 500 });
  assert.equal(c.size(), 1);
  assert.equal(c.getTotalBytes(), 500);
  const got = c.get('db', 'a');
  assert.equal(got?.mimeType, 'image/jpeg');
});

test('AttachmentCache: LRU eviction removes oldest first when over capacity', () => {
  // Capacity 3 KB. Insert 3 × 1 KB → at capacity, all present.
  // Then insert one more → oldest is evicted.
  const c = new AttachmentCache({ maxBytes: 3 * 1024 });
  c.set('db', 'a', { bytes: bytes(1024), mimeType: 'image/png', sizeBytes: 1024 });
  c.set('db', 'b', { bytes: bytes(1024), mimeType: 'image/png', sizeBytes: 1024 });
  c.set('db', 'c', { bytes: bytes(1024), mimeType: 'image/png', sizeBytes: 1024 });
  assert.equal(c.size(), 3);
  // Touch 'a' so 'b' becomes the LRU.
  assert.ok(c.get('db', 'a'));
  c.set('db', 'd', { bytes: bytes(1024), mimeType: 'image/png', sizeBytes: 1024 });
  assert.equal(c.size(), 3);
  assert.ok(c.get('db', 'a'), 'a should survive (recently touched)');
  assert.equal(c.get('db', 'b'), undefined, 'b should be evicted (was LRU)');
  assert.ok(c.get('db', 'c'));
  assert.ok(c.get('db', 'd'));
});

test('AttachmentCache: rejects entries larger than maxBytes (no thrashing eviction)', () => {
  const c = new AttachmentCache({ maxBytes: 1024 });
  c.set('db', 'small1', { bytes: bytes(512), mimeType: 'image/png', sizeBytes: 512 });
  // 2 KB blob is bigger than the entire cache — should be rejected
  // rather than evicting everything to make room for one item that
  // immediately exceeds the cap on its own.
  c.set('db', 'huge', { bytes: bytes(2048), mimeType: 'image/png', sizeBytes: 2048 });
  assert.equal(c.get('db', 'huge'), undefined);
  assert.ok(c.get('db', 'small1'), 'existing entry must NOT be evicted by a rejected oversize insert');
  assert.equal(c.getTotalBytes(), 512);
});

test('AttachmentCache: get refreshes LRU stamp so a touched entry survives the next eviction', () => {
  const c = new AttachmentCache({ maxBytes: 200 });
  c.set('db', 'a', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  c.set('db', 'b', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  // Touch 'a' → 'b' becomes LRU.
  c.get('db', 'a');
  c.set('db', 'c', { bytes: bytes(100), mimeType: 'image/png', sizeBytes: 100 });
  assert.ok(c.get('db', 'a'));
  assert.equal(c.get('db', 'b'), undefined);
  assert.ok(c.get('db', 'c'));
});

test('AttachmentCache: totalBytes tracks set/clear correctly across many ops', () => {
  const c = new AttachmentCache({ maxBytes: 10_000 });
  c.set('db', 'a', { bytes: bytes(1000), mimeType: 'image/png', sizeBytes: 1000 });
  c.set('db', 'b', { bytes: bytes(2000), mimeType: 'image/png', sizeBytes: 2000 });
  assert.equal(c.getTotalBytes(), 3000);
  c.clearDatabase('db');
  assert.equal(c.getTotalBytes(), 0);
  c.set('db', 'a', { bytes: bytes(500), mimeType: 'image/png', sizeBytes: 500 });
  assert.equal(c.getTotalBytes(), 500);
});
