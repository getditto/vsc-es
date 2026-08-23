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
  // but no throttled diffs emitted (summary/histograms/problemsAdded all
  // flow through the throttled flush)
  const throttled = diffs.filter(d => d.type === 'summary' || d.type === 'histogramsUpdated' || d.type === 'problemsAdded');
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

test('Service: clear() empties the sessions view and keeps it empty', () => {
  // Regression: state.sessions is refreshed only when the tracker's version
  // changes. clear() empties state.sessions, so leaving the version gate
  // (and the tracker itself) untouched stranded the Sessions view at empty
  // until the next connection event — which then resurrected the whole
  // pre-Clear history.
  const { svc, sink } = makeSvc();
  svc.start();
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc transport_type=LAN role=Client');
  sink.write('info', '2026-06-09T14:00:01.000Z  INFO   [sdk]  physical connection ended remote=abc role=Client');
  assert.equal(svc.getStateForTesting().sessions.length, 1);

  svc.clear();
  assert.equal(svc.getStateForTesting().sessions.length, 0, 'cleared');

  // An unrelated line must not resurrect the cleared history…
  sink.write('info', '2026-06-09T14:00:02.000Z  INFO   [sdk]  an unrelated line');
  assert.equal(svc.getStateForTesting().sessions.length, 0, 'stays cleared');

  // …and a genuinely new session must still land.
  sink.write('info', '2026-06-09T14:00:03.000Z  INFO   [sdk]  physical connection started remote=def transport_type=LAN role=Client');
  const after = svc.getStateForTesting().sessions;
  assert.equal(after.length, 1);
  assert.equal(after[0].remotePeer, 'def');
});

// ─── Summary/table agreement ───────────────────────────────────
//
// The bug these cover, as reported from manual testing: the header read
// "Errors: 0 · Lines: 1" while the Errors tab listed four ERROR rows. The
// header comes from the throttled `summary` diff; the tabs come from a live
// `queryLines`. maybeFlush only fired on the leading edge, so a backfill of N
// lines emitted exactly one summary — the one after the FIRST line — and when
// the log went quiet afterwards nothing ever corrected it.

const BACKFILL = [
  '2026-08-23T18:55:30.000Z  INFO   [ext]  starting up',
  '2026-08-23T18:55:31.000Z  INFO   [ext]  ditto_init sdk.version=5.1.0 sdk.platform=macOS',
  '2026-08-23T18:55:32.480Z  ERROR  [ext]  UNCAUGHT EXCEPTION {"a":1}',
  '2026-08-23T18:55:40.000Z  WARN   [ext]  slow query',
  '2026-08-23T18:55:48.327Z  ERROR  [ext]  UNCAUGHT EXCEPTION {"a":2}',
  '2026-08-23T18:55:48.332Z  ERROR  [ext]  UNCAUGHT EXCEPTION {"a":3}',
  '2026-08-23T18:55:48.346Z  ERROR  [ext]  UNCAUGHT EXCEPTION {"a":4}',
].join('\n');

/** A service with the production throttle, so the throttling path is the one
 *  under test rather than being disabled by throttleMs: 0. */
function makeThrottledSvc() {
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({ listAll: () => ({ bundled: [], user: [] }) });
  engine.load();
  const tracker = new ConnectionTracker();
  const svc = new LogAnalyzerService({ sink, engine, tracker });
  const summaries: { counts: any; tags: string[]; sdkVersion: string | null }[] = [];
  svc.onDiff(d => { if (d.type === 'summary') { summaries.push(d); } });
  return { svc, sink, summaries };
}

test('Service: the summary after a backfill agrees with what the tabs query', () => {
  const { svc, summaries } = makeThrottledSvc();
  svc.start({ backfillText: BACKFILL });

  const last = summaries[summaries.length - 1];
  assert.equal(last.counts.totalLines, svc.queryLines({ filter: 'all' }).total, 'Lines vs All tab');
  assert.equal(last.counts.errors, svc.queryLines({ filter: 'error' }).total, 'Errors vs Errors tab');
  assert.equal(last.counts.warnings, svc.queryLines({ filter: 'warn' }).total, 'Warnings vs Warnings tab');
  // The specific numbers from the report, so a regression is recognisable.
  assert.equal(last.counts.errors, 4);
  assert.equal(last.counts.totalLines, 7);
});

