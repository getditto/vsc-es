// src/bugreport/zip.ts

import * as zlib from 'node:zlib';

/**
 * Minimal ZIP archive writer — just enough for the bug-report export (a
 * handful of entries, well under the ZIP64 thresholds). Writing our own
 * keeps a general-purpose archiving dependency out of the supply chain for
 * a format this simple: local file headers, a central directory, and an
 * end-of-central-directory record (APPNOTE §4.3–4.4).
 *
 * Text payloads should use the default DEFLATE compression; payloads that
 * are already compressed (the support-bundle `.tar.gz`) must use
 * `compression: 'store'` — re-deflating them burns CPU to make them larger.
 */

export interface ZipEntry {
  /** Archive path, forward-slash separated (e.g. `support-bundle.tar.gz`). */
  name: string;
  data: Buffer;
  /** `deflate` (default) or `store` (no compression). */
  compression?: 'deflate' | 'store';
  /** Entry timestamp recorded in the archive; defaults to now. */
  date?: Date;
}

// CRC-32 (ISO 3309, the polynomial ZIP and gzip both use), table-driven.
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair used by ZIP headers. Dates before 1980 (the ZIP
 *  epoch) clamp to 1980-01-01. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20;           // PKZIP 2.0 — needed for DEFLATE
const FLAG_UTF8 = 0x0800;     // general-purpose bit 11: names are UTF-8
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** Build a complete ZIP archive from `entries`, in the order given. */
export function createZip(entries: ZipEntry[]): Buffer {
  const body: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const store = entry.compression === 'store';
    const compressed = store ? entry.data : zlib.deflateRawSync(entry.data, { level: 9 });
    const method = store ? METHOD_STORE : METHOD_DEFLATE;
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION, 4);          // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);        // general purpose bit flag
    local.writeUInt16LE(method, 8);           // compression method
    local.writeUInt16LE(time, 10);            // last mod file time
    local.writeUInt16LE(date, 12);            // last mod file date
    local.writeUInt32LE(crc, 14);             // crc-32 of uncompressed data
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);               // extra field length
    body.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION, 4);         // version made by
    header.writeUInt16LE(VERSION, 6);         // version needed to extract
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    // extra length (30), comment length (32), disk number start (34),
    // internal attrs (36), external attrs (38) — all 0
    header.writeUInt32LE(offset, 42);         // offset of local header
    central.push(header, nameBytes);

    offset += 30 + nameBytes.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  // disk numbers (4, 6) — single-disk archive, 0
  eocd.writeUInt16LE(entries.length, 8);      // entries in central dir on this disk
  eocd.writeUInt16LE(entries.length, 10);     // total entries in central dir
  eocd.writeUInt32LE(directory.length, 12);   // central directory size
  eocd.writeUInt32LE(offset, 16);             // central directory offset
  // comment length (20) — 0

  return Buffer.concat([...body, directory, eocd]);
}
