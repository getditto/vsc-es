import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNs, percentOfTotal } from '../util/profileTimeFormatter.js';

test('formatNs: milliseconds for >= 1ms', () => {
  assert.equal(formatNs(432_430_000), '432.43 ms');
  assert.equal(formatNs(1_000_000), '1.00 ms');
});

test('formatNs: microseconds for >= 1µs and < 1ms', () => {
  assert.equal(formatNs(55_560), '55.56 µs');
  assert.equal(formatNs(1_000), '1.00 µs');
  assert.equal(formatNs(999_999), '1000.00 µs');
});

test('formatNs: nanoseconds for < 1µs', () => {
  assert.equal(formatNs(209), '209 ns');
  assert.equal(formatNs(0), '0 ns');
  assert.equal(formatNs(999), '999 ns');
});

test('formatNs: negative values render with a leading minus and pick unit by magnitude', () => {
  assert.equal(formatNs(-55_560), '-55.56 µs');
  assert.equal(formatNs(-209), '-209 ns');
});

test('formatNs: nil-ish renders as em dash', () => {
  assert.equal(formatNs(null), '—');
  assert.equal(formatNs(undefined), '—');
});

test('percentOfTotal: above threshold returns formatted percent', () => {
  assert.equal(percentOfTotal(50, 100), '50.0%');
  assert.equal(percentOfTotal(133, 1000), '13.3%');
});

test('percentOfTotal: nil ns or zero total returns null', () => {
  assert.equal(percentOfTotal(null, 100), null);
  assert.equal(percentOfTotal(undefined, 100), null);
  assert.equal(percentOfTotal(10, 0), null);
  assert.equal(percentOfTotal(10, -1), null);
});

test('percentOfTotal: below threshold returns null', () => {
  // default threshold is 0.05 (5%)
  assert.equal(percentOfTotal(4, 100), null);
  assert.equal(percentOfTotal(5, 100), '5.0%');
});

test('percentOfTotal: explicit zero threshold lets every value through', () => {
  assert.equal(percentOfTotal(1, 1000, 0), '0.1%');
});