test('Service: the volume histogram counts this analyzer\'s lines, not the shared sink', () => {
  // The sink is shared by every database's analyzer and only ever holds lines
  // the extension logged *live* — it excludes backfill read from the rotated
  // log file, and includes other connections' lines. Binning it produced a
  // histogram over a different population than every other number on screen.
  const { svc, sink, summaries } = makeThrottledSvc();
  for (let i = 0; i < 20; i++) {
    sink.write('error', `2026-08-01T00:00:0${i % 10}.000Z  ERROR  [other]  unrelated ${i}`);
  }
  const histos: any[] = [];
  svc.onDiff(d => { if (d.type === 'histogramsUpdated') { histos.push(d.histograms); } });

  svc.start({ backfillText: BACKFILL });

  const bins = histos[histos.length - 1].volumeByLevel;
  const total = bins.reduce((n: number, b: any) =>
    n + b.counts.error + b.counts.warn + b.counts.info + b.counts.debug + b.counts.trace, 0);
  assert.equal(total, svc.queryLines({ filter: 'all' }).total);
  assert.equal(summaries[summaries.length - 1].counts.totalLines, total, 'histogram vs Lines');
});

test('Service: clear() empties the volume histogram too', () => {
  const { svc } = makeThrottledSvc();
  const histos: any[] = [];
  svc.onDiff(d => { if (d.type === 'histogramsUpdated') { histos.push(d.histograms); } });
  svc.start({ backfillText: BACKFILL });
  assert.ok(histos[histos.length - 1].volumeByLevel.length > 0, 'populated before clear');

  svc.clear();
  svc.resume(); // forces a flush without needing another line

  const bins = histos[histos.length - 1].volumeByLevel;
  const total = bins.reduce((n: number, b: any) =>
    n + b.counts.error + b.counts.warn + b.counts.info + b.counts.debug + b.counts.trace, 0);
  assert.equal(total, 0);
});

test('Service: the trailing edge of a live burst is flushed', () => {
  // Leading-edge-only throttling swallowed everything after the first line of
  // a burst. Emulated here with an injected clock so the burst lands inside
  // one throttle window, then asserted via resume()'s forced flush — the same
  // guarantee the trailing-edge timer provides in real time.
  const sink = new AnalyzerSink({ capacity: 1000 });
  const engine = new PatternEngine({ listAll: () => ({ bundled: [], user: [] }) });
  engine.load();
  let clock = 10_000;
  const svc = new LogAnalyzerService({
    sink, engine, tracker: new ConnectionTracker(), now: () => clock,
  });
  const summaries: any[] = [];
  svc.onDiff(d => { if (d.type === 'summary') { summaries.push(d.counts); } });
  svc.start();

  for (let i = 0; i < 5; i++) {
    sink.write('error', `2026-08-23T18:55:5${i}.000Z  ERROR  [ext]  boom ${i}`);
  }
  // Still inside the throttle window: the leading-edge flush has happened and
  // the rest are pending.
  assert.ok(summaries[summaries.length - 1].errors < 5, 'throttled, as designed');

  clock += 1000;
  sink.write('info', '2026-08-23T18:56:00.000Z  INFO   [ext]  next window');
  assert.equal(
    summaries[summaries.length - 1].errors, 5,
    'the pending lines land on the next flush rather than being lost',
  );
});

test('Service: start() does not leak the sink subscription', () => {
  // The panel calls start() again on refresh. Overwriting liveSub left the old
  // subscription attached, so every later line was processed once per start().
  const { svc, sink } = makeThrottledSvc();
  svc.start();
  svc.start();
  svc.start();
  sink.write('info', '2026-08-23T18:56:00.000Z  INFO   [ext]  one line');
  assert.equal(svc.queryLines({ filter: 'all' }).total, 1, 'processed once, not three times');
});

