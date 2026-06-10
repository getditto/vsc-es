import { EventEmitter } from 'node:events';
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
  private readonly emitter = new EventEmitter();

  constructor(opts: AnalyzerSinkOptions = {}) {
    this.capacity = opts.capacity ?? 50_000;
  }

  write(_level: LogLevel, formatted: string): void {
    const id = this.nextId++;
    const line = parseLine(formatted, id);
    this.buf.push(line);
    if (this.buf.length > this.capacity) this.buf.shift();
    const listeners = this.emitter.listeners('line') as Array<(l: LogLine) => void>;
    for (const listener of listeners) {
      try { listener(line); } catch { /* isolate; Logger's try/catch already handles */ }
    }
  }

  onLine(listener: (line: LogLine) => void): { dispose(): void } {
    this.emitter.on('line', listener);
    return { dispose: () => this.emitter.off('line', listener) };
  }

  snapshot(): LogLine[] { return this.buf.slice(); }

  firstLiveId(): number { return this.buf.length === 0 ? 0 : this.buf[0].id; }
}
