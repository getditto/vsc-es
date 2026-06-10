import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';
import './components/summary-header.js';
import './components/problems-list.js';
import './components/histograms-row.js';
import './components/collapsible-section.js';
import './components/filter-tabs.js';
import './components/log-table.js';
import './components/line-detail-drawer.js';
import type { FilterKey } from './components/filter-tabs.js';
import type { AnalyzerOut } from '../../src/ipc/messages.js';
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

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<AnalyzerOut>(this.handleMessage);
    this.addEventListener('reveal-line', this.onRevealLine as EventListener);
    this.addEventListener('filter-change', this.onFilterChange as EventListener);
    this.addEventListener('line-clicked', this.onLineClicked as EventListener);
    this.addEventListener('drawer-close', this.onDrawerClose as EventListener);
    // Kick off an initial query so the table is populated on first open.
    this.requestLines();
  }

  disconnectedCallback(): void {
    this.removeEventListener('reveal-line', this.onRevealLine as EventListener);
    this.removeEventListener('filter-change', this.onFilterChange as EventListener);
    this.removeEventListener('line-clicked', this.onLineClicked as EventListener);
    this.removeEventListener('drawer-close', this.onDrawerClose as EventListener);
    if (this.searchDebounce != null) {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = null;
    }
    super.disconnectedCallback();
  }

  private onRevealLine = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { id: number };
    postToHost({ type: 'analyzer.revealLine', lineId: detail.id });
  };

  private onFilterChange = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { key: FilterKey };
    if (detail.key === this.activeFilter) return;
    this.activeFilter = detail.key;
    this.requestLines();
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
      this.requestLines();
    }, 200);
  };

  private requestLines(): void {
    const requestId = String(++this.requestCursor);
    this.latestLinesReq = requestId;
    postToHost({
      type: 'analyzer.queryLines',
      filter: this.activeFilter,
      search: this.search || undefined,
      limit: 1000,
      offset: 0,
      requestId,
    });
  }

  private handleMessage = (m: AnalyzerOut): void => {
    if (!m) { return; }
    switch (m.type) {
      case 'analyzer.summary':
        this.counts = m.counts;
        // Counts changed → table totals + tab badges should refresh.
        this.requestLines();
        break;
      case 'analyzer.problemsAdded': {
        // Append to an existing group or open a new one. We mutate the
        // map in place then call requestUpdate() since @state on a Map
        // doesn't trigger on internal mutations.
        for (const it of m.items) {
          const arr = this.problems.get(it.patternKey) ?? [];
          arr.push(it);
          this.problems.set(it.patternKey, arr);
        }
        this.requestUpdate();
        break;
      }
      case 'analyzer.reset':
        this.counts = null;
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
      case 'analyzer.live':
        // Streaming live lines no longer feed a separate tail — the
        // log table refreshes whenever analyzer.summary fires. Nothing
        // to do here.
        break;
      case 'analyzer.linesResult':
        // Drop late responses; only honour the most recent request.
        if (m.requestId !== this.latestLinesReq) break;
        this.tableLines = m.items;
        this.tableTotal = m.total;
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

  private tabCounts(): { critical: number; errors: number; warnings: number; problems: number; totalLines: number } {
    return this.counts ?? { critical: 0, errors: 0, warnings: 0, problems: 0, totalLines: 0 };
  }

  render(): TemplateResult {
    const tc = this.tabCounts();
    const shown = this.tableLines.length;
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
          <span class="result-info">${shown.toLocaleString()} / ${total.toLocaleString()}</span>
        </div>
        <log-table .lines=${this.tableLines} .selectedId=${this.selectedLineId}></log-table>
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
