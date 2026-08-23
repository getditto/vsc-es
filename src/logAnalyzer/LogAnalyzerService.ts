import { EventEmitter } from 'node:events';
import type { LogLine, ProblemInstance, AnalyzerState, SummaryCounts } from './types.js';
import type { AnalyzerSink } from './AnalyzerSink.js';
import type { PatternEngine, CompiledPattern } from './PatternEngine.js';
import type { ConnectionTracker } from './ConnectionTracker.js';
import { parseLine } from './LineParser.js';
import { binVolumeByLevel, binProblemsOverTime, binDurations, pickBinWidth, type ProblemHit } from './Histograms.js';

const PROBLEM_CAP = 1000;
const LINE_BUFFER_CAP = 50_000;
/** Cap on the problems-over-time histogram's source data. Unlike
 *  state.problems (capped per pattern at PROBLEM_CAP), this array feeds
 *  only the histogram — past the cap the oldest hits are trimmed in
 *  chunks, keeping the per-line cost amortized O(1). */
const PROBLEM_HITS_CAP = 10_000;

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
  private lineBuffer: LogLine[] = [];
  /** Problem hits since the last flush, emitted as one batched
   *  problemsAdded diff — per-line emits were an unthrottled postMessage
   *  storm to the webview under a chatty pattern. Bounded because items
   *  only land here while their pattern is under PROBLEM_CAP. */
  private pendingProblems: ProblemInstance[] = [];
  private lastTrackerVersion = -1;

  constructor(private readonly opts: ServiceOptions) {
    this.throttleMs = opts.throttleMs ?? 250;
  }

  start(p: { backfillText?: string; minTimestamp?: Date } = {}): void {
    if (p.backfillText) {
      this.processBackfill(p.backfillText, p.minTimestamp);
    }
    this.liveSub = this.opts.sink.onLine(l => this.processLine(l));
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.flush(); }

  clear(): void {
    this.state = emptyState();
    this.problemHits = [];
    this.lineBuffer = [];
    this.pendingProblems = [];
    // The tracker owns the session history that state.sessions mirrors, so
    // it has to be cleared too — otherwise the next connection event
    // resurrects everything from before the Clear. Resetting the version
    // gate alongside it keeps the two from diverging: state.sessions is now
    // empty, and without this the gate would suppress the re-snapshot and
    // leave the Sessions view stranded at empty until a tracker mutation.
    this.opts.tracker.reset();
    this.lastTrackerVersion = this.opts.tracker.getVersion();
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

  /** Filtered + searched view over the buffered lines. Returns newest first.
   *
   *  Filter rules:
   *    - 'all'      → every line
   *    - 'critical' → lines that match any problem with severity 5
   *    - 'error'    → line.level === 'error'
   *    - 'warn'     → line.level === 'warn'
   *    - 'problem'  → line.id appears in any ProblemInstance across all pattern keys
   *
   *  `search` is a case-insensitive substring match against line.text + line.tag.
   *  Returns newest-first, plus the TOTAL count (pre-pagination) so the UI can
   *  show "1/12,403". */
  public queryLines(opts: {
    level?: 'critical' | 'error' | 'warn' | 'problem' | 'all';
    filter?: 'critical' | 'error' | 'warn' | 'problem' | 'all';
    search?: string;
    limit?: number;
    offset?: number;
  }): { items: LogLine[]; total: number } {
    // Accept both `level` and `filter` for flexibility — the IPC layer
    // sends `filter`, but the original spec called it `level`.
    const filter = opts.filter ?? opts.level ?? 'all';
    const search = opts.search?.trim().toLowerCase() ?? '';
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;

    // Build a set of "problem line ids" once when needed.
    let problemIds: Set<number> | null = null;
    let criticalIds: Set<number> | null = null;
    if (filter === 'problem' || filter === 'critical') {
      problemIds = new Set();
      criticalIds = new Set();
      for (const list of this.state.problems.values()) {
        for (const p of list) {
          problemIds.add(p.line.id);
          if (p.severity === 5) criticalIds.add(p.line.id);
        }
      }
    }

    // Walk newest-first so we can paginate without sorting the whole buffer.
    const matched: LogLine[] = [];
    for (let i = this.lineBuffer.length - 1; i >= 0; i--) {
      const line = this.lineBuffer[i];
      let pass = false;
      switch (filter) {
        case 'all':      pass = true; break;
        case 'error':    pass = line.level === 'error'; break;
        case 'warn':     pass = line.level === 'warn'; break;
        case 'problem':  pass = problemIds!.has(line.id); break;
        case 'critical': pass = criticalIds!.has(line.id); break;
      }
      if (!pass) continue;
      if (search.length > 0) {
        const userTagsHay = line.userTags ? ' ' + line.userTags.join(' ') : '';
        const hay = (line.text + ' ' + (line.tag ?? '') + userTagsHay).toLowerCase();
        if (!hay.includes(search)) continue;
      }
      matched.push(line);
    }

    const total = matched.length;
    const items = matched.slice(offset, offset + limit);
    return { items, total };
  }

  /** Used by the detail-drawer to fetch surrounding context. Linear scan
   *  on the bounded buffer (≤2× LINE_BUFFER_CAP between chunked trims) —
   *  acceptable for on-demand use. */
  public getLineDetail(lineId: number, contextBefore = 5, contextAfter = 5): {
    line: LogLine | null;
    before: LogLine[];
    after: LogLine[];
  } {
    const idx = this.lineBuffer.findIndex(l => l.id === lineId);
    if (idx < 0) return { line: null, before: [], after: [] };
    const line = this.lineBuffer[idx];
    const beforeStart = Math.max(0, idx - contextBefore);
    const afterEnd = Math.min(this.lineBuffer.length, idx + 1 + contextAfter);
    const before = this.lineBuffer.slice(beforeStart, idx);
    const after = this.lineBuffer.slice(idx + 1, afterEnd);
    return { line, before, after };
  }

  private processBackfill(text: string, minTimestamp?: Date): void {
    try {
      const lines = text.split('\n').filter(s => s.length > 0);
      const cutoffMs = minTimestamp?.getTime();
      for (const raw of lines) {
        const id = this.backfillIdCursor--;
        const line = parseLine(raw, id);
        // Drop lines older than the scope's connect time. Lines that
        // failed to parse a timestamp (line.timestamp === null) are
        // ALSO dropped when a cutoff is set — without a timestamp we
        // can't prove they belong to this connection. Without a
        // cutoff (legacy callers), every parseable line is admitted.
        if (cutoffMs !== undefined) {
          if (!line.timestamp || line.timestamp.getTime() < cutoffMs) continue;
        }
        this.processLine(line, true);
      }
    } catch (err) {
      this.emit({ type: 'error', stage: 'backfill', message: String(err) });
    }
  }

  private processLine(line: LogLine, isBackfill = false): void {
    this.lineBuffer.push(line);
    // Trim in chunks rather than shift() per line — at the 50k cap a
    // per-line shift is an O(n) memmove on every log line under
    // sustained volume. The buffer may briefly hold up to 2× the cap.
    if (this.lineBuffer.length > LINE_BUFFER_CAP * 2) {
      this.lineBuffer.splice(0, this.lineBuffer.length - LINE_BUFFER_CAP);
    }
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
    // Collect user_tag values across all matched patterns. Multiple
    // patterns can match a single line; each may contribute its own
    // tag. Sorted + deduped so the UI gets a stable display order and
    // the same tag from N patterns doesn't appear N times.
    const userTagSet = new Set<string>();
    for (const h of hits) {
      const list = this.state.problems.get(h.key) ?? [];
      if (list.length < PROBLEM_CAP) {
        const item = { patternKey: h.key, severity: h.severity, recommendation: h.recommendation, line };
        list.push(item);
        this.state.problems.set(h.key, list);
        if (!isBackfill) { this.pendingProblems.push(item); }
      }
      this.state.counts.problems++;
      if (h.severity === 5) this.state.counts.critical++;
      if (line.timestamp) {
        this.problemHits.push({ time: line.timestamp, severity: h.severity });
        if (this.problemHits.length > PROBLEM_HITS_CAP * 2) {
          this.problemHits.splice(0, this.problemHits.length - PROBLEM_HITS_CAP);
        }
      }
      if (h.userTag) userTagSet.add(h.userTag);
    }
    if (userTagSet.size > 0) {
      line.userTags = [...userTagSet].sort();
    }

    try { this.opts.tracker.consume(line); }
    catch { /* tracker swallows by design */ }
    // The tracker exposes a mutation version so we only copy the session
    // and reinit arrays when something actually changed — snapshotting per
    // log line was an O(sessions) copy on every line.
    const trackerVersion = this.opts.tracker.getVersion();
    if (trackerVersion !== this.lastTrackerVersion) {
      const prevSessionCount = this.state.sessions.length;
      this.lastTrackerVersion = trackerVersion;
      this.state.sessions = this.opts.tracker.snapshot();
      this.state.reinits = this.opts.tracker.reinits();
      // Emit sessionsUpdated diff when sessions array changes (length differs or any session end change).
      // For simplicity: emit on each new session detected. Backfill emits aren't gated separately.
      if (this.state.sessions.length !== prevSessionCount) {
        this.emitter.emit('diff', { type: 'sessionsUpdated', sessions: [...this.state.sessions] });
      }
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
    // Batched problem hits first — one diff per flush, not one per line.
    if (this.pendingProblems.length > 0) {
      this.emit({ type: 'problemsAdded', items: this.pendingProblems });
      this.pendingProblems = [];
    }
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
