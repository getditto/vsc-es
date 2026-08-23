import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import './components/summary-header.js';
import './components/problems-list.js';
import './components/histograms-row.js';
import './components/collapsible-section.js';
import './components/filter-tabs.js';
import './components/log-table.js';
import './components/line-detail-drawer.js';
import type { FilterKey } from './components/filter-tabs.js';
import type { AnalyzerOut } from '../../src/ipc/messages.js';

/** Mirrors the host's PROBLEM_CAP in LogAnalyzerService — the per-pattern
 *  hit lists must never grow for the life of the panel. */
const PROBLEM_CAP = 1000;

/** Row-fetch granularity, and the window size in chunks.
 *
 *  The table is virtualised to roughly a viewport (~40 rows), so requesting
 *  1000 rows shipped ~25x more than could ever be painted — and did so on
 *  every flush, since a summary triggers a re-query. Windows are chunk-aligned
 *  so a scroll inside the loaded window refetches nothing at all. */
const ROW_CHUNK = 100;
const ROW_WINDOW = ROW_CHUNK * 3;

/** Chunk-aligned window start covering `needStart`, with a chunk of slack
 *  before it so scrolling up does not immediately miss. */
function windowStartFor(needStart: number): number {
  return Math.max(0, Math.floor(needStart / ROW_CHUNK) * ROW_CHUNK - ROW_CHUNK);
}
import type {
  AnalyzerState,
  LogLine,
  ProblemInstance,
} from '../../src/logAnalyzer/types.js';

/** Root element for the Log Analyzer panel. Owns the IPC message
 *  listener and the aggregate analyzer state derived from
 *  `AnalyzerOut` diffs. Child components (`summary-header`,
 *  `problems-list`, `histograms-row`, `log-table`, `line-detail-drawer`)
 *  are pure presentation.
 *
 *  Message wire-up: messages from the host are coalesced incremental
 *  diffs (`analyzer.summary`, `analyzer.problemsAdded`,
 *  `analyzer.histogramsUpdated`, …). The webview keeps its own grouped
 *  map of problems keyed by pattern. The log table is fed by on-demand
 *  `analyzer.queryLines` requests that the root element re-issues
 *  whenever the active filter, search text, or summary counts change.
 *
 *  Session data is still tracked on the host (the durations histogram
 *  needs it) but no longer visualised here — the connection timeline
 *  widget was removed because the per-peer lane labels were unreadable
 *  and the Presence + Peer Listing panels already cover that ground. */
@customElement('ditto-log-analyzer')
export class DittoLogAnalyzer extends LitElement {
  static styles = css`
    :host {
      /* Fill the webview viewport so the log table can grow into the
         space freed when other accordion sections collapse. */
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 12px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      box-sizing: border-box;
    }
    .toolbar { display: flex; gap: 8px; margin-bottom: 8px; flex: 0 0 auto; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .banner {
      color: var(--vscode-inputValidation-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 6px 10px;
      margin: 6px 0;
      border-radius: 4px;
    }
    .stack {
      display: flex;
      flex-direction: column;
      gap: 12px;
      /* Take the rest of the viewport so the log-table inside can
         flex-fill when the accordion sections above it collapse. */
      flex: 1 1 auto;
      min-height: 0;
    }
    /* Collapsible/filter rows keep their natural height. The log table is
       the only flex-grow child of .stack — it absorbs the slack. */
    .stack > collapsible-section,
    .stack > filter-tabs,
    .stack > .table-controls { flex: 0 0 auto; }
    .stack > log-table { flex: 1 1 auto; min-height: 0; }
    .table-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .search {
      flex: 1 1 200px;
      min-width: 200px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      font: inherit;
    }
    .result-info {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      white-space: nowrap;
    }
  `;

