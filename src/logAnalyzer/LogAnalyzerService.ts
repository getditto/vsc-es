import { EventEmitter } from 'node:events';
import type { LogLine, ProblemInstance, AnalyzerState, SummaryCounts } from './types.js';
import type { AnalyzerSink } from './AnalyzerSink.js';
import type { PatternEngine, CompiledPattern } from './PatternEngine.js';
import type { ConnectionTracker } from './ConnectionTracker.js';
import { parseLine } from './LineParser.js';
import { binVolumeByLevel, binProblemsOverTime, binDurations, pickBinWidth, type ProblemHit } from './Histograms.js';

const PROBLEM_CAP = 1000;

export type AnalyzerDiff =
  | { type: 'reset' }
  | { type: 'summary', counts: SummaryCounts }
  | { type: 'problemsAdded', items: ProblemInstance[] }
  | { type: 'sessionsUpdated', sessions: AnalyzerState['sessions'] }
  | { type: 'histogramsUpdated', histograms: AnalyzerState['histograms'] }
  | { type: 'live', lines: LogLine[] }
  | { type: 'error', stage: 'backfill' | 'live', message: string };

interface ServiceOptions {
  sink: AnalyzerSink;
  engine: PatternEngine;
  tracker: ConnectionTracker;
  throttleMs?: number;
  now?: () => number;
}

export class LogAnalyzerService {
  private state: AnalyzerState = emptyState();
  private readonly emitter = new EventEmitter();
  private liveSub: { dispose(): void } | null = null;
  private paused = false;
  private backfillIdCursor = -1;
  private problemHits: ProblemHit[] = [];
  private lastFlush = 0;
  private throttleMs: number;

  constructor(private readonly opts: ServiceOptions) {
    this.throttleMs = opts.throttleMs ?? 250;
  }

  start(p: { backfillText?: string } = {}): void {
    if (p.backfillText) {
      this.processBackfill(p.backfillText);
    }
    this.liveSub = this.opts.sink.onLine(l => this.processLine(l));
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.flush(); }

  clear(): void {
    this.state = emptyState();
    this.problemHits = [];
    this.emit({ type: 'reset' });
  }

  dispose(): void {
    this.liveSub?.dispose();
    this.liveSub = null;
  }

  onDiff(listener: (d: AnalyzerDiff) => void): { dispose(): void } {
    this.emitter.on('diff', listener);
    return { dispose: () => this.emitter.off('diff', listener) };
  }

  getStateForTesting(): AnalyzerState { return this.state; }

  private processBackfill(text: string): void {
    try {
      const lines = text.split('\n').filter(s => s.length > 0);
      for (const raw of lines) {
        const id = this.backfillIdCursor--;
        const line = parseLine(raw, id);
        this.processLine(line, true);
      }
    } catch (err) {
      this.emit({ type: 'error', stage: 'backfill', message: String(err) });
    }
  }

  private processLine(line: LogLine, isBackfill = false): void {
    this.state.counts.totalLines++;
    if (line.timestamp == null) this.state.counts.unparseableLines++;
    if (line.tag) this.state.tags.add(line.tag);
    if (line.timestamp) {
      if (!this.state.startTime || line.timestamp < this.state.startTime) this.state.startTime = line.timestamp;
      if (!this.state.endTime || line.timestamp > this.state.endTime) this.state.endTime = line.timestamp;
    }
    switch (line.level) {
      case 'error': this.state.counts.errors++; break;
      case 'warn':  this.state.counts.warnings++; break;
    }

    let hits: CompiledPattern[];
    try { hits = this.opts.engine.scan(line); }
    catch { hits = []; }
    for (const h of hits) {
      const list = this.state.problems.get(h.key) ?? [];
      if (list.length < PROBLEM_CAP) {
        list.push({ patternKey: h.key, severity: h.severity, recommendation: h.recommendation, line });
        this.state.problems.set(h.key, list);
        if (!isBackfill) {
          this.emitter.emit('diff', {
            type: 'problemsAdded',
            items: [{ patternKey: h.key, severity: h.severity, recommendation: h.recommendation, line }],
          });
        }
      }
      this.state.counts.problems++;
      if (h.severity === 5) this.state.counts.critical++;
      if (line.timestamp) this.problemHits.push({ time: line.timestamp, severity: h.severity });
    }

    try { this.opts.tracker.consume(line); }
    catch { /* tracker swallows by design */ }
    const prevSessions = this.state.sessions;
    this.state.sessions = this.opts.tracker.snapshot();
    this.state.reinits = this.opts.tracker.reinits();
    // Emit sessionsUpdated diff when sessions array changes (length differs or any session end change).
    // For simplicity: emit on each new session detected. Backfill emits aren't gated separately.
    if (this.state.sessions.length !== prevSessions.length) {
      this.emitter.emit('diff', { type: 'sessionsUpdated', sessions: [...this.state.sessions] });
    }

    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (this.paused) return;
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.lastFlush < this.throttleMs) return;
    this.lastFlush = now;
    this.flush();
  }

  private flush(): void {
    this.recomputeHistograms();
    this.emit({ type: 'summary', counts: { ...this.state.counts } });
    this.emit({ type: 'histogramsUpdated', histograms: this.state.histograms });
  }

  private recomputeHistograms(): void {
    const range = this.state.startTime && this.state.endTime
      ? this.state.endTime.getTime() - this.state.startTime.getTime()
      : 0;
    const binMs = pickBinWidth(Math.max(range, 1000));
    this.state.histograms.problemsOverTime = binProblemsOverTime(this.problemHits, binMs);
    this.state.histograms.volumeByLevel = binVolumeByLevel(this.opts.sink.snapshot(), binMs);
    this.state.histograms.connectionDurations = binDurations(
      this.state.sessions
        .filter(s => s.end)
        .map(s => ({ duration: ((s.end as Date).getTime() - s.start.getTime()) / 1000 })),
    );
  }

  private emit(d: AnalyzerDiff): void { this.emitter.emit('diff', d); }
}

function emptyState(): AnalyzerState {
  return {
    counts: { critical: 0, errors: 0, warnings: 0, problems: 0, totalLines: 0, unparseableLines: 0 },
    problems: new Map(),
    sessions: [],
    reinits: [],
    histograms: { volumeByLevel: [], problemsOverTime: [], connectionDurations: [] },
    startTime: null, endTime: null,
    sdkVersion: null,
    tags: new Set(),
  };
}
