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

test('FileSink: hardens permissions on an existing log directory and file', async (t) => {
  if (process.platform === 'win32') { t.skip('Unix mode bits are not enforced on Windows'); return; }
  const dir = await tmpdir();
  const active = path.join(dir, 'ditto-edge-studio.log');
  await fs.chmod(dir, 0o755);
  await fs.writeFile(active, 'old\n', { mode: 0o644 });
  await fs.chmod(active, 0o644);

  const sink = new FileSink(dir, { maxBytes: 1024, retain: 3 });
  await sink.write('new\n');
  await sink.flush();

  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(active)).mode & 0o777, 0o600);
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

test('FileSink: a failed flush neither poisons the chain nor throws', async () => {
  // Regression: the old `this.flushing.then(() => this.doFlush())` chain had
  // no recovery — one rejection (e.g. disk error) silenced every later
  // flush, losing buffered lines forever. The chain must now recover: the
  // failed batch is dropped deliberately (requeueing risks duplicates after
  // a partial write) and subsequent flushes proceed.
  const dir = await tmpdir();
  const errors: unknown[] = [];
  const sink = new FileSink(dir, { maxBytes: 1024, retain: 3, onFlushError: (e) => errors.push(e) });

  await sink.write('before\n');
  await sink.flush();

  // Break the sink by replacing the log DIRECTORY with a plain file: the
  // recursive mkdir / appendFile inside the next doFlush then fail.
  await fs.rm(dir, { recursive: true });
  await fs.writeFile(dir, 'not a directory');
  await sink.write('dropped\n');
  await sink.flush(); // must reject internally but resolve here
  assert.ok(errors.length >= 1, 'flush failure was reported');

  // Repair the directory and prove the chain still works: a later flush
  // runs, and dispose() — itself a flush — also succeeds.
  await fs.rm(dir);
  await fs.mkdir(dir, { recursive: true });
  await sink.write('after\n');
  await sink.flush();
  const txt = await fs.readFile(path.join(dir, 'ditto-edge-studio.log'), 'utf8');
  assert.match(txt, /after/);
  await sink.dispose();
});

test('FileSink: buffer byte counter drives rotation without per-write stats', async () => {
  // Behavior-level check of the running-counter change: lines under the
  // threshold accumulate into ONE file without rotation; crossing it rotates.
  // (The old code re-statted the active file on every buffered write.)
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 100, retain: 3 });
  for (let i = 0; i < 5; i++) { await sink.write('0123456789\n'); }  // 11 B each, 55 B total
  await sink.flush();
  let files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ['ditto-edge-studio.log'], 'no rotation under threshold');
  for (let i = 0; i < 5; i++) { await sink.write('0123456789\n'); }  // another 55 B → crosses 100
  await sink.flush();
  files = (await fs.readdir(dir)).sort();
  assert.ok(files.includes('ditto-edge-studio.log.1'), 'rotated once threshold crossed');
  await sink.dispose();
});

// ─── readTailLines ─────────────────────────────────────────────
//
// The analyzer's backfill used readAllChronological(), which pulls the whole
// retention window (6 files x 5 MB by default) into one string and hands the
// caller a ~300k-element split of it — almost all of which is then discarded
// against the connect-time cutoff. readTailLines reads backwards instead and
// stops once it has enough.

test('FileSink: readTailLines returns the newest lines, oldest-first', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024 * 1024, retain: 3 });
  for (let i = 0; i < 50; i++) { await sink.write(`line ${i}\n`); }
  await sink.flush();

  const tail = await sink.readTailLines(10);
  assert.deepEqual(tail, Array.from({ length: 10 }, (_, i) => `line ${40 + i}`));
  await sink.dispose();
});