test('Service: the refresh sequence does not duplicate the backfill', () => {
  // What LogAnalyzerPanel does for analyzer.refresh: clear, then re-ingest.
  const { svc } = makeThrottledSvc();
  svc.start({ backfillText: BACKFILL });
  const first = svc.queryLines({ filter: 'all' }).total;

  svc.clear();
  svc.start({ backfillText: BACKFILL });

  assert.equal(svc.queryLines({ filter: 'all' }).total, first, 'same lines, not doubled');
  assert.equal(svc.queryLines({ filter: 'error' }).total, 4);
});

test('Service: the summary carries the tags, SDK version and time range', () => {
  // None of these were ever transmitted, so the header showed
  // "SDK: unknown · Tags: none · Range: n/a" for the life of the panel.
  const { svc, summaries } = makeThrottledSvc();
  svc.start({ backfillText: BACKFILL });
  const last = summaries[summaries.length - 1] as any;

  assert.deepEqual(last.tags, ['ext']);
  assert.equal(last.sdkVersion, '5.1.0', 'parsed from the SDK init line');
  assert.equal(last.startTimeMs, Date.parse('2026-08-23T18:55:30.000Z'));
  assert.equal(last.endTimeMs, Date.parse('2026-08-23T18:55:48.346Z'));
});

test('Service: clear() resets the transmitted metadata as well as the counts', () => {
  const { svc, summaries } = makeThrottledSvc();
  svc.start({ backfillText: BACKFILL });
  svc.clear();
  svc.resume();
  const last = summaries[summaries.length - 1] as any;
  assert.deepEqual(last.tags, []);
  assert.equal(last.sdkVersion, null);
  assert.equal(last.startTimeMs, null);
  assert.equal(last.counts.totalLines, 0);
});

test('Service: problem badges count listable lines, not match occurrences', () => {
  // Two patterns both match the same line. `problems` counts occurrences (2),
  // but the Problems tab can only ever list that one line — a badge built from
  // `problems` promises a row that is not there.
  const sink = new AnalyzerSink({ capacity: 100 });
  const engine = new PatternEngine({
    listAll: () => ({
      bundled: [
        { key: 'a', pattern: 'boom', severity: 5, recommendation: 'x' },
        { key: 'b', pattern: 'BOOM', severity: 5, recommendation: 'y' },
      ],
      user: [],
    }),
  });
  engine.load();
  const svc = new LogAnalyzerService({
    sink, engine, tracker: new ConnectionTracker(), throttleMs: 0,
  });
  const summaries: any[] = [];
  svc.onDiff(d => { if (d.type === 'summary') { summaries.push(d.counts); } });
  svc.start();

  sink.write('error', '2026-08-23T18:55:32.000Z  ERROR  [ext]  boom happened');

  const c = summaries[summaries.length - 1];
  assert.equal(c.problems, 2, 'two pattern matches occurred');
  assert.equal(c.problemLines, 1, 'but only one line is listable');
  assert.equal(c.critical, 2);
  assert.equal(c.criticalLines, 1);
  // And the tab actually lists exactly problemLines rows.
  assert.equal(svc.queryLines({ filter: 'problem' }).total, c.problemLines);
  assert.equal(svc.queryLines({ filter: 'critical' }).total, c.criticalLines);
});

test('Service: problem line ids do not survive a clear', () => {
  const sink = new AnalyzerSink({ capacity: 100 });
  const engine = new PatternEngine({
    listAll: () => ({ bundled: [{ key: 'a', pattern: 'boom', severity: 5, recommendation: 'x' }], user: [] }),
  });
  engine.load();
  const svc = new LogAnalyzerService({
    sink, engine, tracker: new ConnectionTracker(), throttleMs: 0,
  });
  svc.start();
  sink.write('error', '2026-08-23T18:55:32.000Z  ERROR  [ext]  boom');
  assert.equal(svc.queryLines({ filter: 'problem' }).total, 1);

  svc.clear();
  // A line reusing an old id must not be matched by a stale id set.
  assert.equal(svc.queryLines({ filter: 'problem' }).total, 0);
  assert.equal(svc.queryLines({ filter: 'critical' }).total, 0);
});
