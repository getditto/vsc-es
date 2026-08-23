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
  /** `counts` plus the rest of the summary header. tags/sdkVersion/range used
   *  to live only in the internal state, which was never transmitted — so the
   *  header showed "Tags: none / SDK: unknown / Range: n/a" permanently. */
  | {
      type: 'summary',
      counts: SummaryCounts,
      tags: string[],
      sdkVersion: string | null,
      startTimeMs: number | null,
      endTimeMs: number | null,
    }
  | { type: 'problemsAdded', items: ProblemInstance[] }
  | { type: 'sessionsUpdated', sessions: AnalyzerState['sessions'] }
  | { type: 'histogramsUpdated', histograms: AnalyzerState['histograms'] }
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
  /** Pending trailing-edge flush. See maybeFlush. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Line ids that are listable under the Problems / Critical filters.
   *  Maintained incrementally rather than rebuilt per query: queryLines runs
   *  on every flush (~4/s) and rebuilt these sets from state.problems each
   *  time. They are also what the tab badges must count — `counts.problems`
   *  counts occurrences, which is a different and larger number. */
  private problemLineIds = new Set<number>();
  private criticalLineIds = new Set<number>();

  constructor(private readonly opts: ServiceOptions) {
    this.throttleMs = opts.throttleMs ?? 250;
  }

  start(p: { backfillText?: string; minTimestamp?: Date } = {}): void {
    // Dispose first: start() is called again by the panel's refresh, and
    // overwriting liveSub left the previous subscription attached, so every
    // later line was processed once per start() — counts and the line buffer
    // both multiplied.
    this.liveSub?.dispose();
    if (p.backfillText) {
      this.processBackfill(p.backfillText, p.minTimestamp);
    }
    this.liveSub = this.opts.sink.onLine(l => this.processLine(l));
    // Flush unconditionally after backfill. maybeFlush is throttled on the
    // leading edge, so a backfill of N lines emitted exactly one summary — the
    // one after the FIRST line — and if the log then went quiet (the normal
    // case for a panel opened on an idle connection) nothing ever corrected
    // it. That is the "Errors: 0 with four errors in the table" report.
    this.forceFlush();
  }

  pause(): void { this.paused = true; }

  resume(): void {
    this.paused = false;
    // Everything that accumulated while paused is emitted in one flush.
    this.forceFlush();
  }

  clear(): void {
    this.state = emptyState();
    this.problemHits = [];
    this.lineBuffer = [];
    this.pendingProblems = [];
    this.problemLineIds.clear();
    this.criticalLineIds.clear();
    // The tracker owns the session history that state.sessions mirrors, so
    // it has to be cleared too — otherwise the next connection event
    // resurrects everything from before the Clear. Resetting the version
    // gate alongside it keeps the two from diverging: state.sessions is now
    // empty, and without this the gate would suppress the re-snapshot and
    // leave the Sessions view stranded at empty until a tracker mutation.
    this.opts.tracker.reset();
    this.lastTrackerVersion = this.opts.tracker.getVersion();
    // Let the next line flush immediately rather than sitting behind the
    // throttle window left over from before the Clear.
    this.lastFlush = 0;
    this.cancelScheduledFlush();
    this.emit({ type: 'reset' });
  }

  dispose(): void {
    this.liveSub?.dispose();
    this.liveSub = null;
    this.cancelScheduledFlush();
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

    // The id sets are maintained incrementally in processLine — rebuilding
    // them here re-walked every stored problem on every query, and queryLines
    // is issued on each flush.
    const problemIds = this.problemLineIds;
    const criticalIds = this.criticalLineIds;

    // Walk newest-first so we can paginate without sorting the whole buffer.
    const matched: LogLine[] = [];
    for (let i = this.lineBuffer.length - 1; i >= 0; i--) {
      const line = this.lineBuffer[i];
      let pass = false;
      switch (filter) {
        case 'all':      pass = true; break;
        case 'error':    pass = line.level === 'error'; break;
        case 'warn':     pass = line.level === 'warn'; break;
        case 'problem':  pass = problemIds.has(line.id); break;
        case 'critical': pass = criticalIds.has(line.id); break;
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
    // The SDK announces itself once per init, e.g. `… sdk.version=5.1.0 …`.
    // Nothing populated this field before, so the header read "SDK: unknown"
    // for the life of the panel. Guarded on null so it is one regex per line
    // until the first match, not per line forever.
    if (this.state.sdkVersion === null && line.text.includes('sdk.version=')) {
      const m = /\bsdk\.version=(\S+)/.exec(line.text);
      if (m) { this.state.sdkVersion = m[1]; }
    }
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
        // Only ids that were actually stored are listable by the filters.
        this.problemLineIds.add(line.id);
        if (h.severity === 5) { this.criticalLineIds.add(line.id); }
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
    // NOTE: the session snapshot deliberately does NOT happen here. It is an
    // O(sessions) array copy, and doing it per line made ingestion quadratic
    // whenever sessions accumulated — measured at 28k lines/s falling to 9.6k
    // by 40k lines, against 870k/s for lines the tracker ignores. state.sessions
    // is only read at flush time, so that is where it is refreshed.
    this.maybeFlush();
  }

  private maybeFlush(): void {
    if (this.paused) return;
    const now = this.opts.now?.() ?? Date.now();
    if (now - this.lastFlush >= this.throttleMs) {
      this.cancelScheduledFlush();
      this.lastFlush = now;
      this.flush();
      return;
    }
    // Leading-edge-only throttling silently drops the tail of every burst:
    // the first line of a burst flushes, the rest are swallowed, and if no
    // further line arrives there is nothing left to trigger a flush. The UI
    // then shows the state as of one line, indefinitely. Schedule the
    // trailing edge so the last lines of a burst always land.
    if (this.flushTimer === null) {
      const wait = Math.max(0, this.throttleMs - (now - this.lastFlush));
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.paused) { return; }
        this.lastFlush = this.opts.now?.() ?? Date.now();
        this.flush();
      }, wait);
      // Never hold the extension host (or a test process) open for a flush.
      this.flushTimer.unref?.();
    }
  }

  /** Flush now, regardless of the throttle. */
  private forceFlush(): void {
    if (this.paused) { return; }
    this.cancelScheduledFlush();
    this.lastFlush = this.opts.now?.() ?? Date.now();
    this.flush();
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flush(): void {
    // Batched problem hits first — one diff per flush, not one per line.
    if (this.pendingProblems.length > 0) {
      this.emit({ type: 'problemsAdded', items: this.pendingProblems });
      this.pendingProblems = [];
    }
    // Refresh the session view once per flush rather than once per line. The
    // tracker's version counter makes this a no-op when nothing changed, and
    // recomputeHistograms below reads state.sessions, so it has to come first.
    this.refreshSessions();
    this.recomputeHistograms();
    this.emit({
      type: 'summary',
      counts: {
        ...this.state.counts,
        problemLines: this.problemLineIds.size,
        criticalLines: this.criticalLineIds.size,
      },
      tags: [...this.state.tags].sort(),
      sdkVersion: this.state.sdkVersion,
      startTimeMs: this.state.startTime?.getTime() ?? null,
      endTimeMs: this.state.endTime?.getTime() ?? null,
    });
    this.emit({ type: 'histogramsUpdated', histograms: this.state.histograms });
  }

  /** Copy the tracker's sessions into the state, if it has changed. */
  private refreshSessions(): void {
    const trackerVersion = this.opts.tracker.getVersion();
    if (trackerVersion === this.lastTrackerVersion) { return; }
    this.lastTrackerVersion = trackerVersion;
    const prevSessionCount = this.state.sessions.length;
    this.state.sessions = this.opts.tracker.snapshot();
    this.state.reinits = this.opts.tracker.reinits();
    if (this.state.sessions.length !== prevSessionCount) {
      this.emit({ type: 'sessionsUpdated', sessions: [...this.state.sessions] });
    }
  }

  private recomputeHistograms(): void {
    const range = this.state.startTime && this.state.endTime
      ? this.state.endTime.getTime() - this.state.startTime.getTime()
      : 0;
    const binMs = pickBinWidth(Math.max(range, 1000));
    this.state.histograms.problemsOverTime = binProblemsOverTime(this.problemHits, binMs);
    // this.lineBuffer, NOT sink.snapshot(). The sink is shared by every
    // database's analyzer and holds only lines the extension logged live —
    // it excludes backfill (read from the rotated log file) and includes
    // other connections' lines. Binning it produced a histogram over a
    // completely different population than every other number on screen,
    // and one that Clear could not empty.
    this.state.histograms.volumeByLevel = binVolumeByLevel(this.lineBuffer, binMs);
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
    counts: {
      critical: 0, errors: 0, warnings: 0, problems: 0,
      problemLines: 0, criticalLines: 0, totalLines: 0, unparseableLines: 0,
    },
    problems: new Map(),
    sessions: [],
    reinits: [],
    histograms: { volumeByLevel: [], problemsOverTime: [], connectionDurations: [] },
    startTime: null, endTime: null,
    sdkVersion: null,
    tags: new Set(),
  };
}
