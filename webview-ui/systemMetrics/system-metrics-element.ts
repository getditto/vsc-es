// webview-ui/systemMetrics/system-metrics-element.ts
//
// Continuous-diagnostics panel fed by SDK 5.1's `system:metrics`
// virtual collection. The host polls on a visibility-tied cadence
// (reads flush Ditto's registry and return per-read deltas, so the host
// accumulates since-connect totals) and pushes a status on every poll.
// Refresh forces one immediate poll ahead of the cadence.
//
// Layout mirrors the SwiftUI Edge Studio's System Metrics screen: a
// centered namespace segment filter (All / Network / Store / Sync /
// Other), every series rendered as a row (stripped key + labels on the
// left, since-connect total + last-period delta on the right), the dsoq
// opened-vs-closed divergence banner, and a since/updated footer. Per
// row, an info icon expands the series' details (description, kind,
// unit; histograms also average/max), and a pin icon keeps the series in
// a collapsible "Pinned" section above the segment filter (host persists
// pins per connection in globalState — they survive panel close and
// reconnect).

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';

// ─── Wire shapes (mirror of src/ipc/messages.ts) ───────────────
interface SystemMetricSample {
  key: string;
  labels: Record<string, string>;
  description: string;
  unit: string;
  kind: 'counter' | 'histogram';
  sinceConnect: number;
  periodDelta: number;
  sumSinceConnect?: number;
  absMax?: number;
}

interface SystemMetricsSnapshot {
  samples: SystemMetricSample[];
  sinceMs: number;
  polledAtMs: number;
  pollIntervalMs: number;
}

type SystemMetricsStatus =
  | { kind: 'working'; snapshot: SystemMetricsSnapshot }
  | { kind: 'settingDisabled' }
  | { kind: 'exporterDisabled' }
  | { kind: 'noConnection' }
  | { kind: 'unavailable'; message: string };

interface SystemMetricSeriesRef {
  key: string;
  labels: Record<string, string>;
}

type In =
  | { type: 'sysMetrics.status'; status: SystemMetricsStatus }
  | { type: 'sysMetrics.pins'; pins: SystemMetricSeriesRef[] };

// ─── Namespace segment filter (parity with the SwiftUI app's
//     SystemMetricsNamespaceFilter) ─────────────────────────────
type NamespaceFilter = 'all' | 'network' | 'store' | 'sync' | 'other';

const SEGMENTS: ReadonlyArray<{ id: NamespaceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'network', label: 'Network' },
  { id: 'store', label: 'Store' },
  { id: 'sync', label: 'Sync' },
  { id: 'other', label: 'Other' },
];

const NAMESPACE_PREFIXES: ReadonlyArray<readonly [NamespaceFilter, readonly string[]]> = [
  ['network', ['ditto.network.']],
  ['store', ['ditto.backend.']],
  ['sync', ['ditto.sync.', 'ditto.replication.']],
];

function matchesFilter(sample: SystemMetricSample, filter: NamespaceFilter): boolean {
  if (filter === 'all') { return true; }
  if (filter === 'other') {
    return !NAMESPACE_PREFIXES.some(([, prefixes]) =>
      prefixes.some(p => sample.key.startsWith(p)));
  }
  const prefixes = NAMESPACE_PREFIXES.find(([id]) => id === filter)?.[1] ?? [];
  return prefixes.some(p => sample.key.startsWith(p));
}

/** Case-insensitive substring over the metric key AND its label keys and
 *  values, so `ble` finds the transport=ble series and `dsoq` finds every
 *  dsoq metric. Empty/whitespace query matches everything. */
function matchesQuery(sample: SystemMetricSample, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) { return true; }
  if (sample.key.toLowerCase().includes(q)) { return true; }
  return Object.entries(sample.labels).some(([k, v]) =>
    k.toLowerCase().includes(q) || v.toLowerCase().includes(q));
}

/** `ditto.network.dsoq.connection.opened` → `network.dsoq.connection.opened`
 *  (the SwiftUI row strips the `ditto.` prefix, not the namespace). */
function stripPrefix(key: string): string {
  return key.startsWith('ditto.') ? key.slice('ditto.'.length) : key;
}

/** Integral values localise (1,000); fractions render 2 decimals under
 *  10 and 1 decimal above (parity with the SwiftUI `formatValue`). */
function formatValue(n: number): string {
  if (n === Math.round(n)) { return n.toLocaleString(); }
  return n < 10 ? n.toFixed(2) : n.toFixed(1);
}