test('FileSink: readTailLines spans the rotation set newest-first', async () => {
  const dir = await tmpdir();
  // Tiny maxBytes so writing forces several rotations.
  const sink = new FileSink(dir, { maxBytes: 200, retain: 3 });
  for (let i = 0; i < 100; i++) { await sink.write(`line ${String(i).padStart(3, '0')}\n`); }
  await sink.flush();

  const tail = await sink.readTailLines(40);
  assert.equal(tail.length, 40);
  // Chronological, contiguous, and ending at the newest line written.
  assert.equal(tail[tail.length - 1], 'line 099');
  for (let i = 1; i < tail.length; i++) {
    const prev = Number(tail[i - 1]?.slice(5));
    const cur = Number(tail[i]?.slice(5));
    assert.equal(cur, prev + 1, `ordering broke at ${tail[i - 1]} → ${tail[i]}`);
  }
  await sink.dispose();
});

test('FileSink: readTailLines returns everything when asked for more than exists', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024 * 1024, retain: 3 });
  for (let i = 0; i < 5; i++) { await sink.write(`line ${i}\n`); }
  await sink.flush();
  assert.deepEqual(await sink.readTailLines(1000), ['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  await sink.dispose();
});

test('FileSink: readTailLines handles a chunk boundary mid-line', async () => {
  // A tiny chunk size forces the carry path: the start of each chunk is a
  // partial line whose beginning lives in the previous (earlier) chunk.
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024 * 1024, retain: 3 });
  const written: string[] = [];
  for (let i = 0; i < 40; i++) {
    const line = `line ${i} ${'x'.repeat(i % 17)}`;
    written.push(line);
    await sink.write(`${line}\n`);
  }
  await sink.flush();

  for (const chunk of [1, 2, 3, 7, 13, 64]) {
    assert.deepEqual(
      await sink.readTailLines(40, chunk), written,
      `chunk size ${chunk} produced the wrong lines`,
    );
  }
  await sink.dispose();
});

test('FileSink: readTailLines does not corrupt multi-byte characters at a chunk boundary', async () => {
  // The reason chunks are accumulated as bytes and only decoded from a line
  // boundary onwards. Decoding each chunk independently splits a UTF-8
  // sequence and yields replacement characters.
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 1024 * 1024, retain: 3 });
  const written = [
    'plain ascii line',
    'grüße aus münchen — em dash and umlauts',
    '日本語のログ行です',
    'emoji 🚀🔥 and more 🎉',
    'mixed Ünïcödé 日本 🚀 tail',
  ];
  for (const l of written) { await sink.write(`${l}\n`); }
  await sink.flush();

  // Sweep chunk sizes so a boundary lands inside a multi-byte sequence.
  for (let chunk = 1; chunk <= 40; chunk++) {
    const tail = await sink.readTailLines(written.length, chunk);
    assert.deepEqual(tail, written, `chunk size ${chunk} corrupted the text`);
    assert.ok(
      !tail.some(l => l.includes('�')),
      `chunk size ${chunk} produced a replacement character`,
    );
  }
  await sink.dispose();
});

test('FileSink: readTailLines on a missing log directory returns nothing', async () => {
  const sink = new FileSink(path.join(os.tmpdir(), 'ditto-fs-does-not-exist-1234'), {});
  assert.deepEqual(await sink.readTailLines(10), []);
});

test('FileSink: readTailLines with a non-positive limit reads nothing', async () => {
  const dir = await tmpdir();
  const sink = new FileSink(dir, {});
  await sink.write('line\n');
  await sink.flush();
  assert.deepEqual(await sink.readTailLines(0), []);
  assert.deepEqual(await sink.readTailLines(-5), []);
  await sink.dispose();
});

test('FileSink: readTailLines agrees with readAllChronological on the tail', async () => {
  // Differential check against the existing whole-file reader, which is the
  // behaviour being preserved.
  const dir = await tmpdir();
  const sink = new FileSink(dir, { maxBytes: 300, retain: 4 });
  for (let i = 0; i < 120; i++) { await sink.write(`entry ${String(i).padStart(3, '0')} payload\n`); }
  await sink.flush();

  const all = (await sink.readAllChronological()).split('\n').filter(l => l.length > 0);
  for (const n of [1, 5, 37, 200]) {
    assert.deepEqual(
      await sink.readTailLines(n),
      all.slice(Math.max(0, all.length - n)),
      `tail of ${n} disagrees with the whole-file read`,
    );
  }
  await sink.dispose();
});
