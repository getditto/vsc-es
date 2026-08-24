import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { KeyedRawPattern } from '../../../src/logAnalyzer/PatternEngine.js';

/** Two-section list: bundled (read-only, lock icon) above user
 *  patterns (with Edit / Delete buttons). Emits bubbling
 *  `edit` / `delete` events that the root element handles. */
@customElement('pattern-list')
export class PatternList extends LitElement {
  static override styles = css`
    :host {
      display: block;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    h3 { margin: 16px 0 8px; }
    .row {
      display: grid;
      grid-template-columns: 20px 1fr 60px 2fr 120px;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      align-items: center;
    }
    .key { font-weight: 600; }
    .sev { color: var(--vscode-descriptionForeground); }
    .pattern {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    button {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 6px;
      margin-right: 4px;
      font: inherit;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .empty { color: var(--vscode-descriptionForeground); padding: 8px; }
  `;

  @property({ type: Array }) bundled: KeyedRawPattern[] = [];
  @property({ type: Array }) user: KeyedRawPattern[] = [];

  private edit(p: KeyedRawPattern): void {
    this.dispatchEvent(new CustomEvent('edit', { detail: p, bubbles: true, composed: true }));
  }

  private del(key: string): void {
    this.dispatchEvent(new CustomEvent('delete', { detail: { key }, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    return html`
      <h3>Bundled (read-only)</h3>
      ${this.bundled.length === 0
        ? html`<div class="empty">No bundled patterns loaded.</div>`
        : ''}
      ${this.bundled.map(p => html`
        <div class="row">
          <span title="bundled">🔒</span>
          <span class="key">${p.key}</span>
          <span class="sev">SEV ${p.severity}</span>
          <span class="pattern">${p.pattern}</span>
          <span></span>
        </div>
      `)}
      <h3>User patterns</h3>
      ${this.user.length === 0
        ? html`<div class="empty">None yet. Use the Add Pattern button above.</div>`
        : ''}
      ${this.user.map(p => html`
        <div class="row">
          <span></span>
          <span class="key">${p.key}</span>
          <span class="sev">SEV ${p.severity}</span>
          <span class="pattern">${p.pattern}</span>
          <span>
            <button @click=${() => this.edit(p)}>Edit</button>
            <button @click=${() => this.del(p.key)}>Delete</button>
          </span>
        </div>
      `)}
    `;
  }
}
