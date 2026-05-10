import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  CountBadgeDecorationProvider,
  makeCountUri,
  COUNT_BADGE_SCHEME,
} from '../tree/CountBadgeDecorationProvider.js';

test('makeCountUri uses the ditto-count scheme and encodes count in the query', () => {
  const uri = makeCountUri('subs/dbA', 7);
  assert.equal(uri.scheme, COUNT_BADGE_SCHEME);
  assert.equal(uri.path, '/subs/dbA');
  assert.equal(uri.query, 'count=7');
});

test('decoration provider returns the count as a 1-2 char badge for small counts', () => {
  const provider = new CountBadgeDecorationProvider();
  const dec = provider.provideFileDecoration(makeCountUri('idxs/dbA/tasks', 3), undefined as any);
  assert.ok(dec, 'expected a decoration');
  assert.equal(dec!.badge, '3');
  assert.equal(dec!.tooltip, '3');
});

test('decoration provider caps the badge at "99" but keeps the full count in the tooltip', () => {
  const provider = new CountBadgeDecorationProvider();
  const dec = provider.provideFileDecoration(makeCountUri('docs/dbA/users', 247), undefined as any);
  assert.ok(dec);
  assert.equal(dec!.badge, '99');
  // Tooltip must surface the actual number so the chip cap doesn't lie.
  assert.match(String(dec!.tooltip), /247/);
});

test('decoration provider returns undefined for non-ditto-count URIs', () => {
  const provider = new CountBadgeDecorationProvider();
  const dec = provider.provideFileDecoration(vscode.Uri.parse('file:///tmp/foo'), undefined as any);
  assert.equal(dec, undefined);
});

test('decoration provider returns undefined when count is zero or missing', () => {
  const provider = new CountBadgeDecorationProvider();
  const zero = provider.provideFileDecoration(makeCountUri('subs/dbA', 0), undefined as any);
  assert.equal(zero, undefined);
  const noCount = vscode.Uri.from({ scheme: COUNT_BADGE_SCHEME, path: '/foo' });
  assert.equal(provider.provideFileDecoration(noCount, undefined as any), undefined);
});
