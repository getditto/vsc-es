import test from 'node:test';
import assert from 'node:assert/strict';
import { binVolumeByLevel, binProblemsOverTime, binDurations, pickBinWidth } from '../logAnalyzer/Histograms.js';

const L = (iso: string, level: any) => ({
  id: 1, timestamp: new Date(iso), level, tag: null, raw: '', text: '',
});

test('pickBinWidth: returns 1s for ranges <40s', () => {
  assert.equal(pickBinWidth(30 * 1000), 1000);
});

test('pickBinWidth: returns 5s for medium range', () => {
  assert.equal(pickBinWidth(120 * 1000), 5000);
});

test('pickBinWidth: returns one of NICE_BINS_MS for any range', () => {
  // For a 1-hour range with target=40, want ≈ 90_000ms; next NICE_BIN ≥ that is 300_000.
  assert.equal(pickBinWidth(60 * 60 * 1000), 300_000);
});

test('binVolumeByLevel: stacks by level into time bins', () => {
  // Four timestamps across four distinct 10s windows (0s, 10s, 20s, 30s).
  // bins[0] gets both an error and a warn (co-located in the 14:00:00 window).
  const lines = [
    L('2026-06-09T14:00:00.000Z', 'error'),
    L('2026-06-09T14:00:05.000Z', 'warn'),  // same bin as previous (0-10s window)
    L('2026-06-09T14:00:10.000Z', 'warn'),  // bins[1] (10-20s window)
    L('2026-06-09T14:00:20.000Z', 'debug'), // bins[2] (20-30s window)
    L('2026-06-09T14:00:30.000Z', 'info'),  // bins[3] (30-40s window)
  ];
  const bins = binVolumeByLevel(lines, 10_000);
  assert.equal(bins.length, 4);
  assert.equal(bins[0]?.counts.error, 1);
  assert.equal(bins[0]?.counts.warn, 1);
  assert.equal(bins[1]?.counts.warn, 1);
  assert.equal(bins[3]?.counts.info, 1);
});

test('binVolumeByLevel: empty input → empty bins', () => {
  assert.deepEqual(binVolumeByLevel([], 1000), []);
});

test('binProblemsOverTime: bin colored by max severity', () => {
  const ts = new Date('2026-06-09T14:00:00.000Z');
  const problems = [
    { time: ts, severity: 3 as const },
    { time: ts, severity: 5 as const },
  ];
  const bins = binProblemsOverTime(problems, 1000);
  assert.equal(bins.length, 1);
  assert.equal(bins[0]?.count, 2);
  assert.equal(bins[0]?.maxSeverity, 5);
});

test('binDurations: log-bins 0-1, 1-5, 5-30, 30-300, 300+', () => {
  const sessions = [
    { duration: 0.5 }, { duration: 0.9 },
    { duration: 2 },
    { duration: 20 },
    { duration: 100 },
    { duration: 1000 },
  ];
  const bins = binDurations(sessions);
  const get = (label: string) => bins.find(b => b.binLabel === label)?.count;
  assert.equal(get('0–1s'), 2);
  assert.equal(get('1–5s'), 1);
  assert.equal(get('5–30s'), 1);
  assert.equal(get('30s–5m'), 1);
  assert.equal(get('5m+'), 1);
});

test('binDurations: empty input → all bins zero', () => {
  const bins = binDurations([]);
  assert.equal(bins.length, 5);
  for (const b of bins) assert.equal(b.count, 0);
});
