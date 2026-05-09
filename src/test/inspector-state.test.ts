import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAttachments } from '../inspector/inspector-state.js';

test('detectAttachments: empty object → []', () => {
  assert.deepEqual(detectAttachments({}), []);
});

test('detectAttachments: single top-level attachment field', () => {
  const doc = { _id: 'x', avatar: { _meta: { id: 'tok1', length: 100, contentType: 'image/png', filename: 'a.png' } } };
  const found = detectAttachments(doc);
  assert.equal(found.length, 1);
  assert.equal(found[0].metadata.filename, 'a.png');
});

test('detectAttachments: nested object with attachment', () => {
  const doc = { profile: { picture: { _meta: { id: 'tok2', length: 50, contentType: 'image/jpeg', filename: 'p.jpg' } } } };
  assert.equal(detectAttachments(doc).length, 1);
});

test('detectAttachments: multiple attachments in array', () => {
  const doc = {
    photos: [
      { _meta: { id: 't1', length: 10, contentType: 'image/png', filename: '1.png' } },
      { _meta: { id: 't2', length: 20, contentType: 'image/png', filename: '2.png' } },
    ],
  };
  assert.equal(detectAttachments(doc).length, 2);
});
