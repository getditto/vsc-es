import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';

import { createZip, crc32 } from '../bugreport/zip.js';

/**
 * The zip writer is hand-rolled (dependency-free), so these tests parse the
 * archive back with an independent minimal reader and cross-check the CRC
 * implementation against Node's own (zlib.crc32, Node 20.15+). If either
 * side disagrees the archive would be corrupt for the support engineer
 * receiving it, which is exactly the failure this suite exists to catch.
 */

/** One parsed central-directory entry. */
interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  data: Buffer; // raw (still-compressed) bytes from the local record
}

/** Walk the central directory and pull each entry's raw data via its local
 *  header — deliberately NOT using the writer's own constants, so a bad
 *  offset/size in the writer shows up as a parse failure here. */
function parseZip(zip: Buffer): { entries: ParsedEntry[]; eocdOffset: number } {
  // EOCD is the last 22 bytes (we never write a comment).
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD signature');
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);
  assert.equal(cdOffset + cdSize, eocdOffset, 'central directory ends where EOCD begins');

  const entries: ParsedEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    assert.equal(zip.readUInt32LE(pos), 0x02014b50, `central header ${i} signature`);
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const uncompressedSize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const localHeaderOffset = zip.readUInt32LE(pos + 42);

    // Follow the local header to the raw data.
    assert.equal(zip.readUInt32LE(localHeaderOffset), 0x04034b50, `local header for ${name}`);
    const localNameLen = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zip.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = zip.subarray(dataStart, dataStart + compressedSize);

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localHeaderOffset, data });
    pos += 46 + nameLen;
  }
  assert.equal(pos, eocdOffset, 'central directory is exactly consumed');
  return { entries, eocdOffset };
}

/** Inflate or pass through an entry's raw bytes per its method. */
function extract(entry: ParsedEntry): Buffer {
  if (entry.method === 0) { return entry.data; }
  if (entry.method === 8) { return zlib.inflateRawSync(entry.data); }
  throw new Error(`unexpected method ${entry.method}`);
}

test('crc32: matches the standard test vectors', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926, 'classic CRC-32 check value');
  // Node's own implementation as an independent oracle (Node 20.15+).
  const payload = Buffer.from('the quick brown fox jumps over the lazy dog');
  assert.equal(crc32(payload), zlib.crc32(payload));
  assert.equal(crc32(Buffer.alloc(1024, 0xAB)), zlib.crc32(Buffer.alloc(1024, 0xAB)),
    'agrees on binary data, not just ASCII');
});

test('createZip: an empty archive is a bare EOCD record', () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
  assert.equal(zip.readUInt16LE(8), 0, 'no entries');
  const { entries } = parseZip(zip);
  assert.equal(entries.length, 0);
});

test('createZip: text entries deflate and round-trip byte-for-byte', () => {
  const text = 'line one\nline two\n'.repeat(500); // compressible
  const zip = createZip([
    { name: 'application.log', data: Buffer.from(text, 'utf8'), date: new Date('2026-10-28T12:00:00') },
  ]);
  const { entries } = parseZip(zip);
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.name, 'application.log');
  assert.equal(entry.method, 8, 'deflated by default');
  assert.ok(entry.compressedSize < entry.uncompressedSize, 'deflate actually shrank the text');
  assert.equal(entry.uncompressedSize, Buffer.byteLength(text));
  assert.equal(entry.crc, crc32(Buffer.from(text, 'utf8')), 'CRC recorded is of the UNCOMPRESSED data');
  assert.equal(extract(entry).toString('utf8'), text);
});

test('createZip: store entries keep their exact bytes (for already-compressed payloads)', () => {
  // gzipped data does not compress further — store must not attempt it.
  const alreadyCompressed = zlib.gzipSync(Buffer.from('fake bundle '.repeat(200)));
  const zip = createZip([
    { name: 'support-bundle.tar.gz', data: alreadyCompressed, compression: 'store' },
  ]);
  const { entries } = parseZip(zip);
  const entry = entries[0]!;
  assert.equal(entry.method, 0, 'stored, not deflated');
  assert.equal(entry.compressedSize, entry.uncompressedSize);
  assert.deepEqual(extract(entry), alreadyCompressed, 'stored bytes are byte-identical');
});

test('createZip: multiple entries keep their order and independent offsets', () => {
  const readme = Buffer.from('readme contents');
  const log = Buffer.from('log contents '.repeat(100));
  const bundle = zlib.gzipSync(Buffer.from('bundle payload'));
  const zip = createZip([
    { name: 'README.txt', data: readme },
    { name: 'application.log', data: log },
    { name: 'support-bundle.tar.gz', data: bundle, compression: 'store' },
  ]);
  const { entries } = parseZip(zip);
  assert.deepEqual(entries.map(e => e.name), ['README.txt', 'application.log', 'support-bundle.tar.gz']);
  assert.deepEqual(entries.map(e => extract(e).equals(e.name === 'support-bundle.tar.gz' ? bundle : e.name === 'README.txt' ? readme : log)),
    [true, true, true], 'every entry extracts to its original bytes');
  // Local headers are laid out sequentially from offset 0.
  assert.equal(entries[0]!.localHeaderOffset, 0);
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const prevNameLen = Buffer.byteLength(prev.name);
    assert.equal(entries[i]!.localHeaderOffset,
      prev.localHeaderOffset + 30 + prevNameLen + prev.compressedSize,
      `entry ${i} starts right after entry ${i - 1}`);
  }
});

test('createZip: UTF-8 entry names set the UTF-8 flag and survive the round-trip', () => {
  const zip = createZip([{ name: 'logs/överview.txt', data: Buffer.from('x') }]);
  const { entries } = parseZip(zip);
  assert.equal(entries[0]!.name, 'logs/överview.txt');
  // The UTF-8 flag (bit 11) sits at offset 6 in the local header.
  const flags = zip.readUInt16LE(entries[0]!.localHeaderOffset + 6);
  assert.ok(flags & 0x0800, 'UTF-8 name flag set');
});

test('createZip: the recorded DOS date round-trips the calendar date', () => {
  const zip = createZip([{ name: 'f.txt', data: Buffer.from('x'), date: new Date(2026, 9, 28, 13, 30, 0) }]);
  const { entries } = parseZip(zip);
  const off = entries[0]!.localHeaderOffset;
  const dosDate = zip.readUInt16LE(off + 12);
  assert.equal((dosDate >> 9) + 1980, 2026, 'year');
  assert.equal((dosDate >> 5) & 0x0f, 10, 'month (October)');
  assert.equal(dosDate & 0x1f, 28, 'day');
});

test('createZip: pre-1980 dates clamp to the ZIP epoch instead of wrapping', () => {
  const zip = createZip([{ name: 'f.txt', data: Buffer.from('x'), date: new Date(1970, 0, 1) }]);
  const { entries } = parseZip(zip);
  const dosDate = zip.readUInt16LE(entries[0]!.localHeaderOffset + 12);
  assert.equal((dosDate >> 9) + 1980, 1980, 'clamped to the earliest representable year');
});
