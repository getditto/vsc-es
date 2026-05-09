// webview-ui/inspector/query-metrics-element.ts
//
// Shows execution metrics for the most recent query: DQL, badges
// (time, result count, index used, timestamp), and EXPLAIN plan.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

interface QueryResultMetadata {
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
  dql?: string;
}

@customElement('query-metrics-element')
export class QueryMetricsElement extends LitElement {
  @property({ type: Object }) metadata: QueryResultMetadata | undefined;

  static styles = css`
    :host { display: block; padding: 12px; color: var(--vscode-foreground); }
    .empty {
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 32px;
    }
    .row { margin-bottom: 12px; }
    .label { font-weight: 600; margin-bottom: 4px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge {
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-family: var(--vscode-editor-font-family);
    }
    .badge.t-ok    { background: var(--vscode-charts-green);  color: #fff; }
    .badge.t-warn  { background: var(--vscode-charts-orange); color: #fff; }
    .badge.t-bad   { background: var(--vscode-charts-red);    color: #fff; }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px 12px;
      border-radius: 4px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;

  render() {
    const md = this.metadata;
    if (!md) {
      return html`
        <div class="empty">
          <span class="codicon codicon-dashboard" style="font-size: 36px"></span>
          <div>Run a query to see execution metrics.</div>
        </div>
      `;
    }
    const t = md.durationMs ?? 0;
    const tCls = t < 50 ? 't-ok' : t < 500 ? 't-warn' : 't-bad';
    const idxCls = md.usedIndex ? 't-ok' : 't-warn';
    return html`
      <div class="row">
        <div class="label">DQL</div>
        <pre>${md.dql ?? '(unavailable)'}</pre>
      </div>
      <div class="row">
        <div class="label">Stats</div>
        <div class="badges">
          <span class="badge ${tCls}">Time: ${t} ms</span>
          <span class="badge">Results: ${md.resultCount ?? '—'}</span>
          <span class="badge ${idxCls}">Index: ${md.usedIndex ? '✓' : '✗'}</span>
          <span class="badge">At: ${md.timestamp ? new Date(md.timestamp).toLocaleString() : '—'}</span>
        </div>
      </div>
      <div class="row">
        <div class="label">EXPLAIN</div>
        <pre>${md.explain ?? '(plan unavailable)'}</pre>
      </div>
    `;
  }
}