  @state() private counts: AnalyzerState['counts'] | null = null;
  @state() private problems: Map<string, ProblemInstance[]> = new Map();
  @state() private tags: string[] = [];
  @state() private sdkVersion: string | null = null;
  /** Epoch ms of the first/last timestamped line, for the Range field. */
  @state() private startTimeMs: number | null = null;
  @state() private endTimeMs: number | null = null;
  @state() private errorBanner: string | null = null;
  @state() private histograms: AnalyzerState['histograms'] = {
    volumeByLevel: [],
    problemsOverTime: [],
    connectionDurations: [],
  };
  // Log-table state
  @state() private activeFilter: FilterKey = 'all';
  @state() private tableLines: LogLine[] = [];
  @state() private tableTotal = 0;
  /** Absolute index of `tableLines[0]` in the filtered result set. */
  @state() private tableOffset = 0;
  /** Window start of the request in flight, so a scroll burst does not queue
   *  a fetch per frame for the same window. */
  private inFlightOffset: number | null = null;
  @state() private search = '';
  @state() private selectedLineId: number | null = null;

  // Drawer state
  @state() private drawerLine: LogLine | null = null;
  @state() private drawerBefore: LogLine[] = [];
  @state() private drawerAfter: LogLine[] = [];
  @state() private drawerOpen = false;

