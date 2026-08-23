import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionTracker } from '../logAnalyzer/ConnectionTracker.js';
import { parseLine } from '../logAnalyzer/LineParser.js';

function L(raw: string, id = 0) { return parseLine(raw, id); }

test('ConnectionTracker: pairs start with end by remote+role', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc transport_type=Websocket role=Client'));
  t.consume(L('2026-06-09T14:05:00.000Z  INFO   [sdk]  physical connection ended remote=abc role=Client'));
  const sessions = t.snapshot();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].remotePeer, 'abc');
  assert.equal(sessions[0].transport, 'Websocket');
  assert.equal(sessions[0].end?.toISOString(), '2026-06-09T14:05:00.000Z');
});

test('ConnectionTracker: ditto_init closes all open sessions', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc role=Client'));
  t.consume(L('2026-06-09T14:01:00.000Z  INFO   [sdk]  physical connection started remote=def role=Client'));
  t.consume(L('2026-06-09T14:02:00.000Z  INFO   [sdk]  ditto_init begin'));
  const sessions = t.snapshot();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every(s => s.end !== null));
  assert.equal(t.reinits().length, 1);
});

test('ConnectionTracker: end without matching start increments unmatched counter', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection ended remote=ghost role=Client'));
  assert.equal(t.unmatchedEnds(), 1);
});

test('ConnectionTracker: sessions still open render with end=null', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc'));
  const s = t.snapshot();
  assert.equal(s.length, 1);
  assert.equal(s[0].end, null);
});

test('ConnectionTracker: unparseable line is ignored', () => {
  const t = new ConnectionTracker();
  t.consume(L('garbage'));
  assert.equal(t.snapshot().length, 0);
});

test('ConnectionTracker: missing fields default to unknown', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started'));
  const s = t.snapshot();
  assert.equal(s.length, 1);
  assert.equal(s[0].remotePeer, 'unknown');
  assert.equal(s[0].transport, 'unknown');
  assert.equal(s[0].role, 'unknown');
});

test('ConnectionTracker: double-start without end records both as open', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc role=Client'));
  t.consume(L('2026-06-09T14:01:00.000Z  INFO   [sdk]  physical connection started remote=abc role=Client'));
  assert.equal(t.snapshot().length, 2);
});

test('ConnectionTracker: reset drops history and advances the version', () => {
  const t = new ConnectionTracker();
  t.consume(L('2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=abc role=Client'));
  t.consume(L('2026-06-09T14:01:00.000Z  INFO   [sdk]  ditto_init begin'));
  t.consume(L('2026-06-09T14:02:00.000Z  INFO   [sdk]  physical connection ended remote=ghost role=Client'));
  const before = t.getVersion();

  t.reset();

  assert.equal(t.snapshot().length, 0);
  assert.equal(t.reinits().length, 0);
  assert.equal(t.unmatchedEnds(), 0);
  assert.ok(t.getVersion() > before, 'consumers gate on the version, so it must advance');
});

test('ConnectionTracker: the open-session list is bounded', () => {
  // `closed` was capped but `open` was not. A start line whose matching "ended"
  // never arrives — killed process, truncated log, a phrasing RE_END misses —
  // left an entry forever, so a long-running session grew this without limit.
  const t = new ConnectionTracker();
  for (let i = 0; i < 5_000; i++) {
    t.consume(L(`2026-06-09T14:00:00.000Z  INFO   [sdk]  physical connection started remote=peer${i} role=Client`, i));
  }
  const open = t.snapshot();
  assert.ok(open.length <= 2_000, `open sessions must be bounded, saw ${open.length}`);
  // The most recent sessions are the ones worth keeping.
  assert.equal(open[open.length - 1].remotePeer, 'peer4999');
});
