import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const FILENAME = 'ditto-edge-studio.log';

export interface FileSinkOptions {
  maxBytes?: number;          // rotate when current >= this
  retain?: number;            // number of rotated files kept
  headerLines?: string[];     // written once when file is first created
}

const DEFAULTS: Required<FileSinkOptions> = {
  maxBytes: 5 * 1024 * 1024,  // 5 MB
  retain: 5,
  headerLines: [],
};

export class FileSink {
  private readonly dir: string;
  private readonly opts: Required<FileSinkOptions>;
  private buffer: string[] = [];
  private flushing: Promise<void> = Promise.resolve();    // serializes writes
  private flushTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(dir: string, opts?: FileSinkOptions) {
    this.dir = dir;
    this.opts = { ...DEFAULTS, ...(opts ?? {}) };
  }

  async write(line: string): Promise<void> {
    if (this.disposed) return;
    // If buffering this line would push the next flush past maxBytes, flush
    // the current buffer first so rotation happens between bursts. Without this,
    // bursty writes coalesce into a single oversized payload and the rotation
    // loop in doFlush never gets a chance to rotate between them.
    if (this.buffer.length > 0) {
      let activeSize = 0;
      try { activeSize = (await fs.stat(path.join(this.dir, FILENAME))).size; } catch { /* file missing */ }
      const bufBytes = this.buffer.reduce((s, l) => s + Buffer.byteLength(l), 0);
      if (activeSize + bufBytes + Buffer.byteLength(line) > this.opts.maxBytes) {
        await this.flush();
      }
    }
    this.buffer.push(line);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { void this.flush(); }, 250);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    // Chain onto the existing flush promise so writes are serialized.
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const toWrite = this.buffer;
    this.buffer = [];
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

    let payload = toWrite.join('');
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
