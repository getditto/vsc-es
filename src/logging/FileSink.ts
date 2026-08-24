import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const FILENAME = 'ditto-edge-studio.log';

export interface FileSinkOptions {
  maxBytes?: number;          // rotate when current >= this
  retain?: number;            // number of rotated files kept
  headerLines?: string[];     // written once when file is first created
  /** Called when a flush fails. The failed lines are dropped deliberately:
   *  requeueing them risks duplicating lines if appendFile partially wrote,
   *  and an ever-growing retry buffer is its own failure mode. Defaults to
   *  console.warn so a failure is at least visible somewhere — the Logger
   *  itself cannot be used here, because a broken file sink IS the Logger's
   *  failure mode. */
  onFlushError?: (err: unknown) => void;
}

const DEFAULTS: Required<FileSinkOptions> = {
  maxBytes: 5 * 1024 * 1024,  // 5 MB
  retain: 5,
  headerLines: [],
  // eslint-disable-next-line no-console -- last-resort visibility when the file sink itself is broken
  onFlushError: (err) => { console.warn('[FileSink] flush failed; buffered lines dropped:', err); },
};

export class FileSink {
  private readonly dir: string;
  private readonly opts: Required<FileSinkOptions>;
  private buffer: string[] = [];
  // Running byte count of `buffer`, maintained at push/drain time so write()
  // never re-scans the array (which made every write O(N) and produced a
  // stat storm inside each 250 ms flush window).
  private bufferBytes = 0;
  private flushing: Promise<void> = Promise.resolve();    // serializes writes
  private flushTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(dir: string, opts?: FileSinkOptions) {
    this.dir = dir;
    this.opts = { ...DEFAULTS, ...(opts ?? {}) };
  }

