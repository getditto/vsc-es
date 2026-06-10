import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { LogLine } from '../../../src/logAnalyzer/types.js';

/** Right-side flyout panel showing a single log line plus surrounding
 *  context. The host fills `line`, `before`, `after` after a successful
 *  analyzer.lineDetail response. The drawer hides itself via the
 *  `hidden` attribute, which slides it off-screen with a CSS transform
 *  for a polished open/close. */
@customElement('line-detail-drawer')
export class LineDetailDrawer extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 480px;
      max-width: 95vw;
      background: var(--vscode-sideBar-background);
      border-left: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      box-shadow: -4px 0 12px rgba(0, 0, 0, 0.3);
      transition: transform 0.15s ease;
      z-index: 100;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    :host([hidden]) {
      transform: translateX(100%);
      /* Keep display so the transform still animates out. */
      display: flex;
    }
    .head {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .head h3 { margin: 0; font-size: 13px; }
    .close {
      background: transparent;
      border: 0;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 16px;
      padding: 2px 8px;
    }
    .close:hover { background: var(--vscode-list-hoverBackground); }
    .body {
      padding: 12px 14px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      flex: 1 1 auto;
    }
    .line {
      padding: 4px 0;
      white-space: pre-wrap;
      word-break: break-word;
      border-radius: 3px;
    }
    .line.center {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      padding: 6px 8px;
      margin: 4px -4px;
    }
    .lvl-error { color: #ff5252; }
    .lvl-warn  { color: #d4a017; }
    .lvl-info  { color: var(--vscode-foreground); }
    .lvl-debug { color: var(--vscode-descriptionForeground); }
    .lvl-trace { color: var(--vscode-descriptionForeground); }
    .empty {
      padding: 20px;
      color: var(--vscode-descriptionForeground);
    }
    .meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding-bottom: 2px;
    }
    .line.center .meta { color: var(--vscode-list-activeSelectionForeground); opacity: 0.85; }
  `;

  @property({ type: Object }) line: LogLine | null = null;
  // `before` / `after` collide with HTMLElement methods, so the props
  // use a `Lines` suffix. The root element binds them as
  // `.beforeLines=${…}` / `.afterLines=${…}`.
  @property({ type: Array, attribute: 'before-lines' }) beforeLines: LogLine[] = [];
  @property({ type: Array, attribute: 'after-lines' }) afterLines: LogLine[] = [];

  private close(): void {
    this.dispatchEvent(new CustomEvent('drawer-close', { bubbles: true, composed: true }));
  }

  private renderLine(l: LogLine, isCenter: boolean): TemplateResult {
    const ts = l.timestamp ? new Date(l.timestamp).toISOString() : '—';
    return html`
      <div class="line ${isCenter ? 'center' : ''}">
        <div class="meta">
          ${ts}
          <span class="lvl-${l.level}">${l.level.toUpperCase()}</span>
          ${l.tag ? html`[${l.tag}]` : ''}
        </div>
        <div>${l.text}</div>
      </div>
    `;
  }

  render(): TemplateResult {
    return html`
      <div class="head">
        <h3>Log line detail</h3>
        <button class="close" @click=${this.close} aria-label="Close">×</button>
      </div>
      <div class="body">
        ${this.line == null
          ? html`<div class="empty">No line selected.</div>`
          : html`
              ${this.beforeLines.map(l => this.renderLine(l, false))}
              ${this.renderLine(this.line, true)}
              ${this.afterLines.map(l => this.renderLine(l, false))}
            `}
      </div>
    `;
  }
}
