import test from 'node:test';
import assert from 'node:assert/strict';
import { PatternEngine, type RawPattern } from '../logAnalyzer/PatternEngine.js';
import type { LogLine } from '../logAnalyzer/types.js';

function line(over: Partial<LogLine> = {}): LogLine {
  return { id: 1, timestamp: null, level: 'info', tag: null, raw: '', text: '', ...over };
}

const fakeStore = (bundled: Record<string, RawPattern>, user: Record<string, RawPattern> = {}) => ({
  listAll: () => ({
    bundled: Object.entries(bundled).map(([key, p]) => ({ key, ...p })),
    user: Object.entries(user).map(([key, p]) => ({ key, ...p })),
  }),
});

test('PatternEngine: scans line and returns matched keys', () => {
  const engine = new PatternEngine(fakeStore({
    foo: { pattern: 'foo', severity: 3, recommendation: 'fix foo' },
  }));
  engine.load();
  const hits = engine.scan(line({ text: 'this is a foo error' }));
  assert.deepEqual(hits.map(p => p.key), ['foo']);
});

test('PatternEngine: silently drops patterns with empty recommendation', () => {
  const engine = new PatternEngine(fakeStore({
    noRec: { pattern: 'norec', severity: 3, recommendation: '' },
  }));
  engine.load();
  assert.deepEqual(engine.scan(line({ text: 'norec' })), []);
});

test('PatternEngine: level_filter short-circuits unmatched lines', () => {
  const engine = new PatternEngine(fakeStore({
    onlyErr: { pattern: 'boom', severity: 4, recommendation: 'r', level_filter: 'error' },
  }));
  engine.load();
  assert.equal(engine.scan(line({ level: 'info', text: 'boom' })).length, 0);
  assert.equal(engine.scan(line({ level: 'error', text: 'boom' })).length, 1);
});

test('PatternEngine: tag_filter restricts to matching tags', () => {
  const engine = new PatternEngine(fakeStore({
    sdkOnly: { pattern: 'x', severity: 3, recommendation: 'r', tag_filter: '^sdk$' },
  }));
  engine.load();
  assert.equal(engine.scan(line({ tag: 'ext:Foo', text: 'x' })).length, 0);
  assert.equal(engine.scan(line({ tag: 'sdk', text: 'x' })).length, 1);
});

test('PatternEngine: user overrides bundled by key', () => {
  const engine = new PatternEngine(fakeStore(
    { same: { pattern: 'bundled-only', severity: 3, recommendation: 'r1' } },
    { same: { pattern: 'user-wins', severity: 4, recommendation: 'r2' } },
  ));
  engine.load();
  const hits = engine.scan(line({ text: 'user-wins' }));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.severity, 4);
});

test('PatternEngine: invalid regex skips entry, other patterns still load', () => {
  const engine = new PatternEngine(fakeStore({
    good: { pattern: 'ok', severity: 3, recommendation: 'r' },
    bad:  { pattern: '[unterminated', severity: 3, recommendation: 'r' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys().sort(), ['good']);
});

test('PatternEngine: invalid severity skips entry', () => {
  const engine = new PatternEngine(fakeStore({
    good: { pattern: 'ok', severity: 3, recommendation: 'r' },
    bad:  { pattern: 'x', severity: 9, recommendation: 'r' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys().sort(), ['good']);
});

test('PatternEngine: case-insensitive matching', () => {
  const engine = new PatternEngine(fakeStore({
    k: { pattern: 'connection refused', severity: 4, recommendation: 'r' },
  }));
  engine.load();
  assert.equal(engine.scan(line({ text: 'Connection REFUSED' })).length, 1);
});

test('PatternEngine: empty catalog returns no hits', () => {
  const engine = new PatternEngine(fakeStore({}));
  engine.load();
  assert.deepEqual(engine.scan(line({ text: 'anything' })), []);
});

test('PatternEngine: reload() re-reads from store', () => {
  let bundled = { v1: { pattern: 'v1', severity: 3, recommendation: 'r' } };
  const store = { listAll: () => ({
    bundled: Object.entries(bundled).map(([key, p]) => ({ key, ...p })),
    user: [],
  }) };
  const engine = new PatternEngine(store);
  engine.load();
  assert.deepEqual(engine.listKeys(), ['v1']);
  bundled = { v2: { pattern: 'v2', severity: 3, recommendation: 'r' } } as any;
  engine.reload();
  assert.deepEqual(engine.listKeys(), ['v2']);
});

test('PatternEngine: rejects a user pattern that nests a quantifier', () => {
  // `(\w+\s*)+` backtracks exponentially. scan() runs on the extension
  // host's only thread against lines up to 16 KB, so compiling this would
  // hand a workspace-supplied pattern file a way to wedge the host.
  const engine = new PatternEngine(fakeStore({}, {
    evil: { pattern: '(\\w+\\s*)+$', severity: 3, recommendation: 'boom' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys(), []);
  assert.deepEqual(engine.listRejected().map(r => r.key), ['evil']);
  assert.match(engine.listRejected()[0]?.reason ?? '', /backtrack/);
});

test('PatternEngine: bundled patterns skip the nested-quantifier check', () => {
  // Ours, and covered by the fixture tests — the heuristic is for untrusted
  // input, and must not be able to silently disable a shipped pattern.
  const engine = new PatternEngine(fakeStore({
    ours: { pattern: '(\\w+\\s*)+$', severity: 3, recommendation: 'fine' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys(), ['ours']);
  assert.deepEqual(engine.listRejected(), []);
});

test('PatternEngine: rejects an over-long user pattern', () => {
  const engine = new PatternEngine(fakeStore({}, {
    huge: { pattern: 'a'.repeat(513), severity: 3, recommendation: 'x' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys(), []);
  assert.match(engine.listRejected()[0]?.reason ?? '', /512 characters/);
});

test('PatternEngine: rejects a missing or empty pattern rather than matching everything', () => {
  // `new RegExp(undefined)` is `/(?:)/`, which matches every line — a
  // malformed entry would otherwise turn every log line into a problem.
  const engine = new PatternEngine(fakeStore({}, {
    empty: { pattern: '', severity: 3, recommendation: 'x' },
    missing: { severity: 3, recommendation: 'x' } as unknown as RawPattern,
  }));
  engine.load();
  assert.deepEqual(engine.listKeys(), []);
  assert.equal(engine.listRejected().length, 2);
});

test('PatternEngine: a legitimate alternation group is not mistaken for a nested quantifier', () => {
  const engine = new PatternEngine(fakeStore({}, {
    ok: { pattern: '(error|warning)+ code=\\d+', severity: 3, recommendation: 'x' },
  }));
  engine.load();
  assert.deepEqual(engine.listKeys(), ['ok']);
});
