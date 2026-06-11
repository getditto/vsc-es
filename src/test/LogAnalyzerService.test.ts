import test from 'node:test';
import assert from 'node:assert/strict';
import { LogAnalyzerService } from '../logAnalyzer/LogAnalyzerService.js';
import { AnalyzerSink } from '../logAnalyzer/AnalyzerSink.js';
import { PatternEngine } from '../logAnalyzer/PatternEngine.js';
import { ConnectionTracker } from '../logAnalyzer/ConnectionTracker.js';

function makeSvc(opts: { throttleMs?: number } = {}) {
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({
    listAll: () => ({
      bundled: [{ key: 'deadlock_critical', pattern: 'deadlock', severity: 5, recommendation: 'fix' }],
      user: [],
    }),
  });
  engine.load();
  const tracker = new ConnectionTracker();
  const svc = new LogAnalyzerService({ sink, engine, tracker, throttleMs: opts.throttleMs ?? 0 });
  return { svc, sink };
}

test('Service: scans live line and registers problem', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock in transaction');
  const state = svc.getStateForTesting();
  assert.equal(state.problems.get('deadlock_critical')?.length, 1);
});

test('Service: user_tag from matched pattern propagates to line.userTags', () => {
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({
    listAll: () => ({
      bundled: [
        { key: 'k1', pattern: 'foo', severity: 3, recommendation: 'r', user_tag: 'query' },
        { key: 'k2', pattern: 'foo', severity: 3, recommendation: 'r', user_tag: 'auth' },
        { key: 'k3', pattern: 'foo', severity: 3, recommendation: 'r' }, // no user_tag
      ],
      user: [],
    }),
  });
  engine.load();
  const svc = new LogAnalyzerService({ sink, engine, tracker: new ConnectionTracker(), throttleMs: 0 });
  svc.start();
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  foo something');
  const lines = svc.queryLines({ filter: 'all' }).items;
  assert.equal(lines.length, 1);
  // Sorted + deduped; the no-user_tag pattern contributes nothing.
  assert.deepEqual(lines[0].userTags, ['auth', 'query']);
});

test('Service: queryLines search matches against user tags', () => {
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({
    listAll: () => ({
      bundled: [
        { key: 'q', pattern: 'foo', severity: 3, recommendation: 'r', user_tag: 'query' },
      ],
      user: [],
    }),
  });
  engine.load();
  const svc = new LogAnalyzerService({ sink, engine, tracker: new ConnectionTracker(), throttleMs: 0 });
  svc.start();
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  foo happened');
  sink.write('info', '2026-06-09T14:00:01.000Z  INFO   [sdk]  unrelated line');
  const r = svc.queryLines({ filter: 'all', search: 'query' });
  // 'query' substring matches via line.userTags (the user-applied label)
  // on line 1, and does NOT match line 2 (no foo → no pattern hit → no tag).
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].text, /foo/);
});

test('Service: backfill text is processed before live', () => {
  const { svc } = makeSvc();
  svc.start({
    backfillText: [
      '2026-06-09T14:00:00.000Z  INFO   [sdk]  msg one',
      '2026-06-09T14:00:01.000Z  INFO   [sdk]  msg two',
    ].join('\n'),
  });
  const state = svc.getStateForTesting();
  assert.equal(state.counts.totalLines, 2);
});

test('Service: backfill skips lines older than minTimestamp', () => {
  const { svc } = makeSvc();
  // Connect time is 14:00:30 — only the two lines at/after that should
  // be admitted. The older 14:00:00 line is dropped silently.
  svc.start({
    minTimestamp: new Date('2026-06-09T14:00:30.000Z'),
    backfillText: [
      '2026-06-09T14:00:00.000Z  INFO   [sdk]  old',
      '2026-06-09T14:00:30.000Z  INFO   [sdk]  at-cutoff',
      '2026-06-09T14:00:45.000Z  INFO   [sdk]  newer',
    ].join('\n'),
  });
  const state = svc.getStateForTesting();
  assert.equal(state.counts.totalLines, 2);
});

test('Service: backfill drops lines with no parsed timestamp when a cutoff is set', () => {
  const { svc } = makeSvc();
  svc.start({
    minTimestamp: new Date('2026-06-09T14:00:00.000Z'),
    backfillText: [
      '2026-06-09T14:00:30.000Z  INFO   [sdk]  ok',
      'not a real log line at all',  // line.timestamp === null
    ].join('\n'),
  });
  // Only the well-formed line passes; we refuse to admit lines we can't
  // prove belong to the connection.
  assert.equal(svc.getStateForTesting().counts.totalLines, 1);
});

test('Service: backfill without minTimestamp admits every parseable line (legacy behavior)', () => {
  const { svc } = makeSvc();
  svc.start({
    backfillText: [
      '2020-01-01T00:00:00.000Z  INFO   [sdk]  ancient',
      '2026-06-09T14:00:00.000Z  INFO   [sdk]  recent',
    ].join('\n'),
  });
  assert.equal(svc.getStateForTesting().counts.totalLines, 2);
});

test('Service: counts errors and warnings by level', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  x');
  sink.write('warn',  '2026-06-09T14:00:00.000Z  WARN   [sdk]  y');
  sink.write('info',  '2026-06-09T14:00:00.000Z  INFO   [sdk]  z');
  const state = svc.getStateForTesting();
  assert.equal(state.counts.errors, 1);
  assert.equal(state.counts.warnings, 1);
});

