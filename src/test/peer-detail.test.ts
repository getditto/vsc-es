import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLastUpdateMs, metadataKeySummary } from '../../webview-ui/presence-graph/peer-detail.js';

// ─── metadataKeySummary ─────────────────────────────────────────

test('metadataKeySummary: no keys is undefined (the row shows —), one is singular', () => {
  assert.equal(metadataKeySummary(0), undefined);
  assert.equal(metadataKeySummary(1), '1 key');
  assert.equal(metadataKeySummary(7), '7 keys');
});

// ─── formatLastUpdateMs (SwiftUI formattedLastUpdate parity) ────

const NOW = new Date('2026-09-06T17:00:00Z').getTime();

test('formatLastUpdateMs: nothing to show is undefined (the row shows never)', () => {
  assert.equal(formatLastUpdateMs(undefined, NOW), undefined);
  assert.equal(formatLastUpdateMs(0, NOW), undefined);
});

test('formatLastUpdateMs: under a minute is "Just now"', () => {
  assert.equal(formatLastUpdateMs(NOW - 59_000, NOW), 'Just now');
});

test('formatLastUpdateMs: minutes then hours are relative', () => {
  assert.equal(formatLastUpdateMs(NOW - 120_000, NOW), '2 min ago');
  assert.equal(formatLastUpdateMs(NOW - 3_599_000, NOW), '59 min ago');
  assert.equal(formatLastUpdateMs(NOW - 3_600_000, NOW), '1 hr ago');
  assert.equal(formatLastUpdateMs(NOW - (2 * 3_600_000 + 5 * 60_000), NOW), '2 hr ago');
});

test('formatLastUpdateMs: older than a day (or in the future) is absolute', () => {
  const old = NOW - 2 * 86_400_000;
  const expected = new Date(old).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  assert.equal(formatLastUpdateMs(old, NOW), expected);
  // A small clock skew must not render as a negative duration.
  assert.equal(formatLastUpdateMs(NOW + 60_000, NOW),
    new Date(NOW + 60_000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
});
