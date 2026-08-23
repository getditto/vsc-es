import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createLogger } from '../logging/Logger.js';
import type { LogLevel } from '../logging/types.js';

interface FakeLines { level: LogLevel; line: string; }
function fakeChannel() {
  const lines: FakeLines[] = [];
  let level: any = 3;                                     // VS Code LogLevel.Info = 3
  const listeners: Array<(l: any) => void> = [];
  return {
    lines,
    setLevel(l: any) { level = l; for (const f of listeners) f(level); },
    api: {
      get logLevel() { return level; },
      onDidChangeLogLevel(f: (l: any) => void) { listeners.push(f); return { dispose() {} }; },
      error(s: string) { lines.push({ level: 'error', line: s }); },
      warn(s: string)  { lines.push({ level: 'warn',  line: s }); },
      info(s: string)  { lines.push({ level: 'info',  line: s }); },
      debug(s: string) { lines.push({ level: 'debug', line: s }); },
      trace(s: string) { lines.push({ level: 'trace', line: s }); },
      show() {}, dispose() {},
    } as any,
  };
}

async function tmpdir() { return await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-log-')); }

test('Logger: writes to channel and file at default info level', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  logger.info('hello');
  await logger.flush();
  assert.equal(ch.lines.length, 1);
  assert.match(ch.lines[0].line, /INFO/);
  const file = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(file, /INFO.*hello/);
  await logger.dispose();
});

test('Logger: filters debug/trace at default info', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  logger.debug('skip-me');
  logger.trace('also-skip');
  await logger.flush();
  assert.equal(ch.lines.length, 0);
  await logger.dispose();
});

test('Logger: setChannelLevel(debug) opens up debug to channel and file', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  logger.setChannelLevel('debug');
  logger.debug('see-me');
  await logger.flush();
  assert.equal(ch.lines.length, 1);
  const file = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(file, /DEBUG.*see-me/);
  await logger.dispose();
});

test('Logger: file always retains info even when channel level set above', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  logger.setChannelLevel('warn');
  logger.info('still-in-file');
  await logger.flush();
  assert.equal(ch.lines.length, 0, 'channel filtered');
  const file = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(file, /INFO.*still-in-file/, 'file kept it (file_min=info)');
  await logger.dispose();
});

test('Logger: withTag prepends tag to messages', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  const sub = logger.withTag('ext:DittoManager');
  sub.info('Connected');
  await logger.flush();
  assert.match(ch.lines[0].line, /\[ext:DittoManager\]/);
  await logger.dispose();
});

test('Logger: onDidChangeChannelLevel fires on setChannelLevel', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  let observed: LogLevel | null = null;
  logger.onDidChangeChannelLevel(l => { observed = l; });
  logger.setChannelLevel('trace');
  assert.equal(observed, 'trace');
  await logger.dispose();
});

test('Logger: setSdkLevel updates value and fires event', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir });
  let observed: LogLevel | null = null;
  logger.onDidChangeSdkLevel(l => { observed = l; });
  logger.setSdkLevel('debug');
  assert.equal(logger.getSdkLevel(), 'debug');
  assert.equal(observed, 'debug');
  await logger.dispose();
});

test('Logger: redacts secrets in production mode', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'production' });
  logger.info('Login OK', { token: 'sk_live_xxx' });
  await logger.flush();
  assert.doesNotMatch(ch.lines[0].line, /sk_live_xxx/);
  assert.match(ch.lines[0].line, /\[redacted\]/);
  await logger.dispose();
});

test('Logger: development tripwire throws when an emitted line carries a secret', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'development' });
  assert.throws(
    () => logger.info('Login OK', { token: 'sk_live_xxx' }),
    /secret pattern detected/,
  );
  await logger.dispose();
});

test('Logger: suppressed level does no formatting or secret work', async () => {
  // channel=error + fileMin=error suppresses this debug line entirely. The
  // line carries a secret pattern AND a circular ctx: in development mode
  // the secret scan would throw the tripwire, and formatting the circular
  // ctx would have been the old code's first step — so a clean no-op proves
  // the level gate ran before any of that work.
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, fileMin: 'error', mode: 'development' });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.debug('dbg {"token":"sk_live_xxx"}', circular));
  await logger.flush();
  assert.equal(ch.lines.length, 0, 'no sink received the suppressed line');
  await logger.dispose();
});

test('Logger: line still reaches the file when only the channel is filtered', async () => {
  // The early gate must not skip formatting when ANY sink takes the line:
  // here only the file sink is eligible, and the tripwire must still apply.
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'development' });
  logger.setChannelLevel('error');
  assert.throws(() => logger.info('file-only {"token":"abc"}'), /secret pattern detected/);
  await logger.dispose();
});

test('Logger: registered known secrets are redacted in production', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'production' });
  logger.registerKnownSecrets(['live-secret-value-9f8e7d']);
  logger.info('attaching live-secret-value-9f8e7d to request');
  await logger.flush();
  assert.doesNotMatch(ch.lines[0].line, /live-secret-value-9f8e7d/);
  assert.match(ch.lines[0].line, /\[redacted\]/);
  await logger.dispose();
});

test('Logger: known secrets under 8 chars are ignored', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'production' });
  logger.registerKnownSecrets(['short']);
  logger.info('this line mentions short plainly');
  await logger.flush();
  assert.match(ch.lines[0].line, /short/);
  await logger.dispose();
});

test('Logger: clearKnownSecrets stops redacting previously registered values', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'production' });
  logger.registerKnownSecrets(['stale-secret-0001']);
  logger.clearKnownSecrets();
  logger.info('mentions stale-secret-0001 after clear');
  await logger.flush();
  assert.match(ch.lines[0].line, /stale-secret-0001/);
  await logger.dispose();
});

test('Logger: a known secret value trips the development tripwire too', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({ channel: ch.api, fileDir: dir, mode: 'development' });
  logger.registerKnownSecrets(['dev-trip-secret-123']);
  assert.throws(() => logger.info('leaks dev-trip-secret-123 here'), /secret pattern detected/);
  await logger.dispose();
});

test('Logger: writes to extraSinks alongside channel and file', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const captured: { level: string; line: string }[] = [];
  const logger = createLogger({
    channel: ch.api,
    fileDir: dir,
    extraSinks: [{ write: (level, line) => captured.push({ level, line }) }],
  });
  logger.info('via-extra-sink');
  await logger.flush();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, 'info');
  assert.match(captured[0].line, /via-extra-sink/);
  await logger.dispose();
});

test('Logger: extraSink throw does not affect channel or file', async () => {
  const ch = fakeChannel();
  const dir = await tmpdir();
  const logger = createLogger({
    channel: ch.api,
    fileDir: dir,
    extraSinks: [{ write: () => { throw new Error('boom'); } }],
  });
  logger.info('still-written');
  await logger.flush();
  // User payload still reaches the channel even though extraSink threw.
  // (Logger may additionally report the throw to the channel as an error line —
  // that's defense-in-depth, so we assert on payload presence, not total count.)
  assert.ok(ch.lines.some(l => /still-written/.test(l.line)), 'user payload reached channel');
  const file = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(file, /still-written/);
  await logger.dispose();
});
