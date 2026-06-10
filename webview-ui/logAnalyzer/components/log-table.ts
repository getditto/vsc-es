import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { LogLine } from '../../../src/logAnalyzer/types.js';

const ROW_HEIGHT = 22; // px
const OVERSCAN = 5;

/** Virtualized log table. Renders only the rows in the visible window
 *  (plus a small overscan) so we can show large filtered result sets
 *  without paying for full DOM. Columns: Timestamp / Level / Tag /
 *  Message. Click a row → `line-clicked` event with `{ lineId }`. */
@customElement('log-table')
export class LogTable extends LitElement {
  static styles = css`
    :host {
      display: block;
      /* Fill the available height from the parent's flex layout, but keep
         a sensible floor so the table is usable even on small panels. */
      height: 100%;
      min-height: 300px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      position: relative;
    }
    .head {
      display: grid;
      grid-template-columns: 110px 60px 140px 1fr;
      gap: 8px;
      padding: 4px 8px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .spacer { position: relative; }
    .row {
      position: absolute;
      left: 0;
      right: 0;
      display: grid;
      grid-template-columns: 110px 60px 140px 1fr;
      gap: 8px;
      padding: 2px 8px;
      height: ${ROW_HEIGHT}px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      box-sizing: border-box;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .ts    { color: var(--vscode-descriptionForeground); }
    .lvl-error { color: #ff5252; font-weight: 600; }
    .lvl-warn  { color: #d4a017; }
    .lvl-info  { color: var(--vscode-foreground); }
    .lvl-debug { color: var(--vscode-descriptionForeground); }
    .lvl-trace { color: var(--vscode-descriptionForeground); }
    .tag   { color: #4ea1ff; overflow: hidden; text-overflow: ellipsis; }
    .msg   { overflow: hidden; text-overflow: ellipsis; }
    .empty {
      padding: 20px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
  `;

  @property({ type: Array }) lines: LogLine[] = [];
  @property({ type: Number }) selectedId: number | null = null;

  // Renamed off `scrollTop` because that's an HTMLElement instance
  // property — collision blocks TS subclassing of LitElement.
  @state() private _scrollTop = 0;
  @state() private viewportHeight = 500;

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('scroll', this.onScroll);
  }

  disconnectedCallback(): void {
    this.removeEventListener('scroll', this.onScroll);
    super.disconnectedCallback();
  }

  firstUpdated(): void {
    this.viewportHeight = this.clientHeight || 500;
  }

  private onScroll = (): void => {
    this._scrollTop = (this as unknown as HTMLElement).scrollTop;
  };

  private clickRow(lineId: number): void {
    this.dispatchEvent(new CustomEvent('line-clicked', { detail: { lineId }, bubbles: true, composed: true }));
  }

  render(): TemplateResult {
    if (this.lines.length === 0) {
      return html`
        <div class="head">
          <div>Timestamp</div><div>Level</div><div>Tag</div><div>Message</div>
        </div>
        <div class="empty">No lines match the current filter.</div>
      `;
    }
    const total = this.lines.length;
    const startIdx = Math.max(0, Math.floor(this._scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(this.viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const endIdx = Math.min(total, startIdx + visibleCount);
    const visible = this.lines.slice(startIdx, endIdx);

    return html`
      <div class="head">
        <div>Timestamp</div><div>Level</div><div>Tag</div><div>Message</div>
      </div>
      <div class="spacer" style="height: ${total * ROW_HEIGHT}px;">
        ${visible.map((l, i) => {
          const idx = startIdx + i;
          const ts = l.timestamp ? new Date(l.timestamp).toISOString().slice(11, 23) : '—';
          const top = idx * ROW_HEIGHT;
          return html`
            <div
              class="row ${this.selectedId === l.id ? 'selected' : ''}"
              style="top: ${top}px"
              @click=${(): void => this.clickRow(l.id)}
            >
              <span class="ts">${ts}</span>
              <span class="lvl-${l.level}">${l.level.toUpperCase()}</span>
              <span class="tag">${l.tag ?? ''}</span>
              <span class="msg">${l.text}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}
