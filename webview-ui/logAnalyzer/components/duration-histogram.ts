import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { AnalyzerState } from '../../../src/logAnalyzer/types.js';

/** Horizontal bar chart of closed-session counts grouped into log-scale
 *  duration bins (e.g. "<1s", "1–10s", "10s–1m", …). Each row shows
 *  the bin label, a proportional bar, and the absolute count. Empty
 *  bins are still rendered as a zero-width bar so the axis stays
 *  aligned across renders. */
@customElement('duration-histogram')
export class DurationHistogram extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
    .label {
      min-width: 60px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .bar-track {
      flex: 1;
      background: var(--vscode-input-background);
      height: 12px;
    }
    .bar { background: #4ea1ff; height: 12px; }
    .empty { color: var(--vscode-descriptionForeground); padding: 8px; }
  `;

  @property({ type: Array })
  bins: AnalyzerState['histograms']['connectionDurations'] = [];

  render(): TemplateResult {
    if (this.bins.length === 0 || this.bins.every((b) => b.count === 0)) {
      return html`<div class="empty">No closed sessions yet.</div>`;
    }
    const max = Math.max(...this.bins.map((b) => b.count)) || 1;
    return html`
      ${this.bins.map(
        (b) => html`
          <div class="row">
            <span class="label">${b.binLabel}</span>
            <div class="bar-track">
              <div class="bar" style="width:${(b.count / max) * 100}%"></div>
            </div>
            <span class="label">${b.count}</span>
          </div>
        `,
      )}
    `;
  }
}
