import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import './level-histogram.js';
import './problems-histogram.js';
import './duration-histogram.js';
import type { AnalyzerState } from '../../../src/logAnalyzer/types.js';

/** Container that lays out the three histograms in a 2-column grid:
 *  log volume + problems-over-time side-by-side, then the wider
 *  duration histogram spanning the full row. Receives the whole
 *  `histograms` bag from the root and forwards each slice to its
 *  child component. Pure presentation — no IPC. */
@customElement('histograms-row')
export class HistogramsRow extends LitElement {
  static override styles = css`
    :host {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 12px 0;
    }
    .full { grid-column: 1 / -1; }
    .panel {
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      border-radius: 4px;
    }
    .title {
      font-weight: 600;
      margin-bottom: 4px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
  `;

  @property({ type: Object })
  histograms: AnalyzerState['histograms'] = {
    volumeByLevel: [],
    problemsOverTime: [],
    connectionDurations: [],
  };

  override render(): TemplateResult {
    return html`
      <div class="panel">
        <div class="title">Log Volume by Level</div>
        <level-histogram .bins=${this.histograms.volumeByLevel}></level-histogram>
      </div>
      <div class="panel">
        <div class="title">Problems over Time</div>
        <problems-histogram .bins=${this.histograms.problemsOverTime}></problems-histogram>
      </div>
      <div class="panel full">
        <div class="title">Connection Durations</div>
        <duration-histogram .bins=${this.histograms.connectionDurations}></duration-histogram>
      </div>
    `;
  }
}
