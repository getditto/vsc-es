// webview-ui/queryMetrics/query-metrics-panel-element.ts
//
// Replay UI for the Query Metrics ring buffer. Split pane: record
// list on the left (timestamp, latency-color-coded duration, location
// badge, index dot, 2-line DQL preview), detail on the right (DQL,
// stat badges including Location, EXPLAIN viewer). Mirrors the
// SwiftUI Edge Studio's QueryMetricsDetailView with the addition of
// the Location badge — that's the field SwiftUI doesn't capture but
// we do, and it's frequently the difference between a 20ms and a
// 200ms run on the same query.

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import '../shared/json-viewer.js';

interface QueryMetricsRecord {
  id: string;
  dql?: string;
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
  location?: 'local' | 'http';
}

type In = { type: 'metrics.state'; records: QueryMetricsRecord[] };

function formatLatency(ms: number | undefined): string {
  if (ms === undefined) { return '—'; }
  if (ms < 1) { return '<1 ms'; }
  if (ms < 1000) { return `${ms.toFixed(0)} ms`; }
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatTimestamp(ts: number | undefined): string {
  if (!ts) { return '—'; }
  return new Date(ts).toLocaleString();
}

/** Heuristic: assume the query used an index if the EXPLAIN output
 *  mentions one. Mirrors SwiftUI's QueryExplainRecord.usedIndex. */
function usedIndex(record: QueryMetricsRecord): boolean {
  if (record.usedIndex !== undefined) { return record.usedIndex; }
  return (record.explain ?? '').toLowerCase().includes('index');
}

function latencyClass(ms: number | undefined): string {
  if (ms === undefined) { return ''; }
  if (ms < 50) { return 't-ok'; }
  if (ms < 500) { return 't-warn'; }
  return 't-bad';
}

@customElement('ditto-query-metrics')
export class QueryMetricsElement extends LitElement {
  @state() private records: QueryMetricsRecord[] = [];
  @state() private selectedId: string | null = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      box-sizing: border-box;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .title { font-size: 14px; font-weight: 600; }
    .count {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
      font-family: var(--vscode-editor-font-family);
    }
    .spacer { flex: 1; }
    .header button {
      padding: 3px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    .header button[disabled] { opacity: 0.4; cursor: not-allowed; }

    .body {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .list {
      width: 40%;
      min-width: 260px;
      max-width: 480px;
      overflow-y: auto;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .row {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .row-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .row-ts {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
    }
    .row.selected .row-ts { color: inherit; }
    .row-pill {
      padding: 0 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 10px;
    }
    .row-pill.t-ok    { background: var(--vscode-charts-green);  color: #fff; }
    .row-pill.t-warn  { background: var(--vscode-charts-orange); color: #fff; }
    .row-pill.t-bad   { background: var(--vscode-charts-red);    color: #fff; }
    .row-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--vscode-charts-orange);
    }
    .row-dot.idx-ok { background: var(--vscode-charts-green); }
    .row-dql {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .detail {
      flex: 1;
      overflow: auto;
      padding: 16px;
      min-width: 0;
    }
    .detail h2 {
      margin: 0 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
    }
    .detail .section { margin-bottom: 16px; }
    .detail pre {
      margin: 0;
      padding: 8px 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge {
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .badge.t-ok    { background: var(--vscode-charts-green);  color: #fff; }
    .badge.t-warn  { background: var(--vscode-charts-orange); color: #fff; }
    .badge.t-bad   { background: var(--vscode-charts-red);    color: #fff; }
    .badge.loc {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .explain-viewer {
      display: block;
      max-height: 60vh;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }

    .empty {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      flex: 1;
    }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<In>(this, msg => this.onHostMessage(msg));

  private onHostMessage(m: In): void {
    if (m.type === 'metrics.state') {
      this.records = m.records;
      // Keep the selection sticky when the same id is still in the
      // list; otherwise default to the newest record so the detail
      // pane always has something to show.
      if (this.selectedId && !this.records.some(r => r.id === this.selectedId)) {
        this.selectedId = null;
      }
      if (this.selectedId === null && this.records.length > 0) {
        this.selectedId = this.records[0].id;
      }
    }
  }

  private select(id: string): void { this.selectedId = id; }

  private clear(): void { postToHost({ type: 'metrics.clear' }); }

  render() {
    return html`
      <div class="header">
        <span class="title">Query Metrics</span>
        <span class="count">${this.records.length} record${this.records.length === 1 ? '' : 's'}</span>
        <span class="spacer"></span>
        <button
          ?disabled=${this.records.length === 0}
          title="Drop every recorded EXPLAIN run for this connection"
          @click=${this.clear}
        >Clear</button>
      </div>
      ${this.records.length === 0 ? html`
        <div class="empty">
          Run a DQL query in the Query Editor to see its EXPLAIN history here.
        </div>
      ` : html`
        <div class="body">
          ${this.renderList()}
          ${this.renderDetail()}
        </div>
      `}
    `;
  }

  private renderList() {
    return html`
      <div class="list" role="list">
        ${this.records.map(r => {
          const selected = r.id === this.selectedId;
          const tcls = latencyClass(r.durationMs);
          const idxOk = usedIndex(r);
          const loc = r.location === 'http' ? 'HTTP' : r.location === 'local' ? 'Local' : null;
          return html`
            <div
              role="listitem"
              class=${`row ${selected ? 'selected' : ''}`}
              @click=${() => this.select(r.id)}
            >
              <div class="row-head">
                <span class="row-ts">${formatTimestamp(r.timestamp)}</span>
                <span class="spacer"></span>
                ${loc ? html`<span class="row-pill">${loc}</span>` : nothing}
                <span class=${`row-pill ${tcls}`}>${formatLatency(r.durationMs)}</span>
                <span class=${`row-dot ${idxOk ? 'idx-ok' : ''}`} title=${idxOk ? 'Index used' : 'Full scan'}></span>
              </div>
              <div class="row-dql">${r.dql ?? '(no DQL)'}</div>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderDetail() {
    const r = this.records.find(x => x.id === this.selectedId);
    if (!r) {
      return html`<div class="empty">Select a record on the left to inspect.</div>`;
    }
    const tcls = latencyClass(r.durationMs);
    const idxOk = usedIndex(r);
    const locLabel = r.location === 'http' ? 'HTTP' : r.location === 'local' ? 'Local Database' : null;
    return html`
      <div class="detail">
        <div class="section">
          <h2>DQL</h2>
          <pre>${r.dql ?? '(no DQL)'}</pre>
        </div>
        <div class="section">
          <h2>Stats</h2>
          <div class="badges">
            <span class=${`badge ${tcls}`}>Time: ${formatLatency(r.durationMs)}</span>
            <span class="badge">Results: ${r.resultCount ?? '—'}</span>
            <span class=${`badge ${idxOk ? 't-ok' : 't-warn'}`}>Index: ${idxOk ? '✓' : '✗'}</span>
            ${locLabel ? html`<span class="badge loc">Location: ${locLabel}</span>` : nothing}
            <span class="badge">At: ${formatTimestamp(r.timestamp)}</span>
          </div>
        </div>
        <div class="section">
          <h2>EXPLAIN</h2>
          ${r.explain
            ? html`<json-viewer class="explain-viewer" .value=${r.explain} wrap></json-viewer>`
            : html`<pre>(plan unavailable)</pre>`}
        </div>
      </div>
    `;
  }
}
