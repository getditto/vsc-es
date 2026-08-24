import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { LogLine } from '../../../src/logAnalyzer/types.js';

const ROW_HEIGHT = 22; // px
const OVERSCAN = 5;

/** Minimum width (px) any column can be dragged down to. Keeps the
 *  column legible even under aggressive resize. */
const MIN_COLUMN_WIDTH = 40;

/** Virtualized log table. Renders only the rows in the visible window
 *  (plus a small overscan) so we can show large filtered result sets
 *  without paying for full DOM. Columns: Timestamp / Level / Tag /
 *  Message. Click a row → `line-clicked` event with `{ lineId }`.
 *
 *  Column widths are user-resizable via drag handles between headers.
 *  The same `grid-template-columns` value is applied to the header and
 *  to every row via `style.setProperty('--cols', ...)` so they stay in
 *  lockstep without re-rendering all rows on each pixel of drag. */
@customElement('log-table')
export class LogTable extends LitElement {
  static override styles = css`
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
      /* Default widths: Timestamp / Level / Tag / User Tag / Message. The
         User Tag column carries pattern-applied labels (semantic
         categories like 'query' or 'auth'); empty for lines no labeled
         pattern matched. Drag handles override at runtime. */
      --col-ts: 110px;
      --col-lvl: 60px;
      --col-tag: 220px;
      --col-utag: 120px;
      --col-msg: 1fr;
    }
    .head {
      display: grid;
      grid-template-columns: var(--col-ts) var(--col-lvl) var(--col-tag) var(--col-utag) var(--col-msg);
      gap: 0;
      padding: 4px 8px;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .head .cell {
      position: relative;
      padding-right: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Drag handle — a 6px-wide strip on the right edge of each header
       cell except the last. Cursor flips to col-resize on hover. */
    .resize {
      position: absolute;
      top: 0;
      right: -3px;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      z-index: 2;
      background: transparent;
      transition: background 0.1s;
    }
    .resize:hover, .resize.dragging {
      background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder));
    }
    .spacer { position: relative; }
    .row {
      position: absolute;
      left: 0;
      right: 0;
      display: grid;
      grid-template-columns: var(--col-ts) var(--col-lvl) var(--col-tag) var(--col-utag) var(--col-msg);
      gap: 0;
      padding: 2px 8px;
      height: ${ROW_HEIGHT}px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      box-sizing: border-box;
    }
    .row > * { padding-right: 8px; overflow: hidden; text-overflow: ellipsis; }
    /* User tags render as a comma-separated chip strip; color picks the
       eye between the SDK tag's blue and the message's body color. */
    .utag { color: #b08fff; }
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

  /** The loaded window, not the whole result set. */
  @property({ type: Array }) lines: LogLine[] = [];
  /** Absolute index of `lines[0]` within the filtered result set. */
  @property({ type: Number }) windowOffset = 0;
  /** Rows matching the filter, before windowing — sizes the scroll area. */
  @property({ type: Number }) totalRows = 0;
  @property({ type: Number }) selectedId: number | null = null;

  // Renamed off `scrollTop` because that's an HTMLElement instance
  // property — collision blocks TS subclassing of LitElement.
  @state() private _scrollTop = 0;
  @state() private viewportHeight = 500;

  // Resizable column widths (Timestamp, Level, Tag, User Tag, Message).
  // Numbers are pixels for the first four; the last column flexes to fill
  // remaining space (1fr). Drag handles update these on pointermove.
  @state() private colWidths = { ts: 110, lvl: 60, tag: 220, utag: 120 };
  private dragging: { col: 'ts' | 'lvl' | 'tag' | 'utag'; startX: number; startW: number } | null = null;

  private resizeObserver?: ResizeObserver | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('scroll', this.onScroll);
    // Track the viewport height continuously — a one-shot read in
    // firstUpdated goes stale when the panel is resized, leaving the
    // virtualization window wrong (blank space or over-render).
    // ResizeObserver fires immediately on observe, covering the initial
    // measurement too.
    this.resizeObserver = new ResizeObserver(() => {
      const h = this.clientHeight;
      if (h > 0 && h !== this.viewportHeight) { this.viewportHeight = h; }
    });
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.removeEventListener('scroll', this.onScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    // A disconnect mid-drag (panel move/close) must not leave the window
    // listeners attached to a detached element.
    window.removeEventListener('pointermove', this.onResizeMove);
    window.removeEventListener('pointerup', this.onResizeEnd);
    this.dragging = null;
    if (this.rangeFrame !== null) {
      cancelAnimationFrame(this.rangeFrame);
      this.rangeFrame = null;
    }
    super.disconnectedCallback();
  }

  private onScroll = (): void => {
    this._scrollTop = (this as unknown as HTMLElement).scrollTop;
    this.reportVisibleRange();
  };

  /** Tell the owner which absolute rows are needed.
   *
   *  The table is virtualised to roughly a viewport's worth of rows, so the
   *  owner has no reason to hold — or the host to serialise — the whole result
   *  set. It fetches a window around whatever this reports.
   *
   *  Coalesced to one report per frame: a scroll gesture fires far more often
   *  than the window can usefully change. */
  private rangeFrame: number | null = null;
  private reportVisibleRange(): void {
    if (this.rangeFrame !== null) { return; }
    this.rangeFrame = requestAnimationFrame(() => {
      this.rangeFrame = null;
      const { startIdx, endIdx } = this.visibleRange();
      this.dispatchEvent(new CustomEvent('visible-range', {
        detail: { start: startIdx, end: endIdx },
        bubbles: true,
        composed: true,
      }));
    });
  }

  /** Absolute row indices the viewport needs, including overscan. */
  private visibleRange(): { startIdx: number; endIdx: number } {
    const startIdx = Math.max(0, Math.floor(this._scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(this.viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    return { startIdx, endIdx: Math.min(this.totalRows, startIdx + visibleCount) };
  }

  private clickRow(lineId: number): void {
    this.dispatchEvent(new CustomEvent('line-clicked', { detail: { lineId }, bubbles: true, composed: true }));
  }

  /** Drag-resize plumbing for the three sized columns. Listens on
   *  window (not the host) so the drag continues if the pointer slips
   *  outside the header strip. */
  private onResizeStart(col: 'ts' | 'lvl' | 'tag' | 'utag', e: PointerEvent): void {
    e.preventDefault();
    this.dragging = { col, startX: e.clientX, startW: this.colWidths[col] };
    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeEnd, { once: true });
  }

  private onResizeMove = (e: PointerEvent): void => {
    if (!this.dragging) { return; }
    const delta = e.clientX - this.dragging.startX;
    const next = Math.max(MIN_COLUMN_WIDTH, this.dragging.startW + delta);
    // Mutate via re-assignment so Lit detects the change and re-renders
    // the CSS custom property on :host, which both head and rows read.
    this.colWidths = { ...this.colWidths, [this.dragging.col]: next };
  };

  private onResizeEnd = (): void => {
    this.dragging = null;
    window.removeEventListener('pointermove', this.onResizeMove);
  };

  private renderHead(): TemplateResult {
    const draggingClass = (col: 'ts' | 'lvl' | 'tag' | 'utag'): string =>
      this.dragging?.col === col ? 'resize dragging' : 'resize';
    // The head reads the same --col-* custom properties as the rows;
    // they're set on :host by updated() and inherit through the shadow
    // tree, so no inline style is needed here.
    return html`
      <div class="head">
        <div class="cell">Timestamp
          <div class=${draggingClass('ts')}
               @pointerdown=${(e: PointerEvent) => this.onResizeStart('ts', e)}></div>
        </div>
        <div class="cell">Level
          <div class=${draggingClass('lvl')}
               @pointerdown=${(e: PointerEvent) => this.onResizeStart('lvl', e)}></div>
        </div>
        <div class="cell">Tag
          <div class=${draggingClass('tag')}
               @pointerdown=${(e: PointerEvent) => this.onResizeStart('tag', e)}></div>
        </div>
        <div class="cell">User Tag
          <div class=${draggingClass('utag')}
               @pointerdown=${(e: PointerEvent) => this.onResizeStart('utag', e)}></div>
        </div>
        <div class="cell">Message</div>
      </div>
    `;
  }

  /** Apply column widths as CSS custom properties on the host so both
   *  head + rows pick them up. Done in updated() (not render()) so render
   *  stays pure, and via setProperty rather than cssText so unrelated
   *  inline styles on the host are not clobbered. */
  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has('colWidths')) {
      const s = (this as unknown as HTMLElement).style;
      s.setProperty('--col-ts', `${this.colWidths.ts}px`);
      s.setProperty('--col-lvl', `${this.colWidths.lvl}px`);
      s.setProperty('--col-tag', `${this.colWidths.tag}px`);
      s.setProperty('--col-utag', `${this.colWidths.utag}px`);
    }
  }

  override render(): TemplateResult {
    if (this.totalRows === 0) {
      return html`
        ${this.renderHead()}
        <div class="empty">No lines match the current filter.</div>
      `;
    }
    // The scroll area is sized to the whole filtered result set, but only the
    // loaded window can be painted. Rows outside it render as blanks for the
    // frame or two before the owner's fetch lands.
    const { startIdx, endIdx } = this.visibleRange();
    const from = Math.max(startIdx, this.windowOffset);
    const to = Math.min(endIdx, this.windowOffset + this.lines.length);
    const visible = to > from ? this.lines.slice(from - this.windowOffset, to - this.windowOffset) : [];

    return html`
      ${this.renderHead()}
      <div class="spacer" style="height: ${this.totalRows * ROW_HEIGHT}px;">
        ${visible.map((l, i) => {
          const idx = from + i;
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
              <span class="utag">${l.userTags?.join(', ') ?? ''}</span>
              <span class="msg">${l.text}</span>
            </div>
          `;
        })}
      </div>
    `;
  }
}
