import type { Sink } from '../logging/Sink.js';
import type { LogLevel } from '../logging/types.js';
import type { LogLine } from './types.js';
import { parseLine } from './LineParser.js';

interface AnalyzerSinkOptions {
  capacity?: number;
}

export class AnalyzerSink implements Sink {
  private readonly capacity: number;
  private readonly buf: LogLine[] = [];
  private nextId = 0;
  private listeners: ReadonlyArray<(line: LogLine) => void> = [];

  constructor(opts: AnalyzerSinkOptions = {}) {
    this.capacity = opts.capacity ?? 50_000;
  }

  write(_level: LogLevel, formatted: string): void {
    const id = this.nextId++;
    const line = parseLine(formatted, id);
    this.buf.push(line);
    // Trim in chunks rather than shift() per line — at a 50k capacity a
    // per-line shift is an O(n) memmove on every log line under sustained
    // volume. snapshot()/firstLiveId() project the exact-capacity window,
    // so the observable contract is unchanged.
    if (this.buf.length > this.capacity * 2) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
    // Iterate a plain array rather than EventEmitter.listeners(), which
    // allocates a fresh copy on every call — i.e. once per log line. A copy is
    // still taken when the set changes, so a listener disposing itself mid-
    // dispatch cannot corrupt the walk.
    for (const listener of this.listeners) {
      try { listener(line); } catch { /* isolate; Logger's try/catch already handles */ }
    }
  }

  onLine(listener: (line: LogLine) => void): { dispose(): void } {
    this.listeners = [...this.listeners, listener];
    return {
      dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); },
    };
  }

  /** Newest `capacity` lines — the internal buffer may briefly hold more
   *  between chunked trims, so project the exact window here. */
  snapshot(): LogLine[] {
    return this.buf.length > this.capacity ? this.buf.slice(-this.capacity) : this.buf.slice();
  }

  firstLiveId(): number {
    const first = this.buf[Math.max(0, this.buf.length - this.capacity)];
    return first ? first.id : 0;
  }
}
