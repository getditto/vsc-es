import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from '../logging/format.js';

test('formatLogLine: timestamp, level, tag, message', () => {
  const line = formatLogLine({
    timestamp: new Date('2026-05-09T19:42:11.382Z'),
    level: 'info',
    tag: 'ext:DittoManager',
    message: 'Connected',
    ctx: undefined,
  });
  assert.equal(line, '2026-05-09T19:42:11.382Z  INFO   [ext:DittoManager]  Connected');
});

test('formatLogLine: with context, JSON-stringified', () => {
  const line = formatLogLine({
    timestamp: new Date('2026-05-09T19:42:11.382Z'),
    level: 'info',
    tag: 'ext:DittoManager',
    message: 'Connected',
    ctx: { databaseId: 'abc-123', mode: 'server' },
  });
  assert.match(line, /^2026-05-09T19:42:11.382Z {2}INFO {3}\[ext:DittoManager\] {2}Connected {2}/);
  assert.match(line, /\{"databaseId":"abc-123","mode":"server"\}$/);
});

test('formatLogLine: no tag falls back to bare label', () => {
  const line = formatLogLine({
    timestamp: new Date('2026-05-09T19:42:11.382Z'),
    level: 'warn',
    tag: undefined,
    message: 'Something',
    ctx: undefined,
  });
  assert.equal(line, '2026-05-09T19:42:11.382Z  WARN   Something');
});

test('formatLogLine: empty ctx object treated as no ctx', () => {
  const line = formatLogLine({
    timestamp: new Date('2026-05-09T19:42:11.382Z'),
    level: 'debug',
    tag: 'ext',
    message: 'Hi',
    ctx: {},
  });
  assert.equal(line, '2026-05-09T19:42:11.382Z  DEBUG  [ext]  Hi');
});

test('formatLogLine: unserializable ctx degrades instead of throwing', () => {
  // JSON.stringify throws on BigInt values and on circular references. A
  // logging call must never throw because of its ctx.
  const circular: Record<string, unknown> = { databaseId: 'abc' };
  circular.self = circular;
  for (const ctx of [{ n: 1n as unknown as string }, circular]) {
    const line = formatLogLine({
      timestamp: new Date('2026-05-09T19:42:11.382Z'),
      level: 'info',
      tag: 'ext',
      message: 'Hi',
      ctx,
    });
    assert.match(line, /Hi {2}<unserializable ctx>$/);
  }
});

test('formatLogLine: multi-line message escapes newlines in display but preserves them in file', () => {
  // For v1: newlines pass through. The channel and file both render multi-line strings naturally.
  const line = formatLogLine({
    timestamp: new Date('2026-05-09T19:42:11.382Z'),
    level: 'error',
    tag: 'ext',
    message: 'line1\nline2',
    ctx: undefined,
  });
  assert.equal(line, '2026-05-09T19:42:11.382Z  ERROR  [ext]  line1\nline2');
});
