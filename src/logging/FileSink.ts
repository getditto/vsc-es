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

    // 0700 dir / 0600 files: these logs carry query text, collection names,
    // and document contents from the user's database, and on a shared or
    // multi-user host the process umask alone would otherwise leave them
    // world-readable. Owner-only is the correct posture for something the
    // user is later invited to export and attach to a bug report.
    // (No-op on Windows, which ignores the mode bits.)
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.chmod(this.dir, 0o700);
    }

    const active = path.join(this.dir, FILENAME);
    let needsHeader = false;
    try {
      await fs.access(active);
    } catch { needsHeader = true; }

    if (!needsHeader && process.platform !== 'win32') {
      await fs.chmod(active, 0o600);
    }

    if (needsHeader && this.opts.headerLines.length > 0) {
      await fs.writeFile(active, this.opts.headerLines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    }

    const payload = toWrite.join('');
    // Rotate-then-write: if the current content plus this payload would
    // exceed the threshold, rotate the active file FIRST so the burst lands
    // in a fresh file and the previous content keeps its own backup.
    //
    // The active file is rotated AT MOST ONCE per flush. Rotating again
    // would move no content (the active file is already gone) but would
    // churn the backup set — shifting .1→.2, .2→.3 and dropping the oldest
    // — silently discarding log history. A payload larger than the
    // threshold on its own is written as one (over-sized) active file.
    let size = 0;
    try { size = (await fs.stat(active)).size; } catch { /* file absent → size stays 0 */ }
    if (size + Buffer.byteLength(payload) > this.opts.maxBytes) {
      await this.rotate(active);
    }
    // `mode` applies only when appendFile has to create the file (the common
    // case right after a rotate); it does not widen an existing file.
    await fs.appendFile(active, payload, { encoding: 'utf8', mode: 0o600 });
  }

  private async rotate(active: string): Promise<boolean> {
    // retain 0 means "keep no backups" — the old content is discarded
    // outright instead of being renamed. Without this special case the
    // rename loop below never runs (it starts at `retain`), so the active
    // file would never rotate and would grow without bound.
    if (this.opts.retain < 1) {
      try {
        await fs.rm(active, { force: true });
        return true;
      } catch {
        return false;
      }
    }
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

  /** Every log file in the set: the active file plus every `.<N>` rotation,
   *  INCLUDING strays with an index beyond the current retain count (left
   *  behind when retain shrinks — rotation alone would never touch them). */
  private async allLogFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return []; // log dir not created yet
    }
    return names
      .filter(n => n === FILENAME || n.match(new RegExp(`^${FILENAME.replace('.', '\\.')}\\.\\d+$`)))
      .map(n => path.join(this.dir, n));
  }

  /**
   * Update the rotation limits at runtime (from the `dittoVsce.log*`
   * settings). Rotations beyond the new retain count are deleted
   * immediately; otherwise they would sit on disk forever, since rotation
   * only ever shifts indices up to `retain`. An active file that already
   * exceeds a shrunken maxBytes is rotated right away rather than waiting
   * for the next line.
   */
  async setLimits(limits: { maxBytes?: number; retain?: number }): Promise<void> {
    this.opts.maxBytes = limits.maxBytes ?? this.opts.maxBytes;
    this.opts.retain = limits.retain ?? this.opts.retain;
    const active = path.join(this.dir, FILENAME);
    for (const file of await this.allLogFiles()) {
      const m = file.match(/\.(\d+)$/);
      if (m && Number.parseInt(m[1]!, 10) > this.opts.retain) {
        await fs.rm(file, { force: true }).catch(() => {});
      }
    }
    // Rotate the active file now if it already exceeds a shrunken maxBytes —
    // doFlush's size check only runs when there are buffered lines to write,
    // so without this an over-limit active file would keep growing until the
    // next line arrived.
    try {
      const { size } = await fs.stat(active);
      if (size > this.opts.maxBytes) { await this.rotate(active); }
    } catch { /* no active file yet */ }
  }

  /**
   * Delete every rotated backup older than `maxAgeMs` (by mtime). The active
   * file is never touched — it is live state. Rotations with an index beyond
   * the current retain count are strays and are deleted regardless of age.
   * Returns the number of files deleted. Runs at extension activation, the
   * same point VS Code core prunes its own session log directories.
   */
  async pruneRotationsOlderThan(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let deleted = 0;
    for (const file of await this.allLogFiles()) {
      const m = file.match(/\.(\d+)$/);
      if (!m) { continue; } // the active file — never pruned
      const stray = Number.parseInt(m[1]!, 10) > this.opts.retain;
      let mtime: number;
      try { mtime = (await fs.stat(file)).mtimeMs; } catch { continue; }
      if (stray || mtime < cutoff) {
        await fs.rm(file, { force: true }).catch(() => {});
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Delete the entire log set — active file and all rotations — after
   * flushing any buffered lines (so a pending flush can't recreate the file
   * with stale content after the delete). The next write re-creates the
   * active file with its session header, exactly as on first launch.
   * Backs the Clear Application Log command.
   */
  async clear(): Promise<void> {
    await this.flush();
    for (const file of await this.allLogFiles()) {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.flush();
  }
}
