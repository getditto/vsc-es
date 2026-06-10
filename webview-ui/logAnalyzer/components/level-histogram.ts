import { LitElement, html, css, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { AnalyzerState } from '../../../src/logAnalyzer/types.js';

/** Stacked-bar histogram of log volume by level over time. Each bin
 *  contributes one vertical column made of one rect per log level,
 *  stacked from the bottom up. Heights are normalized to the bin
 *  with the largest total count so the busiest interval reaches the
 *  top of the viewBox. Pure SVG — no axes or labels (the surrounding
 *  panel provides the title). */
const LEVEL_COLORS: Record<string, string> = {
  error: '#ff5252',
  warn: '#d4a017',
  info: '#4ea1ff',
  debug: '#888',
  trace: '#555',
};

@customElement('level-histogram')
export class LevelHistogram extends LitElement {
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
  bins: AnalyzerState['histograms']['volumeByLevel'] = [];

  render(): TemplateResult {
    if (this.bins.length === 0) {
      return html`<div class="empty">No volume data yet.</div>`;
    }
    const maxTotal = Math.max(
      ...this.bins.map((b) =>
        Object.values(b.counts).reduce((s, v) => s + v, 0),
      ),
    ) || 1;
    const w = 100 / this.bins.length;
    return html`
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        ${this.bins.map((b, i) => {
          let y = 100;
          return Object.entries(b.counts).map(([level, n]) => {
            const h = (n / maxTotal) * 100;
            y -= h;
            return svg`<rect x="${i * w}" y="${y}" width="${w * 0.9}" height="${h}" fill="${LEVEL_COLORS[level] ?? '#888'}" />`;
          });
        })}
      </svg>
    `;
  }
}
