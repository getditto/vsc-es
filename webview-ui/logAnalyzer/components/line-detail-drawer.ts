import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { LogLine } from '../../../src/logAnalyzer/types.js';

/** Right-side flyout panel showing the single selected log line.
 *
 *  Earlier versions of this drawer rendered ±5 lines of surrounding
 *  context — the result was a tall stack of run-on lines with no
 *  obvious boundaries between them. Users wanted "show me the line
 *  I clicked, full stop." This version honours that: clean key/value
 *  rows (Timestamp / Level / Tag / Message) with horizontal dividers
 *  and a fully-wrapped Message field so long log lines stay readable.
 *
 *  The `beforeLines` / `afterLines` props are kept on the API for
 *  backward compat with the host's `analyzer.lineDetail` IPC payload
 *  (no need to churn the protocol), but they're no longer rendered. */
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
      flex: 0 0 auto;
    }
    .head h3 { margin: 0; font-size: 13px; font-weight: 600; }
    .close {
      background: transparent;
      border: 0;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 2px 8px;
      border-radius: 2px;
    }
    .close:hover { background: var(--vscode-list-hoverBackground); }

    .body {
      padding: 0;
      overflow: auto;
      flex: 1 1 auto;
    }

    /* Key/value table. Each row has a left-aligned label and a
       wrapped value, separated by a thin divider so the visual
       boundaries are unmistakable. */
    dl {
      margin: 0;
      padding: 0;
    }
    .field {
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .field:last-child {
      border-bottom: none;
    }
    .field dt {
      margin: 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      align-self: start;
      padding-top: 2px;
    }
    .field dd {
      margin: 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      word-break: break-word;
      white-space: pre-wrap;
      line-height: 1.5;
    }

    .level-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .lvl-error { background: rgba(255, 82, 82, 0.18); color: #ff5252; }
    .lvl-warn  { background: rgba(212, 160, 23, 0.18); color: #d4a017; }
    .lvl-info  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .lvl-debug { background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }
    .lvl-trace { background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); }

    .tag-chip {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 3px;
      background: var(--vscode-input-background);
      color: #4ea1ff;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .user-tag-chip {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 3px;
      background: var(--vscode-input-background);
      color: #b08fff;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      margin-right: 4px;
    }
    .tag-none {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .empty {
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  `;

  @property({ type: Object }) line: LogLine | null = null;
  // Kept on the API for IPC compatibility; no longer rendered.
  @property({ type: Array, attribute: 'before-lines' }) beforeLines: LogLine[] = [];
  @property({ type: Array, attribute: 'after-lines' }) afterLines: LogLine[] = [];

  private close(): void {
    this.dispatchEvent(new CustomEvent('drawer-close', { bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    const l = this.line;
    return html`
      <div class="head">
        <h3>Log line detail</h3>
        <button class="close" @click=${this.close} aria-label="Close">×</button>
      </div>
      <div class="body">
        ${l == null
          ? html`<div class="empty">No line selected.</div>`
          : html`
              <dl>
                <div class="field">
                  <dt>Timestamp</dt>
                  <dd>${l.timestamp ? new Date(l.timestamp).toISOString() : '—'}</dd>
                </div>
                <div class="field">
                  <dt>Level</dt>
                  <dd>
                    <span class="level-pill lvl-${l.level}">
                      ${l.level.toUpperCase()}
                    </span>
                  </dd>
                </div>
                <div class="field">
                  <dt>Tag</dt>
                  <dd>
                    ${l.tag
                      ? html`<span class="tag-chip">${l.tag}</span>`
                      : html`<span class="tag-none">(no tag)</span>`}
                  </dd>
                </div>
                ${l.userTags && l.userTags.length > 0
                  ? html`
                      <div class="field">
                        <dt>User tags</dt>
                        <dd>
                          ${l.userTags.map(t => html`<span class="user-tag-chip">${t}</span>`)}
                        </dd>
                      </div>`
                  : ''}
                <div class="field">
                  <dt>Message</dt>
                  <dd>${l.text}</dd>
                </div>
              </dl>
            `}
      </div>
    `;
  }
}