  /** Monotonic counter used to mint `requestId`s for analyzer.queryLines /
   *  analyzer.requestLineDetail. We track the latest issued request id
   *  per channel and drop late responses whose id doesn't match. */
  private requestCursor = 0;
  private latestLinesReq: string | null = null;
  private latestDetailReq: string | null = null;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<AnalyzerOut>(this, msg => this.handleMessage(msg));

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('reveal-line', this.onRevealLine);
    this.addEventListener('filter-change', this.onFilterChange);
    this.addEventListener('line-clicked', this.onLineClicked);
    this.addEventListener('drawer-close', this.onDrawerClose);
    this.addEventListener('visible-range', this.onVisibleRange);
    // Kick off an initial query so the table is populated on first open.
    this.requestLines();
  }

  disconnectedCallback(): void {
    this.removeEventListener('reveal-line', this.onRevealLine);
    this.removeEventListener('filter-change', this.onFilterChange);
    this.removeEventListener('line-clicked', this.onLineClicked);
    this.removeEventListener('drawer-close', this.onDrawerClose);
    this.removeEventListener('visible-range', this.onVisibleRange);
    if (this.searchDebounce != null) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    super.disconnectedCallback();
  }

  /** The `↗` on a problem row. It used to post `analyzer.revealLine`, which
   *  the host handled with an explicit no-op — a visible affordance that did
   *  nothing. Opening the line's detail drawer is what the arrow implies and
   *  is already fully wired for row clicks, so reuse that. */
  private onRevealLine = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { id: number };
    this.selectedLineId = detail.id;
    const requestId = String(++this.requestCursor);
    this.latestDetailReq = requestId;
    postToHost({ type: 'analyzer.requestLineDetail', lineId: detail.id, requestId });
  };

  private onFilterChange = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { key: FilterKey };
    if (detail.key === this.activeFilter) return;
    this.activeFilter = detail.key;
    // A new filter is a new result set — start at the top rather than holding
    // an offset that means nothing in it.
    this.tableOffset = 0;
    this.scrollTableToTop();
    this.requestLines(0);
  };

  private onLineClicked = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { lineId: number };
    this.selectedLineId = detail.lineId;
    const requestId = String(++this.requestCursor);
    this.latestDetailReq = requestId;
    postToHost({ type: 'analyzer.requestLineDetail', lineId: detail.lineId, requestId });
  };

  private onDrawerClose = (): void => {
    this.drawerOpen = false;
  };

  private onSearchInput = (e: Event): void => {
    const target = e.target as HTMLInputElement;
    this.search = target.value;
    if (this.searchDebounce != null) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.searchDebounce = null;
      this.tableOffset = 0;
      this.scrollTableToTop();
      this.requestLines(0);
    }, 200);
  };

  /** Reset the table's scroll after the result set changes underneath it, so
   *  the viewport and the fetched window agree. */
  private scrollTableToTop(): void {
    const table = this.renderRoot.querySelector('log-table');
    if (table) { (table as HTMLElement).scrollTop = 0; }
  }

  /** Human-readable span of the ingested lines for the Range field. Empty
   *  when nothing timestamped has been seen, which the header renders as
   *  'n/a'. */
  private formatRange(): string {
    if (this.startTimeMs === null || this.endTimeMs === null) { return ''; }
    const start = new Date(this.startTimeMs);
    const end = new Date(this.endTimeMs);
    const seconds = Math.max(0, Math.round((this.endTimeMs - this.startTimeMs) / 1000));
    const span = seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.round(seconds / 60)}m`
        : `${(seconds / 3600).toFixed(1)}h`;
    const hhmmss = (d: Date): string => d.toISOString().slice(11, 19);
    return `${hhmmss(start)} → ${hhmmss(end)} (${span})`;
  }

  /** Fetch one window of rows.
   *
   *  `offset` defaults to the window already on screen so a periodic refresh
   *  (every summary diff) does not yank the user back to the top. Filter and
   *  search changes pass 0 explicitly. */
  private requestLines(offset = this.tableOffset): void {
    const requestId = String(++this.requestCursor);
    this.latestLinesReq = requestId;
    this.inFlightOffset = offset;
    postToHost({
      type: 'analyzer.queryLines',
      filter: this.activeFilter,
      search: this.search || undefined,
      limit: ROW_WINDOW,
      offset,
      requestId,
    });
  }

  /** The table reports which absolute rows the viewport needs; refetch only
   *  when they fall outside the window we hold. */
  private onVisibleRange = (e: Event): void => {
    const { start, end } = (e as CustomEvent).detail as { start: number; end: number };
    const loadedFrom = this.tableOffset;
    const loadedTo = this.tableOffset + this.tableLines.length;
    if (start >= loadedFrom && end <= loadedTo) { return; }
    const want = windowStartFor(start);
    if (want === this.inFlightOffset) { return; }
    this.requestLines(want);
  };

  private handleMessage = (m: AnalyzerOut): void => {
    if (!m) { return; }
    switch (m.type) {
      case 'analyzer.summary':
        this.counts = m.counts;
        // The rest of the summary header travels with the counts. It used not
        // to travel at all, which is why Tags/SDK/Range read "none /
        // unknown / n/a" for the life of the panel.
        this.tags = m.tags;
        this.sdkVersion = m.sdkVersion;
        this.startTimeMs = m.startTimeMs;
        this.endTimeMs = m.endTimeMs;
        // Counts changed → table totals + tab badges should refresh.
        this.requestLines();
        break;
      case 'analyzer.problemsAdded': {
        // Append to an existing group or open a new one. We mutate the
        // map in place then call requestUpdate() since @state on a Map
        // doesn't trigger on internal mutations. Capped per pattern,
        // mirroring the host's PROBLEM_CAP — the host stops sending past
        // it, but the cap is enforced here too so this map can never grow
        // for the life of the panel.
        for (const it of m.items) {
          const arr = this.problems.get(it.patternKey) ?? [];
          if (arr.length < PROBLEM_CAP) { arr.push(it); }
          this.problems.set(it.patternKey, arr);
        }
        this.requestUpdate();
        break;
      }
      case 'analyzer.reset':
        this.tableOffset = 0;
        this.inFlightOffset = null;
        this.counts = null;
        this.tags = [];
        this.sdkVersion = null;
        this.startTimeMs = null;
        this.endTimeMs = null;
        this.problems = new Map();
        this.histograms = {
          volumeByLevel: [],
          problemsOverTime: [],
          connectionDurations: [],
        };
        this.tableLines = [];
        this.tableTotal = 0;
        this.selectedLineId = null;
        this.drawerOpen = false;
        this.drawerLine = null;
        this.drawerBefore = [];
        this.drawerAfter = [];
        this.errorBanner = null;
        this.requestUpdate();
        break;
      case 'analyzer.error':
        this.errorBanner = `[${m.stage}] ${m.message}`;
        this.requestUpdate();
        break;
      case 'analyzer.histogramsUpdated':
        this.histograms = m.histograms;
        break;
      case 'analyzer.sessionsUpdated':
        // No-op: the connection timeline widget was removed. The host
        // still emits this so the IPC contract stays stable; sessions
        // are derived from the durations histogram which we DO render.
        break;
      case 'analyzer.linesResult':
        // Drop late responses; only honour the most recent request.
        if (m.requestId !== this.latestLinesReq) break;
        this.tableLines = m.items;
        this.tableOffset = m.offset;
        this.tableTotal = m.total;
        this.inFlightOffset = null;
        break;
      case 'analyzer.lineDetail':
        if (m.requestId !== this.latestDetailReq) break;
        this.drawerLine = m.line;
        this.drawerBefore = m.before;
        this.drawerAfter = m.after;
        this.drawerOpen = true;
        break;
      default:
        break;
    }
  };

  /** Sort groups by max severity (5 → 1) so CRITICAL/HIGH float to
   *  the top. Ties keep insertion order, which roughly maps to
   *  first-seen-first. */
  private problemGroups(): { key: string; items: ProblemInstance[] }[] {
    return [...this.problems.entries()]
      .map(([key, items]) => ({ key, items }))
      .sort((a, b) => (b.items[0]?.severity ?? 0) - (a.items[0]?.severity ?? 0));
  }

  /** Badge numbers for the filter tabs.
   *
   *  Problems/Critical use `problemLines`/`criticalLines`, not `problems`/
   *  `critical`: the latter count pattern-match *occurrences* — a line matching
   *  three patterns counts three times, and matches past a pattern's storage
   *  cap count too — so a badge built from them promised rows the tab could
   *  not list. The Summary header still shows the occurrence count, which is
   *  the right number for "how much went wrong". */
  private tabCounts(): { critical: number; errors: number; warnings: number; problems: number; totalLines: number } {
    const c = this.counts;
    if (!c) { return { critical: 0, errors: 0, warnings: 0, problems: 0, totalLines: 0 }; }
    return {
      critical: c.criticalLines,
      errors: c.errors,
      warnings: c.warnings,
      problems: c.problemLines,
      totalLines: c.totalLines,
    };
  }

  render(): TemplateResult {
    const tc = this.tabCounts();
    const total = this.tableTotal;
    return html`
      <div class="toolbar">
        <button @click=${(): void => postToHost({ type: 'analyzer.pause' })}>⏸ Pause</button>
        <button @click=${(): void => postToHost({ type: 'analyzer.resume' })}>▶ Resume</button>
        <button @click=${(): void => postToHost({ type: 'analyzer.clear' })}>⨯ Clear</button>
        <button @click=${(): void => postToHost({ type: 'analyzer.openPatternEditor' })}>⚙ Patterns</button>
      </div>
      ${this.errorBanner ? html`<div class="banner">${this.errorBanner}</div>` : ''}
      <div class="stack">
        <collapsible-section heading="Summary" ?open=${true}>
          <summary-header
            .counts=${this.counts}
            .tags=${this.tags}
            .sdkVersion=${this.sdkVersion}
            .sessionRange=${this.formatRange()}
          ></summary-header>
          <problems-list .groups=${this.problemGroups()}></problems-list>
        </collapsible-section>
        <collapsible-section heading="Histograms" ?open=${true}>
          <histograms-row .histograms=${this.histograms}></histograms-row>
        </collapsible-section>

        <filter-tabs .active=${this.activeFilter} .counts=${tc}></filter-tabs>
        <div class="table-controls">
          <input
            class="search"
            type="search"
            placeholder="Filter the current tab (case-insensitive)…"
            .value=${this.search}
            @input=${this.onSearchInput}
          />
          <!-- The count of matching rows, not "loaded / matching": rows are
               fetched in windows now, so the loaded count is an implementation
               detail that would sit at the window size regardless. -->
          <span class="result-info">${total.toLocaleString()} ${total === 1 ? 'line' : 'lines'}</span>
        </div>
        <log-table
          .lines=${this.tableLines}
          .windowOffset=${this.tableOffset}
          .totalRows=${this.tableTotal}
          .selectedId=${this.selectedLineId}
        ></log-table>
      </div>
      <line-detail-drawer
        ?hidden=${!this.drawerOpen}
        .line=${this.drawerLine}
        .beforeLines=${this.drawerBefore}
        .afterLines=${this.drawerAfter}
      ></line-detail-drawer>
    `;
  }
}