/** Seconds-aware scaling for durations (µs/ms/s) — richer than the
 *  SwiftUI app, which prints the raw unit. */
function formatDuration(n: number): string {
  if (n < 0.001) { return `${(n * 1_000_000).toFixed(0)} µs`; }
  if (n < 1) { return `${(n * 1000).toFixed(1)} ms`; }
  return `${n.toFixed(2)} s`;
}

/** Headline value: histograms accumulate a COUNT of observations;
 *  seconds-unit counters scale for readability. */
function formatHeadline(s: SystemMetricSample): string {
  if (s.kind === 'histogram') { return formatValue(s.sinceConnect); }
  return s.unit === 'seconds' ? formatDuration(s.sinceConnect) : formatValue(s.sinceConnect);
}

function formatDelta(s: SystemMetricSample): string {
  if (s.kind === 'histogram') { return formatValue(s.periodDelta); }
  return s.unit === 'seconds' ? formatDuration(s.periodDelta) : formatValue(s.periodDelta);
}

/** Stable id per series (metric key + sorted label map) — expansion and
 *  pin state must survive re-renders keyed by series, not position. */
function seriesId(s: SystemMetricSeriesRef): string {
  const labels = Object.keys(s.labels).sort().map(k => `${k}=${s.labels[k]}`).join(',');
  return `${s.key}|${labels}`;
}

function labelLine(s: SystemMetricSeriesRef): string {
  return Object.keys(s.labels).sort().map(k => `${k}=${s.labels[k]}`).join(',');
}

/** Pins are a set in pin order — the same series may never render twice.
 *  The host dedupes at storage read/write; the webview additionally guards
 *  the one place an external list enters it (the sysMetrics.pins push), so
 *  a stale or corrupted stored list can't produce duplicate rows. */
function dedupePins(pins: SystemMetricSeriesRef[]): SystemMetricSeriesRef[] {
  const seen = new Set<string>();
  return pins.filter(p => {
    const id = seriesId(p);
    if (seen.has(id)) { return false; }
    seen.add(id);
    return true;
  });
}

@customElement('ditto-system-metrics')
export class SystemMetricsElement extends LitElement {
  /** Latest system:metrics status from the host. `null` until the first
   *  poll/publish lands — the panel shows a collecting state briefly. */
  @state() private systemMetrics: SystemMetricsStatus | null = null;
  @state() private filter: NamespaceFilter = 'all';
  /** Series with their details expanded, by {@link seriesId}. */
  @state() private expanded: ReadonlySet<string> = new Set();
  /** Pinned series in pin order. The host pushes the persisted list once
   *  at panel open; afterwards the webview owns edits and posts the
   *  complete replacement (sysMetrics.setPins) on every change. */
  @state() private pins: SystemMetricSeriesRef[] = [];
  /** Pinned-section accordion: open by default, session-local state. */
  @state() private pinnedOpen = true;
  /** Free-text filter over the master list (combined with the namespace
   *  segment). The pinned section is deliberately NOT filtered — it is the
   *  user's stable troubleshooting set. */
  @state() private query = '';

