import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAttachments,
  attachmentContentType,
  attachmentFilename,
} from '../inspector/inspector-state.js';

// ─── detectAttachments ────────────────────────────────────────

test('detectAttachments: empty object → []', () => {
  assert.deepEqual(detectAttachments({}), []);
});

test('detectAttachments: bare {id, len, metadata} token (real SDK shape)', () => {
  const doc = {
    _id: 'task-001',
    Image2: {
      id: 'RUHqxmQe-CdOGbUU3GRvB_Im3HUMMgO25K85NPQ5c2wHqg',
      len: 153107,
      metadata: { mimeType: 'image/png', name: 'Body.png' },
    },
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'Image2');
  assert.equal(found[0].metadata.contentType, 'image/png');
  assert.equal(found[0].metadata.filename, 'Body.png');
  assert.equal(found[0].metadata.length, 153107);
  // Token round-trips for the SDK's fetchAttachment call.
  assert.equal(found[0].token.id, 'RUHqxmQe-CdOGbUU3GRvB_Im3HUMMgO25K85NPQ5c2wHqg');
  assert.equal(found[0].token.len, 153107);
});

test('detectAttachments: SDK-style metadata keys (contentType / filename)', () => {
  const doc = {
    avatar: { id: 't1', len: 100, metadata: { contentType: 'image/png', filename: 'a.png' } },
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0].metadata.contentType, 'image/png');
  assert.equal(found[0].metadata.filename, 'a.png');
});

test('detectAttachments: nested object with attachment', () => {
  const doc = {
    profile: {
      picture: { id: 't2', len: 50, metadata: { mimeType: 'image/jpeg', name: 'p.jpg' } },
    },
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'profile.picture');
});

test('detectAttachments: multiple attachments in array', () => {
  const doc = {
    photos: [
      { id: 't1', len: 10, metadata: { mimeType: 'image/png', name: '1.png' } },
      { id: 't2', len: 20, metadata: { mimeType: 'image/png', name: '2.png' } },
    ],
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 2);
  assert.equal(found[0].path, 'photos[0]');
  assert.equal(found[1].path, 'photos[1]');
});

test('detectAttachments: multiple top-level attachment fields', () => {
  // Mirrors the bug-repro doc from the user.
  const doc = {
    _id: 'task-001',
    Image2: {
      id: 'tok-img2',
      len: 153107,
      metadata: { mimeType: 'image/png', name: 'Body.png' },
    },
    characterpic: {
      id: 'tok-charpic',
      len: 1693453,
      metadata: { mimeType: 'image/png', name: 'tiefling_00001_.png' },
    },
    deleted: false,
    title: 'Set up daily standup cadence',
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(a => a.path).sort(), ['Image2', 'characterpic']);
});

test('detectAttachments: bigint `len` coerces to number (SDK quirk)', () => {
  const doc = {
    blob: { id: 't', len: BigInt(42), metadata: {} },
  };
  const found = detectAttachments(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0].metadata.length, 42);
  assert.equal(typeof found[0].token.len, 'number');
});

test('detectAttachments: not-a-token shapes are skipped', () => {
  // Plain object that happens to have an `id` but no `len`.
  assert.deepEqual(detectAttachments({ user: { id: 'u1', name: 'Joe' } }), []);
  // Has id+len but metadata is an array.
  assert.deepEqual(detectAttachments({ thing: { id: 't', len: 10, metadata: [] } }), []);
  // Has id+len+metadata but `len` is a string.
  assert.deepEqual(detectAttachments({ thing: { id: 't', len: '10', metadata: {} } }), []);
});

// ─── attachmentContentType / attachmentFilename helpers ───────

test('attachmentContentType: prefers mimeType, falls through aliases', () => {
  assert.equal(attachmentContentType({ mimeType: 'image/png' }), 'image/png');
  assert.equal(attachmentContentType({ contentType: 'image/jpeg' }), 'image/jpeg');
  assert.equal(attachmentContentType({ mime_type: 'video/mp4' }), 'video/mp4');
  assert.equal(attachmentContentType({ type: 'application/zip' }), 'application/zip');
  assert.equal(attachmentContentType({}), undefined);
});

test('attachmentFilename: prefers name, falls through aliases', () => {
  assert.equal(attachmentFilename({ name: 'a.png' }), 'a.png');
  assert.equal(attachmentFilename({ filename: 'b.png' }), 'b.png');
  assert.equal(attachmentFilename({ fileName: 'c.png' }), 'c.png');
  assert.equal(attachmentFilename({ file_name: 'd.png' }), 'd.png');
  assert.equal(attachmentFilename({}), undefined);
});
