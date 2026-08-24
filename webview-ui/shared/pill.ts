import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Color name mapping. Five fixed slots so callers can't drift away from
 *  the legend at the bottom of the Profile viewer (which spells out
 *  blue/green/red/orange/purple). */
export type PillColor = 'blue' | 'green' | 'red' | 'orange' | 'purple';

@customElement('ditto-pill')
export class DittoPill extends LitElement {
  @property({ type: String }) label = '';
  @property({ type: String }) value = '';
  // `reflect: true` — the host-attribute selectors (:host([color='blue']),
  // etc.) match against the DOM attribute, not the JS property. Without
  // reflection, mutating `el.color = 'red'` via JS would silently fail
  // to restyle. All current callers set color via attribute templates
  // so this is defense-in-depth, not a current bug.
  @property({ type: String, reflect: true }) color: PillColor = 'blue';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family);
      border-radius: 999px;
      line-height: 1.4;
      white-space: nowrap;
    }
    .label { font-weight: 600; }
    /* Color slots — light translucent fill, slightly darker border,
     *  text in the full color. Tuned for both light and dark themes
     *  because VS Code chart colors are theme-aware. */
    :host([color='blue'])   { background: rgba( 41,121,255,0.16); border: 1px solid rgba( 41,121,255,0.35); color: var(--vscode-charts-blue,   #2979ff); }
    :host([color='green'])  { background: rgba( 46,160, 67,0.16); border: 1px solid rgba( 46,160, 67,0.35); color: var(--vscode-charts-green,  #2ea043); }
    :host([color='red'])    { background: rgba(229, 57, 53,0.16); border: 1px solid rgba(229, 57, 53,0.35); color: var(--vscode-charts-red,    #e53935); }
    :host([color='orange']) { background: rgba(245,124,  0,0.16); border: 1px solid rgba(245,124,  0,0.35); color: var(--vscode-charts-orange, #f57c00); }
    :host([color='purple']) { background: rgba(142, 36,170,0.16); border: 1px solid rgba(142, 36,170,0.35); color: var(--vscode-charts-purple, #8e24aa); }
  `;

  override render() {
    return html`<span class="label">${this.label}</span><span class="value">${this.value}</span>`;
  }
}
