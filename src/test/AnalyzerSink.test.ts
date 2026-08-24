import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalyzerSink } from '../logAnalyzer/AnalyzerSink.js';

test('AnalyzerSink: write produces parsed LogLine via onLine', () => {
  const sink = new AnalyzerSink({ capacity: 100 });
  const got: any[] = [];
  sink.onLine(l => got.push(l));
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  hello world');
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'hello world');
  assert.equal(got[0].tag, 'sdk');
});

test('AnalyzerSink: ids are monotonic', () => {
  const sink = new AnalyzerSink({ capacity: 100 });
  const ids: number[] = [];
  sink.onLine(l => ids.push(l.id));
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  a');
  sink.write('info', '2026-06-09T14:00:01.000Z  INFO   [sdk]  b');
  sink.write('info', '2026-06-09T14:00:02.000Z  INFO   [sdk]  c');
  assert.deepEqual(ids, [0, 1, 2]);
});

test('AnalyzerSink: snapshot returns recent lines bounded by capacity', () => {
  const sink = new AnalyzerSink({ capacity: 3 });
  for (let i = 0; i < 5; i++) sink.write('info', `2026-06-09T14:00:0${i}.000Z  INFO   [sdk]  msg${i}`);
  const snap = sink.snapshot();
  assert.equal(snap.length, 3);
  assert.equal(snap[0]?.text, 'msg2');
  assert.equal(snap[2]?.text, 'msg4');
});

test('AnalyzerSink: firstLiveId returns the id of the first live line', () => {
  const sink = new AnalyzerSink({ capacity: 100 });
  assert.equal(sink.firstLiveId(), 0);
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  hi');
  assert.equal(sink.firstLiveId(), 0);
});

test('AnalyzerSink: onLine subscription can be disposed', () => {
  const sink = new AnalyzerSink({ capacity: 10 });
  let count = 0;
  const sub = sink.onLine(() => { count++; });
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  x');
  sub.dispose();
  sink.write('info', '2026-06-09T14:00:01.000Z  INFO   [sdk]  y');
  assert.equal(count, 1);
});

test('AnalyzerSink: throwing listener does not block other listeners', () => {
  const sink = new AnalyzerSink({ capacity: 10 });
  let bSaw = false;
  sink.onLine(() => { throw new Error('A throws'); });
  sink.onLine(() => { bSaw = true; });
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  x');
  assert.equal(bSaw, true);
});

test('AnalyzerSink: text is lazily derived but still survives IPC serialisation', () => {
  // LineParser keeps `text` as a lazy enumerable getter so the retained
  // buffer doesn't pay for a second string per line up front. Lines cross to
  // the webview via postMessage (JSON serialisation), which only picks up own
  // enumerable properties — a non-enumerable or prototype getter would arrive
  // as `undefined` there.
  const sink = new AnalyzerSink({ capacity: 10 });
  sink.write('info', '2026-06-09T14:00:00.000Z  INFO   [sdk]  lazily derived body');
  const line = sink.snapshot()[0];
  assert.ok(line);

  assert.equal(line.raw, '2026-06-09T14:00:00.000Z  INFO   [sdk]  lazily derived body');
  assert.equal(line.text, 'lazily derived body');
  assert.equal(line.text, 'lazily derived body', 'memoised — stable across reads');

  const roundTripped = JSON.parse(JSON.stringify(line)) as { text: string; raw: string };
  assert.equal(roundTripped.text, 'lazily derived body', 'text reachable through JSON serialisation');
  assert.equal(roundTripped.raw, line.raw);
});
