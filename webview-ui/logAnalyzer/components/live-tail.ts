import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { LogLine } from '../../../src/logAnalyzer/types.js';

/** Windowed live log tail. Shows the last 200 lines from the
 *  `analyzer.live` stream in a fixed-height, scrollable monospace
 *  region. Pure presentation: the parent owns the buffer and trims it
 *  to a max size before passing it in. Empty state when no lines are
 *  available (the service may not emit `analyzer.live` at all in some
 *  configurations — that's fine).
 *
 *  `LogLine.timestamp` is `Date | null` in TS but arrives as a string
 *  after JSON serialization; `new Date(...)` accepts both. */
@customElement('live-tail')
export class LiveTail extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 250px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .row {
      padding: 2px 4px;
      display: flex;
      gap: 6px;
      white-space: nowrap;
    }
    .ts { color: var(--vscode-descriptionForeground); }
    .lvl-error { color: #ff5252; }
    .lvl-warn  { color: #d4a017; }
    .lvl-info  { color: var(--vscode-foreground); }
    .lvl-debug { color: var(--vscode-descriptionForeground); }
    .lvl-trace { color: var(--vscode-descriptionForeground); }
    .tag { color: #4ea1ff; }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 8px;
    }
  `;

  @property({ type: Array }) lines: LogLine[] = [];

  render(): TemplateResult {
    if (this.lines.length === 0) {
      return html`<div class="empty">Live tail: no lines yet.</div>`;
    }
    return html`
      ${this.lines.slice(-200).map((l) => {
        const ts = l.timestamp ? new Date(l.timestamp).toISOString().slice(11, 23) : '—';
        return html`
          <div class="row">
            <span class="ts">${ts}</span>
            <span class="lvl-${l.level}">${l.level.toUpperCase()}</span>
            ${l.tag ? html`<span class="tag">[${l.tag}]</span>` : ''}
            <span>${l.text}</span>
          </div>
        `;
      })}
    `;
  }
}
