// webview-ui/inspector/query-metrics-element.ts
//
// Shows execution metrics for the most recent query: DQL, badges
// (time, result count, index used, timestamp), and EXPLAIN plan.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { codiconStyles } from './codicon-styles.js';
import { postToHost } from '../shared/messaging.js';
import '../shared/json-viewer.js';

interface QueryResultMetadata {
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
  dql?: string;
  location?: 'local' | 'http';
}

@customElement('query-metrics-element')
export class QueryMetricsElement extends LitElement {
  @property({ type: Object }) metadata: QueryResultMetadata | undefined;
  /** When true, suppress the LIMIT-clause suggestion entirely. Sticky
   *  user preference set by clicking the tip's dismiss × — bound from
   *  inspector-element which sources it from the host. */
  @property({ type: Boolean }) hideLimitHint = false;

  static override styles = [codiconStyles, css`
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
    .explain-viewer {
      display: block;
      max-height: 60vh;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    /* Informational tip about LIMIT — uses VS Code's editorInfo theme
       tokens so it reads as advice, not a warning. Background tint
       gives it visual weight; the left border is the same colour as
       the icon so it stands out without being alarming. */
    .tip {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 8px 10px;
      margin-bottom: 12px;
      background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 12%, transparent);
      border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
      border-radius: 2px;
      font-size: 12px;
      line-height: 1.45;
    }
    .tip .codicon-info {
      color: var(--vscode-editorInfo-foreground, #3794ff);
      flex-shrink: 0;
      margin-top: 1px;
    }
    .tip-body { flex: 1; min-width: 0; }
    .tip code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .tip-dismiss {
      background: transparent;
      border: 0;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 0;
      margin: 0;
      flex-shrink: 0;
      opacity: 0.7;
      font-size: 14px;
      line-height: 1;
    }
    .tip-dismiss:hover { opacity: 1; color: var(--vscode-foreground); }
  `];

  /** True when the query is a SELECT without a LIMIT clause. We're
   *  permissive — `\bLIMIT\s+\d+` matches the common bare form, the
   *  parameterised form (`LIMIT :n`), and arbitrary whitespace
   *  between the keyword and its value. False positives are unlikely
   *  because the word boundary stops `\b` from matching identifiers
   *  that just happen to contain the substring. */
  private shouldHintLimit(dql: string | undefined): boolean {
    if (!dql) { return false; }
    const trimmed = dql.trimStart();
    if (!/^SELECT\b/i.test(trimmed)) { return false; }
    return !/\bLIMIT\s+\S/i.test(trimmed);
  }

  /** Optimistically suppress the tip locally, then ask the host to
   *  persist the preference. The host re-pushes via inspector.preferences
   *  on every webview that's resolved, so other Inspector views (if
   *  the user has more than one) update too. */
  private dismissLimitHint = (): void => {
    this.hideLimitHint = true;
    postToHost({ type: 'inspector.dismissLimitHint' });
  };

  override render() {
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
    const locationLabel = md.location === 'http'
      ? 'HTTP'
      : md.location === 'local' ? 'Local Database' : null;
    const showLimitTip = !this.hideLimitHint && this.shouldHintLimit(md.dql);
    return html`
      ${showLimitTip ? html`
        <div class="tip" role="note">
          <span class="codicon codicon-info"></span>
          <div class="tip-body">
            This query has no <code>LIMIT</code> clause. On large
            collections this can return tens of thousands of rows and
            pull the whole result set into memory. Adding e.g.
            <code>LIMIT 100</code> usually makes the query
            substantially faster and is enough to inspect the data.
          </div>
          <button
            class="tip-dismiss"
            title="Don't show this tip again. Re-enable from Help → Reset Warnings (or Command Palette → Ditto: Reset Warnings)."
            aria-label="Dismiss tip"
            @click=${this.dismissLimitHint}
          >×</button>
        </div>
      ` : ''}
      ${locationLabel !== null ? html`
        <div class="row">
          <div class="label">Location</div>
          <pre>${locationLabel}</pre>
        </div>
      ` : ''}
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
        ${md.explain
          ? html`<json-viewer class="explain-viewer" .value=${md.explain} wrap></json-viewer>`
          : html`<pre>(plan unavailable)</pre>`}
      </div>
    `;
  }
}
