import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ProblemInstance } from '../../../src/logAnalyzer/types.js';

/** Severity → label + CSS class. Mirrors the 1..5 scale defined in
 *  src/logAnalyzer/types.ts. */
const SEV_LABELS: Record<number, { label: string; cls: string }> = {
  5: { label: 'CRITICAL', cls: 'sev5' },
  4: { label: 'HIGH',     cls: 'sev4' },
  3: { label: 'MEDIUM',   cls: 'sev3' },
  2: { label: 'LOW',      cls: 'sev2' },
  1: { label: 'INFO',     cls: 'sev1' },
};

/** Grouped problem list — one collapsible group per pattern key.
 *  Header click toggles expansion; the ↗ link on each hit fires a
 *  `reveal-line` CustomEvent that bubbles up to the root element. */
@customElement('problems-list')
export class ProblemsList extends LitElement {
  static styles = css`
    :host { display: block; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .group { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 6px 0; }
    .header { padding: 6px 10px; cursor: pointer; display: flex; gap: 10px; align-items: center; }
    .sev5 { color: #ff5252; font-weight: 700; }
    .sev4 { color: #ff5252; }
    .sev3 { color: #d4a017; }
    .sev2 { color: #4ea1ff; }
    .sev1 { color: var(--vscode-descriptionForeground); }
    .count { color: var(--vscode-descriptionForeground); }
    .rec { color: var(--vscode-descriptionForeground); padding: 0 10px 6px; }
    .hits { padding: 4px 10px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .hit { display: flex; gap: 6px; padding: 2px 0; }
    .ts { color: var(--vscode-descriptionForeground); }
    a { color: var(--vscode-textLink-foreground); }
  `;

  @property({ type: Array }) groups: { key: string; items: ProblemInstance[] }[] = [];
  @state() private expanded = new Set<string>();

  private toggle(key: string): void {
    if (this.expanded.has(key)) { this.expanded.delete(key); }
    else { this.expanded.add(key); }
    this.requestUpdate();
  }

  private revealLine(id: number): void {
    this.dispatchEvent(new CustomEvent('reveal-line', {
      detail: { id },
      bubbles: true,
      composed: true,
    }));
  }

  render(): TemplateResult {
    if (this.groups.length === 0) {
      return html`<div class="rec">Watching for problems. None detected.</div>`;
    }
    return html`
      ${this.groups.map(g => {
        const sev = g.items[0]?.severity ?? 1;
        const lab = SEV_LABELS[sev];
        const open = this.expanded.has(g.key);
        return html`
          <div class="group">
            <div class="header" @click=${() => this.toggle(g.key)}>
              <span class="${lab.cls}">${open ? '▼' : '▶'} ⚠ ${lab.label}</span>
              <span>${g.key}</span>
              <span class="count">(${g.items.length} hit${g.items.length === 1 ? '' : 's'})</span>
            </div>
            <div class="rec">${g.items[0]?.recommendation}</div>
            ${open ? html`
              <div class="hits">
                ${g.items.map(it => html`
                  <div class="hit">
                    <span class="ts">${it.line.timestamp?.toISOString() ?? '—'}</span>
                    <span>${it.line.text}</span>
                    <a href="#" @click=${(e: Event) => { e.preventDefault(); this.revealLine(it.line.id); }}>↗</a>
                  </div>
                `)}
              </div>
            ` : ''}
          </div>
        `;
      })}
    `;
  }
}
