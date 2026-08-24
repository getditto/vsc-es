import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** Simple accordion-style container used to collapse the dashboard
 *  sub-sections (Summary, Histograms, Timeline) so the user can give
 *  the log table more vertical real estate. */
@customElement('collapsible-section')
export class CollapsibleSection extends LitElement {
  static override styles = css`
    :host {
      display: block;
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .header {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      user-select: none;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .header:hover { background: var(--vscode-list-hoverBackground); }
    .chevron {
      display: inline-block;
      width: 12px;
      transition: transform 0.15s;
    }
    .chevron.open { transform: rotate(90deg); }
    .body { padding: 8px 10px; }
  `;

  @property({ type: String }) heading = '';
  @property({ type: Boolean, attribute: 'open' }) isOpen = true;
  @state() private _open = true;

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('isOpen')) this._open = this.isOpen;
  }

  private toggle(): void {
    this._open = !this._open;
  }

  override render(): TemplateResult {
    return html`
      <div class="header" @click=${this.toggle}>
        <span class="chevron ${this._open ? 'open' : ''}">▶</span>
        <span>${this.heading}</span>
      </div>
      ${this._open ? html`<div class="body"><slot></slot></div>` : ''}
    `;
  }
}
