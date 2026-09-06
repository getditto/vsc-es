import { EventEmitter } from 'node:events';
import type { LogLevel } from '../logging/types.js';
import type { LogLine, ProblemInstance, AnalyzerState, SummaryCounts } from './types.js';
import type { AnalyzerSink } from './AnalyzerSink.js';
import type { PatternEngine, CompiledPattern } from './PatternEngine.js';
import type { ConnectionTracker } from './ConnectionTracker.js';
import { parseLine } from './LineParser.js';
import { binProblemsOverTime, binDurations, pickBinWidth, type ProblemHit } from './Histograms.js';
import {
  logTagForSource,
  TRANSPORT_CONDITIONS_TAG,
  CONNECTION_REQUESTS_TAG,
  type AnalyzerSource,
} from './log-sources.js';

const PROBLEM_CAP = 1000;
const LINE_BUFFER_CAP = 50_000;
/** Finest granularity the volume histogram ever renders at
 *  (NICE_BINS_MS[0]). Ingest bins into per-second buckets so the flush-time
 *  histogram is a merge of O(bins) instead of a re-scan of O(lines). Every
 *  coarser width in NICE_BINS_MS is a multiple of this, so each fine bin maps
 *  into exactly one display bin. */
const VOLUME_BIN_MS = 1000;
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
      /** Buffered line counts for the two log-only SDK observer sources
       *  (src/ditto/session-log-observers.ts). The webview badges the
       *  source tabs with these; they are buffer-scoped like the filter
       *  tab badges, so trims and Clear move them the same way. */
      sourceCounts: { transport: number; connectionRequests: number },
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
  /** Per-second volume-by-level bins over the CURRENT line buffer,
   *  incremented at ingest and decremented when the buffer's chunked trim
   *  drops lines. Lets flush-time histograms merge bins rather than re-scan
   *  up to 100k lines. */
  private volumeBins = new Map<number, Record<LogLevel, number>>();
  /** Counts over the current line buffer (state.counts is cumulative and
   *  keeps growing across trims). queryLines serves un-searched totals from
   *  these instead of walking the buffer. */
  private bufferErrors = 0;
  private bufferWarnings = 0;
  private bufferProblemLines = 0;
  private bufferCriticalLines = 0;
  /** Buffered lines carrying each log-only SDK observer source's tag.
   *  Tracked alongside the level counters above so the summary can badge
   *  the source tabs without a buffer scan per flush. */
  private bufferTransportLines = 0;
  private bufferConnectionRequestLines = 0;

  constructor(private readonly opts: ServiceOptions) {
    this.throttleMs = opts.throttleMs ?? 250;
  }

  /** Upper bound on retained lines. Also the right number of lines to ask a
   *  backfill provider for: the buffer keeps the newest LINE_BUFFER_CAP, so
   *  anything older would be read and then dropped. */
  static readonly BACKFILL_LINE_LIMIT = LINE_BUFFER_CAP;

  start(p: { backfillLines?: readonly string[]; minTimestamp?: Date | undefined } = {}): void {
    // Dispose first: start() is called again by the panel's refresh, and
    // overwriting liveSub left the previous subscription attached, so every
    // later line was processed once per start() — counts and the line buffer
    // both multiplied.
    this.liveSub?.dispose();
    if (p.backfillLines && p.backfillLines.length > 0) {
      this.processBackfill(p.backfillLines, p.minTimestamp);
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
    this.volumeBins.clear();
    this.bufferErrors = 0;
    this.bufferWarnings = 0;
    this.bufferProblemLines = 0;
    this.bufferCriticalLines = 0;
    this.bufferTransportLines = 0;
    this.bufferConnectionRequestLines = 0;
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
   *  `source` further restricts to one log-only SDK observer source
   *  ('transport' → TRANSPORT_CONDITIONS_TAG lines, 'connectionRequests' →
   *  CONNECTION_REQUESTS_TAG lines); 'all'/undefined keeps every tag.
   *
   *  `search` is a case-insensitive substring match against line.text + line.tag.
   *  Returns newest-first, plus the TOTAL count (pre-pagination) so the UI can
   *  show "1/12,403". */
  public queryLines(opts: {
    level?: 'critical' | 'error' | 'warn' | 'problem' | 'all';
    filter?: 'critical' | 'error' | 'warn' | 'problem' | 'all';
    source?: AnalyzerSource | undefined;
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): { items: LogLine[]; total: number } {
    // Accept both `level` and `filter` for flexibility — the IPC layer
    // sends `filter`, but the original spec called it `level`.
    const filter = opts.filter ?? opts.level ?? 'all';
    const sourceTag = logTagForSource(opts.source);
    const search = opts.search?.trim().toLowerCase() ?? '';
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;

    // The id sets are maintained incrementally in processLine — rebuilding
    // them here re-walked every stored problem on every query, and queryLines
    // is issued on each flush.
    const problemIds = this.problemLineIds;
    const criticalIds = this.criticalLineIds;

    const passes = (line: LogLine): boolean => {
      if (sourceTag !== null && line.tag !== sourceTag) { return false; }
      switch (filter) {
        case 'all':      return true;
        case 'error':    return line.level === 'error';
        case 'warn':     return line.level === 'warn';
        case 'problem':  return problemIds.has(line.id);
        case 'critical': return criticalIds.has(line.id);
      }
    };

    const items: LogLine[] = [];

    if (search.length === 0) {
      // No haystack to build: the total comes from ingest-time counters that
      // track the current buffer, and the scan can stop once the requested
      // window is filled. Counters exist for every filter when no source tab
      // is active, and for the 'all' filter of each source tab; other
      // combinations (e.g. Errors inside Transport Conditions, where the
      // answer is by construction zero-ish) count as they scan below.
      let total: number | null;
      switch (filter) {
        case 'all':
          total = sourceTag === null ? this.lineBuffer.length
            : sourceTag === TRANSPORT_CONDITIONS_TAG ? this.bufferTransportLines
            : this.bufferConnectionRequestLines;
          break;
        case 'error':    total = sourceTag === null ? this.bufferErrors : null; break;
        case 'warn':     total = sourceTag === null ? this.bufferWarnings : null; break;
        case 'problem':  total = sourceTag === null ? this.bufferProblemLines : null; break;
        case 'critical': total = sourceTag === null ? this.bufferCriticalLines : null; break;
      }
      if (total !== null) {
        if (offset < total && limit > 0) {
          let matchIndex = 0;
          for (let i = this.lineBuffer.length - 1; i >= 0 && items.length < limit; i--) {
            const line = this.lineBuffer[i];
            if (!line || !passes(line)) continue;
            if (matchIndex >= offset) { items.push(line); }
            matchIndex++;
          }
        }
        return { items, total };
      }
    }

    // With a search term (or an uncounted filter×source combination) the
    // total is unknowable before the scan, but matched lines only ever need
    // to land inside the requested window — count as we go instead of
    // materialising every match.
    let matchIndex = 0;
    for (let i = this.lineBuffer.length - 1; i >= 0; i--) {
      const line = this.lineBuffer[i];
      if (!line || !passes(line)) continue;
      if (search.length > 0) {
        const userTagsHay = line.userTags ? ' ' + line.userTags.join(' ') : '';
        const hay = (line.text + ' ' + (line.tag ?? '') + userTagsHay).toLowerCase();
        if (!hay.includes(search)) continue;
      }
      if (matchIndex >= offset && items.length < limit) { items.push(line); }
      matchIndex++;
    }
    return { items, total: matchIndex };
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
    const line = idx >= 0 ? this.lineBuffer[idx] : undefined;
    if (!line) return { line: null, before: [], after: [] };
    const beforeStart = Math.max(0, idx - contextBefore);
    const afterEnd = Math.min(this.lineBuffer.length, idx + 1 + contextAfter);
    const before = this.lineBuffer.slice(beforeStart, idx);
    const after = this.lineBuffer.slice(idx + 1, afterEnd);
    return { line, before, after };
  }

  /** `lines` arrive oldest-first and already split — the provider reads the
   *  tail of the log files, so neither the whole file nor a whole-file split
   *  array is ever materialised. */
  private processBackfill(lines: readonly string[], minTimestamp?: Date): void {
    try {
      const cutoffMs = minTimestamp?.getTime();
      for (const raw of lines) {
        if (raw.length === 0) { continue; }
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
    this.addToVolumeBins(line);
    if (line.level === 'error') this.bufferErrors++;
    if (line.level === 'warn') this.bufferWarnings++;
    if (line.tag === TRANSPORT_CONDITIONS_TAG) this.bufferTransportLines++;
    if (line.tag === CONNECTION_REQUESTS_TAG) this.bufferConnectionRequestLines++;
    // Trim in chunks rather than shift() per line — at the 50k cap a
    // per-line shift is an O(n) memmove on every log line under
    // sustained volume. The buffer may briefly hold up to 2× the cap.
    // The incremental bins/counters have to follow the drop or the flush
    // histogram and the un-searched tab totals drift from the buffer.
    if (this.lineBuffer.length > LINE_BUFFER_CAP * 2) {
      const dropped = this.lineBuffer.splice(0, this.lineBuffer.length - LINE_BUFFER_CAP);
      for (const dead of dropped) {
        this.removeFromVolumeBins(dead);
        if (dead.level === 'error') this.bufferErrors--;
        if (dead.level === 'warn') this.bufferWarnings--;
        if (dead.tag === TRANSPORT_CONDITIONS_TAG) this.bufferTransportLines--;
        if (dead.tag === CONNECTION_REQUESTS_TAG) this.bufferConnectionRequestLines--;
        if (this.problemLineIds.has(dead.id)) this.bufferProblemLines--;
        if (this.criticalLineIds.has(dead.id)) this.bufferCriticalLines--;
      }
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
      if (m?.[1]) { this.state.sdkVersion = m[1]; }
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
        const sizeBefore = this.problemLineIds.size;
        this.problemLineIds.add(line.id);
        if (this.problemLineIds.size !== sizeBefore) { this.bufferProblemLines++; }
        if (h.severity === 5) {
          const critBefore = this.criticalLineIds.size;
          this.criticalLineIds.add(line.id);
          if (this.criticalLineIds.size !== critBefore) { this.bufferCriticalLines++; }
        }
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
      sourceCounts: {
        transport: this.bufferTransportLines,
        connectionRequests: this.bufferConnectionRequestLines,
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

  /** Increment the per-second bin for a freshly-ingested line. */
  private addToVolumeBins(line: LogLine): void {
    if (!line.timestamp) { return; }
    const bin = Math.floor(line.timestamp.getTime() / VOLUME_BIN_MS) * VOLUME_BIN_MS;
    let bucket = this.volumeBins.get(bin);
    if (!bucket) {
      bucket = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
      this.volumeBins.set(bin, bucket);
    }
    bucket[line.level]++;
  }

  /** Decrement the per-second bin for a line dropped by the buffer trim;
   *  delete the bin once empty so flush never emits buckets a scan of the
   *  buffer would not produce. */
  private removeFromVolumeBins(line: LogLine): void {
    if (!line.timestamp) { return; }
    const bin = Math.floor(line.timestamp.getTime() / VOLUME_BIN_MS) * VOLUME_BIN_MS;
    const bucket = this.volumeBins.get(bin);
    if (!bucket) { return; }
    bucket[line.level]--;
    if (bucket.error + bucket.warn + bucket.info + bucket.debug + bucket.trace === 0) {
      this.volumeBins.delete(bin);
    }
  }

  /** Merge the per-second bins into the display width. Output shape and
   *  ordering match binVolumeByLevel(lineBuffer, binMs) exactly, at
   *  O(bins) instead of O(lines). */
  private mergedVolumeBins(binMs: number): AnalyzerState['histograms']['volumeByLevel'] {
    if (this.volumeBins.size === 0) { return []; }
    const out = new Map<number, Record<LogLevel, number>>();
    for (const [fine, counts] of this.volumeBins) {
      const coarse = Math.floor(fine / binMs) * binMs;
      let bucket = out.get(coarse);
      if (!bucket) {
        bucket = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
        out.set(coarse, bucket);
      }
      bucket.error += counts.error;
      bucket.warn += counts.warn;
      bucket.info += counts.info;
      bucket.debug += counts.debug;
      bucket.trace += counts.trace;
    }
    return [...out.entries()]
      .sort(([a], [b]) => a - b)
      .map(([binStartMs, counts]) => ({ binStartMs, counts }));
  }

  private recomputeHistograms(): void {
    const range = this.state.startTime && this.state.endTime
      ? this.state.endTime.getTime() - this.state.startTime.getTime()
      : 0;
    const binMs = pickBinWidth(Math.max(range, 1000));
    this.state.histograms.problemsOverTime = binProblemsOverTime(this.problemHits, binMs);
    // These bins describe this.lineBuffer, NOT sink.snapshot(). The sink is
    // shared by every database's analyzer and holds only lines the extension
    // logged live — it excludes backfill (read from the rotated log file) and
    // includes other connections' lines. Binning it produced a histogram over
    // a completely different population than every other number on screen,
    // and one that Clear could not empty.
    this.state.histograms.volumeByLevel = this.mergedVolumeBins(binMs);
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
