import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileSink } from '../logging/FileSink.js';

async function tmpdir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-fs-'));
}

test('FileSink: writes lines to active log file', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024, retain: 3 });
  await sink.write('hello\n');
  await sink.flush();
  const txt = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(txt, /hello/);
  await sink.dispose();
});

test('FileSink: rotates when size threshold crossed', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 50, retain: 3 });
  await sink.write('a'.repeat(40) + '\n');
  await sink.write('b'.repeat(40) + '\n');                 // forces rotate before second write
  await sink.flush();
  const files = (await fs.readdir(dir)).sort();
  assert.ok(files.includes('ditto-edge-studio.log'));
  assert.ok(files.includes('ditto-edge-studio.log.1'));
  await sink.dispose();
});

test('FileSink: drops oldest beyond retain count', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 10, retain: 2 });
  for (let i = 0; i < 6; i++) await sink.write(`line${i}\n`);
  await sink.flush();
  const files = (await fs.readdir(dir)).sort();
  // Active + retain rotations = retain + 1 max files
  assert.ok(files.length <= 3, `expected ≤3 files, got ${files.length}: ${files.join(',')}`);
  await sink.dispose();
});

test('FileSink: writes header on first creation', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024, retain: 3, headerLines: ['# session abc-123'] });
  await sink.write('first line\n');
  await sink.flush();
  const txt = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(txt, /^# session abc-123\nfirst line\n/);
  await sink.dispose();
});

test('FileSink: readAllChronological returns rotations oldest→newest then active', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 10, retain: 3 });
  await sink.write('A1\n');
  await sink.write('B12345678\n');                          // crosses threshold; rotates
  await sink.write('C1\n');
  await sink.flush();
  const all = await sink.readAllChronological();
  // Order: oldest rotation … newest rotation … active
  assert.match(all, /A1[\s\S]*B12345678[\s\S]*C1/);
  await sink.dispose();
});

test('FileSink: serializes concurrent writes safely', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024, retain: 3 });
  await Promise.all(Array.from({ length: 50 }, (_, i) => sink.write(`line${i}\n`)));
  await sink.flush();
  const txt = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  for (let i = 0; i < 50; i++) assert.match(txt, new RegExp(`line${i}\\b`));
  await sink.dispose();
});
