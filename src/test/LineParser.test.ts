import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../logAnalyzer/LineParser.js';

test('parseLine: well-formed line with tag and ctx', () => {
  const raw = '2026-06-09T14:23:09.123Z  INFO   [ext:DittoManager]  Connected  {"databaseId":"abc"}';
  const r = parseLine(raw, 42);
  assert.equal(r.id, 42);
  assert.equal(r.level, 'info');
  assert.equal(r.tag, 'ext:DittoManager');
  assert.equal(r.text, 'Connected  {"databaseId":"abc"}');
  assert.equal(r.timestamp?.toISOString(), '2026-06-09T14:23:09.123Z');
});

test('parseLine: line without tag', () => {
  const raw = '2026-06-09T14:23:09.123Z  WARN   slow query';
  const r = parseLine(raw, 1);
  assert.equal(r.tag, null);
  assert.equal(r.text, 'slow query');
});

test('parseLine: line without ctx', () => {
  const raw = '2026-06-09T14:23:09.123Z  ERROR  [sdk]  connection refused';
  const r = parseLine(raw, 1);
  assert.equal(r.text, 'connection refused');
});

test('parseLine: malformed line falls back to info + raw text', () => {
  const r = parseLine('this is not a log line at all', 5);
  assert.equal(r.level, 'info');
  assert.equal(r.tag, null);
  assert.equal(r.timestamp, null);
  assert.equal(r.text, 'this is not a log line at all');
});

test('parseLine: empty string', () => {
  const r = parseLine('', 0);
  assert.equal(r.text, '');
  assert.equal(r.timestamp, null);
});

test('parseLine: truncates lines > 16 KiB', () => {
  const big = 'x'.repeat(20 * 1024);
  const raw = `2026-06-09T14:23:09.123Z  INFO   [sdk]  ${big}`;
  const r = parseLine(raw, 1);
  assert.ok(r.raw.length <= 16 * 1024 + 100, 'raw truncated');
  assert.match(r.raw, /…\[truncated\]$/);
});
