import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { SummaryCounts } from '../../../src/logAnalyzer/types.js';

/** Compact one-row summary at the top of the Log Analyzer panel.
 *  Pure presentation — all values arrive via @property from the root. */
@customElement('summary-header')
export class SummaryHeader extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 8px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .row { display: flex; gap: 16px; flex-wrap: wrap; }
    .item { display: flex; align-items: center; gap: 6px; }
    .crit { color: var(--vscode-errorForeground); font-weight: 600; }
    .err  { color: var(--vscode-errorForeground); }
    .warn { color: var(--vscode-editorWarning-foreground); }
    .muted { color: var(--vscode-descriptionForeground); }
  `;

  @property({ type: Object }) counts: SummaryCounts | null = null;
  @property({ type: Array }) tags: string[] = [];
  @property({ type: String }) sdkVersion: string | null = null;
  @property({ type: String }) sessionRange = '';

  render(): TemplateResult {
    const c = this.counts;
    if (!c) { return html`<span class="muted">Loading…</span>`; }
    return html`
      <div class="row">
        <span class="item crit">Critical: ${c.critical}</span>
        <span class="item err">Errors: ${c.errors}</span>
        <span class="item warn">Warnings: ${c.warnings}</span>
        <span class="item">Problems: ${c.problems}</span>
        <span class="item muted">Lines: ${c.totalLines}</span>
      </div>
      <div class="row" style="margin-top:4px;">
        <span class="item muted">SDK: ${this.sdkVersion ?? 'unknown'}</span>
        <span class="item muted">Tags: ${this.tags.length === 0 ? 'none' : this.tags.join(', ')}</span>
        <span class="item muted">Range: ${this.sessionRange || 'n/a'}</span>
      </div>
    `;
  }
}