  async write(line: string): Promise<void> {
    if (this.disposed) return;
    const lineBytes = Buffer.byteLength(line);
    // If the buffer alone would push the next flush past maxBytes, flush it
    // first so rotation happens between bursts. Without this, bursty writes
    // coalesce into a single oversized payload and the rotation loop in
    // doFlush never gets a chance to rotate between them. This uses only the
    // running counter — the authoritative on-disk size check (which also
    // catches external growth) happens once per flush inside doFlush.
    if (this.buffer.length > 0 && this.bufferBytes + lineBytes > this.opts.maxBytes) {
      await this.flush();
    }
    this.buffer.push(line);
    this.bufferBytes += lineBytes;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush(); }, 250);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    // Chain onto the existing flush promise so writes are serialized. The
    // catch is load-bearing: without it one rejected flush (disk full,
    // permission error, …) permanently poisons the chain and every later
    // flush — including dispose() and readAllLogs()'s — silently no-ops.
    // Recovery is deliberate: failed lines are dropped (see onFlushError),
    // the chain resolves, and the next flush proceeds.
    this.flushing = this.flushing
      .then(() => this.doFlush())
      .catch((err: unknown) => {
        try { this.opts.onFlushError(err); } catch { /* a broken reporter must not re-poison the chain */ }
      });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const toWrite = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;
    if (toWrite.length === 0) return;

    await fs.mkdir(this.dir, { recursive: true });

    const active = path.join(this.dir, FILENAME);
    let needsHeader = false;
    try {
      await fs.access(active);
    } catch {
      needsHeader = true;
    }

    if (needsHeader && this.opts.headerLines.length > 0) {
      await fs.writeFile(active, this.opts.headerLines.join('\n') + '\n', 'utf8');
    }

    const payload = toWrite.join('');
    // Rotate-then-write loop: if current + payload exceeds threshold, rotate first.
    // Bail when rotate makes no progress (active file already gone), otherwise a
    // single oversized payload would loop forever.
    while (true) {
      let size = 0;
      try { size = (await fs.stat(active)).size; } catch { size = 0; }
      if (size + Buffer.byteLength(payload) <= this.opts.maxBytes) break;
      const didRotate = await this.rotate(active);
      if (!didRotate) break;
    }
    await fs.appendFile(active, payload, 'utf8');
  }

  private async rotate(active: string): Promise<boolean> {
    // Shift: .N-1 → .N, dropping anything beyond retain. Returns true if any
    // rename actually happened — caller uses this to terminate the rotation loop
    // when there's nothing left to shift.
    let didSomething = false;
    for (let i = this.opts.retain; i >= 1; i--) {
      const src = i === 1 ? active : `${active}.${i - 1}`;
      const dst = `${active}.${i}`;
      try {
        await fs.access(src);
        if (i === this.opts.retain) {
          // The slot we're overwriting is being dropped — that's fine.
          await fs.rename(src, dst).catch(async () => { await fs.unlink(dst).catch(() => {}); await fs.rename(src, dst); });
        } else {
          await fs.rename(src, dst);
        }
        didSomething = true;
      } catch {
        // src doesn't exist; nothing to shift.
      }
    }
    return didSomething;
  }

  /**
   * Newest `maxLines` lines across the rotation set, oldest-first.
   *
   * Reads backwards from the end of the newest file and stops as soon as it
   * has enough, because that is where the interesting lines are. The
   * alternative — `readAllChronological()` — pulls the entire retention window
   * into one string: with the defaults that is 6 files x 5 MB, and the caller
   * then splits it into ~300k more strings, only to discard nearly all of them
   * against a timestamp cutoff.
   *
   * Chunks are accumulated as *bytes* and only decoded from a line boundary
   * onwards. Decoding each chunk independently would corrupt any multi-byte
   * character straddling a chunk boundary.
   */
  async readTailLines(maxLines: number, chunkSize = 64 * 1024): Promise<string[]> {
    if (maxLines <= 0) { return []; }
    const active = path.join(this.dir, FILENAME);
    // Newest first: the active file, then .1, .2, … (rotate() shifts upwards,
    // so a higher suffix is older).
    const files = [active, ...Array.from({ length: this.opts.retain }, (_, i) => `${active}.${i + 1}`)];

    const newestFirst: string[] = [];
    for (const file of files) {
      if (newestFirst.length >= maxLines) { break; }
      // `maxLines`, not the remaining count: readFileTail appends to the shared
      // accumulator and compares against its total length.
      await this.readFileTail(file, maxLines, chunkSize, newestFirst);
    }
    return newestFirst.reverse();
  }

  /** Read backwards from the end of `file`, appending lines to `out` (newest
   *  first) until `out` holds `target` of them in total. */
  private async readFileTail(
    file: string, target: number, chunkSize: number, out: string[],
  ): Promise<void> {
    let handle;
    try { handle = await fs.open(file, 'r'); }
    catch { return; } // rotated away or never created
    try {
      const { size } = await handle.stat();
      let pos = size;
      // Leading bytes of the chunk just read, up to its first newline: an
      // incomplete line whose start lives in the (earlier) next chunk.
      let carry = Buffer.alloc(0);

      while (pos > 0 && out.length < target) {
        const len = Math.min(chunkSize, pos);
        pos -= len;
        const buf = Buffer.alloc(len);
        await handle.read(buf, 0, len, pos);
        const combined = Buffer.concat([buf, carry]);

        const firstNl = combined.indexOf(0x0a);
        if (firstNl === -1) { carry = combined; continue; }
        carry = combined.subarray(0, firstNl);
        // Starts just past a newline and ends where the previous carry ended
        // (itself a line boundary, or EOF), so this is whole lines only.
        const complete = combined.subarray(firstNl + 1).toString('utf8').split('\n');
        for (let i = complete.length - 1; i >= 0 && out.length < target; i -= 1) {
          const entry = complete[i];
          if (entry !== undefined && entry.length > 0) { out.push(entry); }
        }
      }
      // Reached the start of the file: the carry is its first line.
      if (pos === 0 && carry.length > 0 && out.length < target) {
        const first = carry.toString('utf8');
        if (first.length > 0) { out.push(first); }
      }
    } finally {
      await handle.close();
    }
  }

  async readAllChronological(): Promise<string> {
    const active = path.join(this.dir, FILENAME);
    const parts: string[] = [];
    // rotated: oldest first → highest index first
    for (let i = this.opts.retain; i >= 1; i--) {
      try {
        const txt = await fs.readFile(`${active}.${i}`, 'utf8');
        parts.push(txt);
      } catch {
        // missing; skip
      }
    }
    try {
      parts.push(await fs.readFile(active, 'utf8'));
    } catch {
      // no active file yet
    }
    return parts.join('');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.flush();
  }
}