test('Service: clear() resets state but keeps live subscription', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock');
  svc.clear();
  sink.write('error', '2026-06-09T14:00:01.000Z  ERROR  [sdk]  deadlock');
  assert.equal(svc.getStateForTesting().counts.errors, 1);
});

test('Service: dispose unsubscribes', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  svc.dispose();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock');
  assert.equal(svc.getStateForTesting().counts.errors, 0);
});

test('Service: backfill IDs are negative, live IDs non-negative', () => {
  const { svc, sink } = makeSvc();
  svc.start({ backfillText: '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock' });
  sink.write('error', '2026-06-09T14:00:01.000Z  ERROR  [sdk]  deadlock');
  const state = svc.getStateForTesting();
  const problems = state.problems.get('deadlock_critical') ?? [];
  assert.equal(problems.length, 2);
  // First problem is from backfill (negative id); second from live (>=0)
  assert.ok(problems[0].line.id < 0, `backfill id should be negative, got ${problems[0].line.id}`);
  assert.ok(problems[1].line.id >= 0, `live id should be non-negative, got ${problems[1].line.id}`);
});

test('Service: pause stops emitting diffs but state still accumulates', () => {
  const { svc, sink } = makeSvc();
  const diffs: any[] = [];
  svc.onDiff(d => diffs.push(d));
  svc.start();
  svc.pause();
  diffs.length = 0;
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock');
  // state still accumulates
  assert.equal(svc.getStateForTesting().counts.errors, 1);
  // but no throttled diffs emitted (problemsAdded is immediate, but summary/histograms are throttled)
  const throttled = diffs.filter(d => d.type === 'summary' || d.type === 'histogramsUpdated');
  assert.equal(throttled.length, 0);
});

test('Service: problem capped at 1000 hits (count still grows)', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  for (let i = 0; i < 1010; i++) {
    sink.write('error', `2026-06-09T14:00:${String(i % 60).padStart(2, '0')}.000Z  ERROR  [sdk]  deadlock #${i}`);
  }
  const state = svc.getStateForTesting();
  assert.equal(state.problems.get('deadlock_critical')?.length, 1000);
  // counts.problems should reflect all 1010
  assert.equal(state.counts.problems, 1010);
});

test('Service: unparseable line counter increments', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('info', 'this is not a log line at all');
  assert.equal(svc.getStateForTesting().counts.unparseableLines, 1);
});

test('Service: emits problemsAdded diff for live problem', () => {
  const { svc, sink } = makeSvc();
  const diffs: any[] = [];
  svc.onDiff(d => diffs.push(d));
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock');
  const added = diffs.filter(d => d.type === 'problemsAdded');
  assert.equal(added.length, 1);
  assert.equal(added[0].items[0].patternKey, 'deadlock_critical');
});

test('Service: sessions update emits sessionsUpdated diff', () => {
  const { svc, sink } = makeSvc();
  const diffs: any[] = [];
  svc.onDiff(d => diffs.push(d));
  svc.start();
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc role=Client');
  const sessions = diffs.filter(d => d.type === 'sessionsUpdated');
  assert.ok(sessions.length >= 1);
});

test('Service: queryLines filters by level=error', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  bad');
  sink.write('info',  '2026-06-09T14:00:01.000Z  INFO   [sdk]  ok');
  const r = svc.queryLines({ filter: 'error' });
  assert.equal(r.items.length, 1);
  assert.equal(r.total, 1);
  assert.equal(r.items[0].level, 'error');
});

test('Service: queryLines applies case-insensitive search', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  Deadlock detected');
  sink.write('info',  '2026-06-09T14:00:01.000Z  INFO   [sdk]  Healthy');
  const r = svc.queryLines({ filter: 'all', search: 'deadLOCK' });
  assert.equal(r.items.length, 1);
});

test('Service: queryLines returns newest first', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  one');
  sink.write('info', '2026-06-09T14:00:01.000Z  INFO   [sdk]  two');
  sink.write('info', '2026-06-09T14:00:02.000Z  INFO   [sdk]  three');
  const r = svc.queryLines({ filter: 'all' });
  assert.equal(r.items[0].text, 'three');
  assert.equal(r.items[2].text, 'one');
});

test('Service: queryLines respects limit and offset for pagination', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  for (let i = 0; i < 10; i++) sink.write('info', `2026-06-09T14:00:0${i}.000Z  INFO   [sdk]  msg ${i}`);
  const page1 = svc.queryLines({ filter: 'all', limit: 3, offset: 0 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.total, 10);
  const page2 = svc.queryLines({ filter: 'all', limit: 3, offset: 3 });
  assert.equal(page2.items.length, 3);
  assert.notEqual(page1.items[0].id, page2.items[0].id);
});

test('Service: queryLines problem filter returns lines that matched any pattern', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('error', '2026-06-09T14:00:00.000Z  ERROR  [sdk]  deadlock here');
  sink.write('info',  '2026-06-09T14:00:01.000Z  INFO   [sdk]  ok');
  const r = svc.queryLines({ filter: 'problem' });
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].text, /deadlock/);
});

test('Service: getLineDetail returns target line + before/after context', () => {
  const { svc, sink } = makeSvc();
  svc.start();
  for (let i = 0; i < 5; i++) sink.write('info', `2026-06-09T14:00:0${i}.000Z  INFO   [sdk]  msg ${i}`);
  const target = svc.queryLines({ filter: 'all', limit: 10 }).items.find(l => l.text === 'msg 2')!;
  const d = svc.getLineDetail(target.id, 2, 2);
  assert.equal(d.line?.text, 'msg 2');
  assert.equal(d.before.length, 2);
  assert.equal(d.after.length, 2);
});
