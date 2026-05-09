// webview-ui/inspector/help-content-element.ts
//
// Renders pre-rendered help HTML inside the inspector. The HTML comes from
// our own bundled `scripts/render-help.mjs` output (no user-supplied content),
// fetched via the webview's CSP-locked URI. We use direct DOM injection because
// the InspectorViewProvider CSP grants `connect-src` (allowing fetch) but not
// `frame-src` (an <iframe> would fail).

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('help-content-element')
export class HelpContentElement extends LitElement {
  @property() uri = '';
  @state() private htmlContent = '';
  @state() private failed = false;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      padding: 12px;
      overflow: auto;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .placeholder { opacity: 0.6; padding: 16px; }
    .err { color: var(--vscode-charts-red); padding: 16px; }
  `;

  updated(changed: Map<string, unknown>): void {
    if (changed.has('uri')) {
      if (this.uri) {
        void this.load();
      } else {
        this.htmlContent = '';
        this.failed = false;
      }
    }
  }

  private async load(): Promise<void> {
    this.failed = false;
    try {
      const r = await fetch(this.uri);
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      this.htmlContent = await r.text();
    } catch {
      this.failed = true;
      this.htmlContent = '';
    }
  }

  render() {
    if (!this.uri) {
      return html`<div class="placeholder">Loading help…</div>`;
    }
    if (this.failed) {
      return html`<div class="err">Help unavailable.</div>`;
    }
    // Inject bundled help HTML. Source is `resources/help/*.md` rendered by
    // `scripts/render-help.mjs` at build time — not user-supplied content.
    return html`<div .innerHTML=${this.htmlContent}></div>`;
  }
}
