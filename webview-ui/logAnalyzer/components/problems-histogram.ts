import { LitElement, html, css, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { AnalyzerState } from '../../../src/logAnalyzer/types.js';

/** One bar per time bin, colored by the bin's max severity. Heights
 *  are normalized to the busiest bin. The color ramp matches the
 *  severity scale used elsewhere in the panel (5=critical → 1=info). */
const SEV_COLOR: Record<number, string> = {
  5: '#ff5252',
  4: '#ff8a52',
  3: '#d4a017',
  2: '#4ea1ff',
  1: '#888',
};

@customElement('problems-histogram')
export class ProblemsHistogram extends LitElement {
  static styles = css`
    :host { display: block; }
    svg { width: 100%; height: 120px; }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 8px;
      font-family: var(--vscode-font-family);
    }
  `;

  @property({ type: Array })
  bins: AnalyzerState['histograms']['problemsOverTime'] = [];

  render(): TemplateResult {
    if (this.bins.length === 0) {
      return html`<div class="empty">No problems yet.</div>`;
    }
    const max = Math.max(...this.bins.map((b) => b.count)) || 1;
    const w = 100 / this.bins.length;
    return html`
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        ${this.bins.map((b, i) => {
          const h = (b.count / max) * 100;
          return svg`<rect x="${i * w}" y="${100 - h}" width="${w * 0.9}" height="${h}" fill="${SEV_COLOR[b.maxSeverity] ?? '#888'}" />`;
        })}
      </svg>
    `;
  }
}
