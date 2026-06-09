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

test('TEMP_DELIBERATE_FAIL_2', () => {
  throw new Error('intentional failure');
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
  assert.equal(ch.lines.length, 1);
  const file = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(file, /still-written/);
  await logger.dispose();
});