  static override styles = css`
    :host {
      display: block;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      box-sizing: border-box;
    }
    .header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 12px;
    }
    .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .header .spacer { flex: 1; }
    .header button {
      padding: 4px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }

    /* Filter row: centered segment control (SwiftUI pattern — centering
     * makes the picker read as governing the list below) with the search
     * box right-aligned on the same row. */
    .filter-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .seg-wrap {
      display: flex;
      justify-content: center;
      flex: 1;
      min-width: 0;
    }
    .search {
      flex: 0 0 auto;
      width: 200px;
      padding: 3px 8px;
      font: inherit;
      font-size: 12px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      box-sizing: border-box;
    }
    .search::placeholder { color: var(--vscode-input-placeholderForeground); }
    .search:focus { outline: 1px solid var(--vscode-focusBorder); }
    .seg {
      display: flex;
      flex: 0 1 320px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .seg button {
      flex: 1;
      padding: 4px 0;
      border: none;
      border-right: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
    }
    .seg button:last-child { border-right: none; }
    .seg button[aria-pressed="true"] {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .banner {
      display: flex;
      gap: 6px;
      align-items: baseline;
      margin: 8px 0;
      padding: 8px 12px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 12px;
    }

    .guide {
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
    .guide code {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-foreground);
    }
    .none {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 12px 0;
    }

    /* Metric rows — list, not a table (SwiftUI metricRow). */
    .mrow { border-bottom: 1px solid var(--vscode-panel-border); }
    .mrow-main {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 4px 0;
    }
    .mid { min-width: 0; flex: 1; }
    /* Keys and label lines wrap rather than truncate — metric names and
     * label sets are long dot/comma-separated tokens, so an ellipsis
     * quietly loses the suffix that distinguishes one series from
     * another (overflow-wrap: anywhere breaks inside such tokens). */
    .mkey {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .mlabels {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }
    .mvals { text-align: right; flex-shrink: 0; }
    .mval {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .mdelta {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .mdelta.up { color: var(--vscode-testing-iconPassed, #73c991); }

    .pin-btn, .info-btn {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font: inherit;
      line-height: 1;
    }
    .pin-btn:hover, .info-btn:hover { color: var(--vscode-foreground); }
    .pin-btn[aria-pressed="true"] { color: var(--vscode-foreground); }
    .info-btn[aria-expanded="true"] { color: var(--vscode-foreground); }
    .codicon {
      font: normal normal normal 16px/1 codicon;
      display: inline-block;
      text-decoration: none;
      text-rendering: auto;
      text-align: center;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    .codicon-info::before { content: '\\ea74'; }
    .codicon-warning::before { content: '\\ea6c'; }
    .codicon-pin::before { content: '\\eb2b'; }
    .codicon-pinned::before { content: '\\eba0'; }
    .codicon-chevron-down::before { content: '\\eab4'; }
    .codicon-chevron-right::before { content: '\\eab6'; }
    .codicon-clear-all::before { content: '\\eabf'; }
    .codicon-three-bars::before { content: '\\eb6a'; }

    /* Pinned-row drag reorder: the whole row is draggable, the three-bars
     * handle (iOS/macOS idiom) at the trailing edge communicates it. */
    .drag-handle {
      flex-shrink: 0;
      align-self: center;
      color: var(--vscode-descriptionForeground);
      cursor: grab;
    }
    .mrow.dragging { opacity: 0.5; }
    .mrow.dragging .drag-handle { cursor: grabbing; }
    .mrow.drop-before { box-shadow: inset 0 2px 0 0 var(--vscode-focusBorder, #007fd4); }
    .mrow.drop-after { box-shadow: inset 0 -2px 0 0 var(--vscode-focusBorder, #007fd4); }

    /* Pinned section — accordion above the segment filter. */
    .pinned {
      margin-bottom: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editorWidget-background);
    }
    .pinned-head {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 5px 8px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      text-align: left;
    }
    .pinned-head .codicon { color: var(--vscode-descriptionForeground); }
    .pinned-head .pcount {
      font-family: var(--vscode-editor-font-family);
      font-weight: 400;
      color: var(--vscode-descriptionForeground);
    }
    .pinned-head .p-spacer { flex: 1; }
    .pinned-clear {
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font: inherit;
      font-size: 11px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .pinned-clear:hover { color: var(--vscode-foreground); }
    .pinned-body { padding: 0 8px 4px; }
    .pinned-body .mrow:last-child { border-bottom: none; }
    .mrow.idle .mkey, .mrow.idle .mlabels, .mrow.idle .mvals {
      color: var(--vscode-descriptionForeground);
    }
    .mrow.idle .mval { font-style: italic; }

    .mdetail {
      padding: 6px 10px 8px;
      /* aligns the panel with the key column, past the leading pin+info
       * icons (2 × ≈24px button + 2 × 8px row gap) */
      margin-left: 64px;
      margin-bottom: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .mdetail .desc { margin: 0 0 4px; }
    .mdetail dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 1px 10px;
      margin: 0;
      font-family: var(--vscode-editor-font-family);
    }
    .mdetail dt {
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      font-size: 10.5px;
      letter-spacing: 0.04em;
    }
    .mdetail dd { margin: 0; }
    .mdetail .fullkey { word-break: break-all; }

    .foot {
      margin-top: 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
    }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<In>(this, msg => this.onHostMessage(msg));

  private onHostMessage(m: In): void {
    if (m.type === 'sysMetrics.status') {
      this.systemMetrics = m.status;
    } else if (m.type === 'sysMetrics.pins') {
      this.pins = dedupePins(m.pins);
    }
  }

  private refresh(): void {
    postToHost({ type: 'sysMetrics.refresh' });
  }

  private isPinned(s: SystemMetricSeriesRef): boolean {
    const id = seriesId(s);
    return this.pins.some(p => seriesId(p) === id);
  }

  /** Pin/unpin a series, then persist the complete replacement list. */
  private togglePin(s: SystemMetricSeriesRef): void {
    const id = seriesId(s);
    this.pins = this.isPinned(s)
      ? this.pins.filter(p => seriesId(p) !== id)
      : [...this.pins, { key: s.key, labels: s.labels }];
    postToHost({ type: 'sysMetrics.setPins', pins: this.pins });
  }

  private clearPins(): void {
    this.pins = [];
    postToHost({ type: 'sysMetrics.setPins', pins: [] });
  }

  // ─── Pinned-row drag reorder ────────────────────────────────
  /** Series being dragged, by {@link seriesId}. Plain field — rendering
   *  reacts to `pins` changes, not to in-flight drags. */
  private dragSrcId: string | null = null;

  private onDragStart(e: DragEvent, id: string): void {
    this.dragSrcId = id;
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
    (e.currentTarget as HTMLElement).classList.add('dragging');
  }

  /** Drop position relative to the row under the cursor: above the row's
   *  vertical midpoint = insert before it, at/below = after it. */
  private dropBefore(e: DragEvent): boolean {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2;
  }

  private onDragOver(e: DragEvent, targetId: string): void {
    if (this.dragSrcId === null || this.dragSrcId === targetId) { return; }
    e.preventDefault(); // opt the row into being a drop target
    if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
    const row = e.currentTarget as HTMLElement;
    const before = this.dropBefore(e);
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  }

  private onDragLeave(e: DragEvent): void {
    (e.currentTarget as HTMLElement).classList.remove('drop-before', 'drop-after');
  }

  private onDrop(e: DragEvent, targetId: string): void {
    e.preventDefault();
    const srcId = this.dragSrcId ?? e.dataTransfer?.getData('text/plain') ?? null;
    const before = this.dropBefore(e);
    this.clearDragState();
    if (!srcId || srcId === targetId) { return; }
    const moved = this.pins.find(p => seriesId(p) === srcId);
    if (!moved) { return; }
    const rest = this.pins.filter(p => seriesId(p) !== srcId);
    let idx = rest.findIndex(p => seriesId(p) === targetId);
    if (idx === -1) { return; } // stale target — e.g. a mid-drag unpin
    if (!before) { idx += 1; }
    rest.splice(idx, 0, moved);
    this.pins = rest;
    postToHost({ type: 'sysMetrics.setPins', pins: this.pins });
  }

  private onDragEnd(): void {
    this.clearDragState();
  }

  private clearDragState(): void {
    this.dragSrcId = null;
    this.shadowRoot
      ?.querySelectorAll('.mrow.dragging, .mrow.drop-before, .mrow.drop-after')
      .forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after'));
  }

  private setFilter(f: NamespaceFilter): void {
    this.filter = f;
  }

  private toggleDetails(id: string): void {
    const next = new Set(this.expanded);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    this.expanded = next;
  }

  override render(): TemplateResult {
    const st = this.systemMetrics;
    const samplesById = new Map<string, SystemMetricSample>();
    if (st?.kind === 'working') {
      for (const s of st.snapshot.samples) { samplesById.set(seriesId(s), s); }
    }
    return html`
      <div class="header">
        <h1>System Metrics</h1>
        <span class="spacer"></span>
        <button @click=${this.refresh}>Refresh</button>
      </div>
      ${this.renderPinned(samplesById)}
      <div class="filter-row">
        <div class="seg-wrap">
          <div class="seg" role="group" aria-label="Metric namespace filter">
            ${SEGMENTS.map(s => html`
              <button
                aria-pressed=${this.filter === s.id ? 'true' : 'false'}
                @click=${() => this.setFilter(s.id)}
              >${s.label}</button>
            `)}
          </div>
        </div>
        <input
          class="search"
          type="search"
          placeholder="Filter metrics…"
          aria-label="Filter metrics"
          .value=${this.query}
          @input=${(e: InputEvent) => { this.query = (e.target as HTMLInputElement).value; }}
        />
      </div>
      ${this.renderBody()}
    `;
  }

  /**
   * The pinned-series accordion. Renders whenever pins exist — even in a
   * non-working status — so the troubleshooting set is always visible.
   * A pinned series the current snapshot doesn't report (not yet observed
   * this connection, or GC'd server-side) stays as a dashed placeholder:
   * it must remain unpinnable-visible rather than vanish silently.
   */
  private renderPinned(samplesById: ReadonlyMap<string, SystemMetricSample>): TemplateResult | typeof nothing {
    if (this.pins.length === 0) { return nothing; }
    return html`
      <div class="pinned">
        <button
          class="pinned-head"
          aria-expanded=${this.pinnedOpen ? 'true' : 'false'}
          @click=${() => { this.pinnedOpen = !this.pinnedOpen; }}
        >
          <span class="codicon ${this.pinnedOpen ? 'codicon-chevron-down' : 'codicon-chevron-right'}"></span>
          Pinned
          <span class="pcount">(${this.pins.length})</span>
          <span class="p-spacer"></span>
          <span
            class="pinned-clear"
            role="button"
            title="Clear all pinned metrics"
            @click=${(e: Event) => { e.stopPropagation(); this.clearPins(); }}
          ><span class="codicon codicon-clear-all"></span>Clear</span>
        </button>
        ${this.pinnedOpen
          ? html`<div class="pinned-body">
              ${this.pins.map(p => this.renderPinnedRow(p, samplesById.get(seriesId(p))))}
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderPinnedRow(
    ref: SystemMetricSeriesRef,
    sample: SystemMetricSample | undefined,
  ): TemplateResult {
    if (sample) { return this.renderRow(sample, ref); }
    // Placeholder: pinned but not reported yet this connection.
    const id = seriesId(ref);
    const labels = labelLine(ref);
    return html`
      <div
        class="mrow idle"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.onDragStart(e, id)}
        @dragover=${(e: DragEvent) => this.onDragOver(e, id)}
        @dragleave=${(e: DragEvent) => this.onDragLeave(e)}
        @drop=${(e: DragEvent) => this.onDrop(e, id)}
        @dragend=${this.onDragEnd}
      >
        <div class="mrow-main">
          <button
            class="pin-btn"
            title="Unpin metric"
            aria-label=${`Unpin ${ref.key}`}
            aria-pressed="true"
            @click=${() => this.togglePin(ref)}
          ><span class="codicon codicon-pinned"></span></button>
          <div class="mid">
            <div class="mkey">${stripPrefix(ref.key)}</div>
            ${labels ? html`<div class="mlabels">${labels}</div>` : nothing}
          </div>
          <div class="mvals">
            <div class="mval">—</div>
            <div class="mdelta">no data yet</div>
          </div>
          <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
            <span class="codicon codicon-three-bars"></span>
          </span>
        </div>
      </div>
    `;
  }

  private renderBody(): TemplateResult {
    const st = this.systemMetrics;
    if (st === null) {
      return html`<div class="none">Collecting — the first poll lands shortly after this panel opens…</div>`;
    }
    if (st.kind === 'working') {
      return this.renderDashboard(st.snapshot);
    }
    if (st.kind === 'settingDisabled') {
      return html`
        <div class="guide">
          System metrics are disabled. Enable
          <code>dittoVsce.collectSystemMetrics</code> and reconnect this database —
          the SDK enables the <code>system:metrics</code> exporter at connection
          startup only (runtime changes are ignored by Ditto).
        </div>`;
    }
    if (st.kind === 'exporterDisabled') {
      return html`
        <div class="guide">
          <code>system:metrics</code> exporter is off for this connection — it was
          opened with <code>dittoVsce.collectSystemMetrics</code> disabled. The
          exporter parameter is startup-only, so the fix is: enable the setting,
          then disconnect and reconnect this database.
        </div>`;
    }
    if (st.kind === 'noConnection') {
      return html`<div class="guide">No active connection — connect this database to show system metrics.</div>`;
    }
    return html`<div class="guide">System metrics unavailable: ${st.message}</div>`;
  }

  private renderDashboard(snap: SystemMetricsSnapshot): TemplateResult {
    const filtered = snap.samples.filter(s =>
      matchesFilter(s, this.filter) && matchesQuery(s, this.query));
    const since = new Date(snap.sinceMs).toLocaleTimeString();
    const polled = new Date(snap.polledAtMs).toLocaleTimeString();
    return html`
      ${this.renderDivergence(snap)}
      ${filtered.length === 0
        ? html`<div class="none">${snap.samples.length === 0
            ? 'No metrics reported yet — they accumulate while this panel is visible.'
            : this.query.trim().length > 0
              ? `No metrics match "${this.query.trim()}".`
              : 'No metrics in this namespace.'}</div>`
        : filtered.map(s => this.renderRow(s))}
      <div class="foot">
        Since ${since} — updated ${polled} · polled every ${(snap.pollIntervalMs / 1000).toFixed(0)}s.
        Totals accumulate per-read deltas — <code>system:metrics</code> reads flush Ditto's counters.
      </div>
    `;
  }

  private renderDivergence(snap: SystemMetricsSnapshot): TemplateResult | typeof nothing {
    const total = (key: string) =>
      snap.samples.filter(s => s.key === key).reduce((acc, s) => acc + s.sinceConnect, 0);
    const opened = total('ditto.network.dsoq.connection.opened');
    const closed = total('ditto.network.dsoq.connection.closed');
    if (opened + closed === 0 || opened === closed) { return nothing; }
    return html`
      <div class="banner">
        <span class="codicon codicon-warning"></span>
        <span>
          dsoq connections opened (${formatValue(opened)}) ≠ closed (${formatValue(closed)})
          — possible connection leak or handshake issue.
        </span>
      </div>
    `;
  }

  /** A live metric row. `dragRef` is only passed for rows in the pinned
   *  accordion — it marks the row draggable and adds the three-bars
   *  handle; the master list follows accumulation order and shows none. */
  private renderRow(s: SystemMetricSample, dragRef?: SystemMetricSeriesRef): TemplateResult {
    const id = seriesId(s);
    const isOpen = this.expanded.has(id);
    const pinned = this.isPinned(s);
    const labels = labelLine(s);
    return html`
      <div
        class="mrow"
        draggable=${dragRef ? 'true' : nothing}
        @dragstart=${dragRef ? (e: DragEvent) => this.onDragStart(e, id) : nothing}
        @dragover=${dragRef ? (e: DragEvent) => this.onDragOver(e, id) : nothing}
        @dragleave=${dragRef ? (e: DragEvent) => this.onDragLeave(e) : nothing}
        @drop=${dragRef ? (e: DragEvent) => this.onDrop(e, id) : nothing}
        @dragend=${dragRef ? this.onDragEnd : nothing}
      >
        <div class="mrow-main">
          <button
            class="pin-btn"
            title=${pinned ? 'Unpin metric' : 'Pin to the Pinned section'}
            aria-label=${`${pinned ? 'Unpin' : 'Pin'} ${s.key}`}
            aria-pressed=${pinned ? 'true' : 'false'}
            @click=${() => this.togglePin(s)}
          ><span class="codicon ${pinned ? 'codicon-pinned' : 'codicon-pin'}"></span></button>
          <button
            class="info-btn"
            title="Details"
            aria-label=${`Details for ${s.key}`}
            aria-expanded=${isOpen ? 'true' : 'false'}
            @click=${() => this.toggleDetails(id)}
          ><span class="codicon codicon-info"></span></button>
          <div class="mid">
            <div class="mkey">${stripPrefix(s.key)}</div>
            ${labels ? html`<div class="mlabels">${labels}</div>` : nothing}
          </div>
          <div class="mvals">
            <div class="mval">${formatHeadline(s)}</div>
            <div class="mdelta ${s.periodDelta > 0 ? 'up' : ''}">
              ${s.periodDelta > 0 ? html`▲ +${formatDelta(s)}` : html`—`}
            </div>
          </div>
          ${dragRef ? html`
            <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
              <span class="codicon codicon-three-bars"></span>
            </span>
          ` : nothing}
        </div>
        ${isOpen ? this.renderDetails(s) : nothing}
      </div>
    `;
  }

  private renderDetails(s: SystemMetricSample): TemplateResult {
    const avg = s.kind === 'histogram' && s.sinceConnect > 0 && s.sumSinceConnect !== undefined
      ? (s.unit === 'seconds' ? formatDuration : formatValue)(s.sumSinceConnect / s.sinceConnect)
      : undefined;
    const max = s.kind === 'histogram' && s.absMax !== undefined
      ? (s.unit === 'seconds' ? formatDuration : formatValue)(s.absMax)
      : undefined;
    return html`
      <div class="mdetail">
        ${s.description ? html`<p class="desc">${s.description}</p>` : nothing}
        <dl>
          <dt>Metric</dt><dd class="fullkey">${s.key}</dd>
          <dt>Kind</dt><dd>${s.kind === 'histogram' ? 'Histogram' : 'Counter'}</dd>
          ${s.unit ? html`<dt>Unit</dt><dd>${s.unit}</dd>` : nothing}
          ${avg !== undefined ? html`<dt>Avg since connect</dt><dd>${avg}</dd>` : nothing}
          ${max !== undefined ? html`<dt>Abs max</dt><dd>${max}</dd>` : nothing}
        </dl>
      </div>
    `;
  }
}
