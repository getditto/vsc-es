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

  static override styles = css`
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

    /* ─── Rendered-help styling ─────────────────────────────────
       Lives here, not in the bundled help.css file, because the help
       HTML is injected via .innerHTML into the shadow DOM — a
       <link rel="stylesheet" href="help.css"> inside that injected
       HTML resolves against the wrong base URL and never loads, so
       links would otherwise fall back to the browser default
       (#0000EE — illegible on dark backgrounds). Lit's static styles
       apply to everything in the shadow root, including innerHTML
       content. */
    .help-root {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      line-height: 1.5;
    }
    .help-root h1, .help-root h2, .help-root h3 {
      color: var(--vscode-textLink-foreground);
      margin-top: 1em;
    }
    .help-root h1 {
      font-size: 1.4em;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 4px;
    }
    .help-root h2 { font-size: 1.2em; }
    .help-root code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      border-radius: 3px;
    }
    .help-root pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .help-root pre code { background: transparent; padding: 0; }
    .help-root a { color: #58A6FF; text-decoration: underline; }
    .help-root a:hover { color: #79B8FF; }
    .help-root ul, .help-root ol { padding-left: 1.4em; }
    .help-root table { border-collapse: collapse; }
    .help-root th, .help-root td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
    }
  `;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('uri')) {
      if (this.uri) {
        void this.load();
      } else {
        this.htmlContent = '';
        this.failed = false;
      }
    }
  }

  /** Monotonic load counter — a slow fetch for a superseded `uri` must not
   *  overwrite the content of a newer one. */
  private loadSeq = 0;

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.failed = false;
    try {
      const r = await fetch(this.uri);
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const text = await r.text();
      if (seq !== this.loadSeq) { return; }
      this.htmlContent = text;
    } catch {
      if (seq !== this.loadSeq) { return; }
      this.failed = true;
      this.htmlContent = '';
    }
  }

  override render() {
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
