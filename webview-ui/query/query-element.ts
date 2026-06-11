import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';
import { assertNever } from '../shared/assert-never.js';
import '../shared/json-viewer.js';
import '../shared/result-table-element.js';
import type { QueryProfile } from '../../src/ditto/QueryProfile.js';
import type { QueryOut, QueryMode } from '../../src/ipc/messages.js';
// Note: <ditto-profile-viewer> is registered by webview-ui/query/main.ts's
// side-import, not here — keeping component registration in one place
// (the entrypoint) avoids accidental double-imports.

type View = 'table' | 'json' | 'profile';
type RunState = 'idle' | 'running' | 'success' | 'error';

@customElement('ditto-query-editor')
export class QueryEditor extends LitElement {
  @state() private query = '';
  @state() private state: RunState = 'idle';
  @state() private rows: Record<string, unknown>[] = [];
  @state() private columns: string[] = [];
  @state() private durationMs = 0;
  @state() private errorMessage: string | null = null;
  @state() private view: View = 'json';
  @state() private selectedRowIndex: number | null = null;
  // Modes the host has told us the connection supports. Default to
  // ['local'] until the host's modeInit message arrives so the dropdown
  // doesn't flicker through an empty state.
  @state() private availableModes: QueryMode[] = ['local'];
  @state() private mode: QueryMode = 'local';
  // Pagination — slicing happens entirely in the webview so a 21k-row
  // result doesn't blow up the table renderer or the JSON tokenizer.
  // Page sizes scale with the result count (mirrors SwiftUI's
  // QueryResultsView). 1000 is the cap — larger pages defeat the
  // point of paginating.
  @state() private currentPage = 1;
  @state() private pageSize = 100;
  // Right-click context menu (host VS Code's TreeView context menu API
  // doesn't reach inside webviews; we render our own popover and route
  // selections through IPC). `null` means hidden.
  @state() private contextMenu: { x: number; y: number; rowAbsIndex: number } | null = null;
  // Export-in-progress flag — keeps the button disabled and the label
  // showing "Exporting…" between the click and the host's
  // `query.exportDone`/`exportCancelled`/`exportError` response.
  @state() private isExporting = false;
  // Profile envelope from the last `query.result` (null when the host
  // didn't include one, e.g. non-SELECT or profiling disabled).
  @state() private profile: QueryProfile | null = null;
  // Snapshot of the query text at the moment `run()` was invoked.
  // The Profile viewer's empty-state branches use this to show the
  // statement that was actually executed (which may differ from the
  // current editor contents if the user has since typed more).
  @state() private lastQueryRun = '';
  // Workspace settings pushed by the host. `collectProfiling` gates
  // the Profile toggle button; `collectMetrics` is forwarded to the
  // host on every Run (it doesn't directly affect this webview's UI
  // — the Inspector handles its own Metrics tab gating). Defaults
  // optimistic so the toggle is offered until the host's first push
  // lands (the actual setting still applies to query.run-time
  // behavior via the host's fresh read).
  @state() private settings = { collectProfiling: true, collectMetrics: true };
  // Cog popover open/closed state. Anchored to the cog button; clicks
  // outside the popover close it (handled at document level).
  @state() private settingsMenuOpen = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      padding: 16px;
      gap: 12px;
      box-sizing: border-box;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .editor-pane {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 120px;
      padding: 8px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      resize: vertical;
    }
    .top-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 4px;
    }
    .top-toolbar .spacer { flex: 1; }
    .top-toolbar select {
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font: inherit;
    }
    .top-toolbar .mode-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    button.run {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      font: inherit;
      cursor: pointer;
    }
    button.run[disabled] { opacity: 0.5; cursor: not-allowed; }
    button.star {
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      font: inherit;
      cursor: pointer;
    }
    button.star[disabled] { opacity: 0.5; cursor: not-allowed; }

    /* Cog button + popover for the profiling/metrics gate menu.
     * The button sits in the toolbar after Favorite. The popover is
     * anchored below the button via a wrapper with position: relative. */
    .settings-wrap { position: relative; display: inline-block; }
    button.settings-cog {
      /* Match Favorite's overall button height (padding 6px 12px around
       * the 13px "★ Favorite" text → ~28px tall) while showing a single
       * larger glyph. The lower vertical padding + larger font-size +
       * pinned line-height keep the height aligned without adding a
       * text label. */
      padding: 3px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      font: inherit;
      font-size: 18px;
      line-height: 1.2;
      cursor: pointer;
    }
    button.settings-cog.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .settings-popover {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 1000;
      min-width: 240px;
      padding: 10px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
    }
    .settings-popover .row {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .settings-popover .row input[type="checkbox"] {
      cursor: pointer;
      accent-color: var(--vscode-button-background);
    }
    .settings-popover .row .label { flex: 1; color: var(--vscode-foreground); }
    .settings-popover .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding-top: 4px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .results-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .results-meta {
      flex: 1;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .running-indicator {
      color: var(--vscode-charts-orange);
      font-style: italic;
    }
    .view-toggle {
      display: flex;
      gap: 2px;
    }
    .view-toggle button {
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .view-toggle button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .results-body {
      flex: 1;
      overflow: auto;
      min-height: 0;
    }
    .empty {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    pre.json {
      margin: 0;
      padding: 8px;
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* ─── Context menu (right-click on a result row) ─────────
       Webviews can't tap into VS Code's native context-menu APIs, so
       we render our own. Looks/behaves like VS Code's editor right-click. */
    .ctx-menu {
      position: fixed;
      z-index: 1000;
      min-width: 200px;
      padding: 4px 0;
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      font-size: 13px;
      font-family: var(--vscode-font-family);
    }
    .ctx-menu-item {
      padding: 4px 16px;
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }
    .ctx-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }
    .ctx-menu-sep {
      height: 1px;
      margin: 4px 0;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }

    .pagination {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .pagination .spacer { flex: 1; }
    .pagination-total {
      font-family: var(--vscode-editor-font-family);
    }
    .pagination-size {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .pagination select {
      padding: 3px 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font: inherit;
    }
    .pagination button.page-nav {
      padding: 2px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    .pagination button.page-nav[disabled] { opacity: 0.4; cursor: not-allowed; }
    .pagination-pos {
      min-width: 80px;
      text-align: center;
      font-family: var(--vscode-editor-font-family);
    }
    /* Export button shares the pagination footer with the page controls
       so it lives near the row-count it acts on. Styled like the
       primary "Run" button (button-background) to call attention to it
       — exports are an explicit user action, not a navigation. */
    .pagination button.export-btn {
      padding: 2px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .pagination button.export-btn[disabled] { opacity: 0.5; cursor: not-allowed; }

    .error-banner {
      padding: 12px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 2px;
      font-size: 13px;
    }
    .error-banner pre {
      margin: 8px 0 0 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
    }
  `;

  /** Page sizes available given the current result count. Show every
   *  size up to and including the first one that fits the entire
   *  result set — so 30 rows offers `[10, 25, 50]` (50 fits all),
   *  150 offers `[10, 25, 50, 100, 200]`, 21k offers all sizes.
   *  Mirrors SwiftUI's QueryResultsView.pageSizes pattern. */
  private get pageSizes(): number[] {
    const n = this.rows.length;
    const all = [10, 25, 50, 100, 200, 250, 1000];
    if (n <= 10) { return [10]; }
    const out: number[] = [];
    for (const s of all) {
      out.push(s);
      if (s >= n) { break; }
    }
    return out;
  }

  /** Total page count for current pageSize. At least 1 — empty results
   *  still show "1 of 1" rather than "1 of 0". */
  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.rows.length / this.pageSize));
  }

  /** Zero-based offset into `rows` for the current page. Used to map
   *  page-local row indices back to the full array (selection events,
   *  rowJson payloads). */
  private get pageOffset(): number {
    return (this.currentPage - 1) * this.pageSize;
  }

  /** Rows for the current page. The table render and JSON doc both
   *  consume this — never the full `rows` array — so a 21k-row query
   *  still tokenizes only `pageSize` rows of JSON. */
  private get pagedRows(): Record<string, unknown>[] {
    return this.rows.slice(this.pageOffset, this.pageOffset + this.pageSize);
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Click-away closes the context menu — register at the document
    // level so a click anywhere outside the menu (including outside
    // this element) dismisses it. capture:false so the menu's own
    // stopPropagation handler can short-circuit. Listeners are
    // removed in disconnectedCallback to avoid leaks across reloads.
    document.addEventListener('click', this.closeContextMenu);
    document.addEventListener('contextmenu', this.closeContextMenu);
    // Same click-away pattern for the settings cog popover.
    document.addEventListener('click', this.onDocumentClick);
    onHostMessage<QueryOut>(msg => {
      switch (msg.type) {
        case 'query.result':
          this.rows = msg.rows;
          this.columns = msg.columns;
          this.durationMs = msg.durationMs;
          this.profile = msg.metadata.profile ?? null;
          this.errorMessage = null;
          this.state = 'success';
          this.selectedRowIndex = null;
          // New result → snap pagination to page 1, and clamp pageSize
          // to a value that's valid for this size.
          this.currentPage = 1;
          {
            const sizes = this.pageSizes;
            if (!sizes.includes(this.pageSize)) { this.pageSize = sizes[0]; }
          }
          break;
        case 'query.error':
          this.errorMessage = msg.message;
          this.rows = [];
          this.columns = [];
          this.state = 'error';
          this.selectedRowIndex = null;
          break;
        case 'query.setText':
          this.query = msg.text;
          // Sync the host immediately so the tab title matches the loaded query
          // (no debounce needed — this is a deliberate user action).
          postToHost({ type: 'query.textChanged', text: this.query });
          break;
        case 'query.modeInit':
          this.availableModes = msg.availableModes.length > 0 ? msg.availableModes : ['local'];
          // Pin the current selection to a still-valid mode (e.g. host
          // re-pushes after a config change that removed HTTP creds).
          if (!this.availableModes.includes(this.mode)) {
            this.mode = this.availableModes[0];
          }
          break;
        case 'query.settings':
          this.settings = {
            collectProfiling: !!msg.collectProfiling,
            collectMetrics: !!msg.collectMetrics,
          };
          // If profiling just turned off while the user was on the
          // Profile view, fall back to JSON so they're not stuck on a
          // toggle button that's about to disappear.
          if (!this.settings.collectProfiling && this.view === 'profile') {
            this.view = 'json';
          }
          break;
        case 'query.exportDone':
        case 'query.exportCancelled':
        case 'query.exportError':
          // Three flavours of "export over" — clear the busy flag in all
          // three. The success/error toasts are owned by the host so the
          // webview doesn't render its own banner.
          this.isExporting = false;
          break;
        default:
          // Compile-time exhaustiveness check — if QueryOut grows a
          // new variant and we forget to handle it here, the
          // assertNever call will fail typechecking.
          assertNever(msg);
      }
    });
  }

  disconnectedCallback(): void {
    document.removeEventListener('click', this.closeContextMenu);
    document.removeEventListener('contextmenu', this.closeContextMenu);
    document.removeEventListener('click', this.onDocumentClick);
    super.disconnectedCallback();
  }

  private run() {
    if (!this.query.trim() || this.state === 'running') { return; }
    this.state = 'running';
    this.errorMessage = null;
    this.selectedRowIndex = null;
    this.lastQueryRun = this.query;
    postToHost({ type: 'query.run', query: this.query, mode: this.mode });
  }

  private titleDebounceHandle: number | undefined;

  /** Updates local query state and notifies the host (debounced) so the
   *  editor tab title can mirror the current query text. */
  private onQueryInput(value: string) {
    this.query = value;
    if (this.titleDebounceHandle !== undefined) {
      window.clearTimeout(this.titleDebounceHandle);
    }
    this.titleDebounceHandle = window.setTimeout(() => {
      this.titleDebounceHandle = undefined;
      postToHost({ type: 'query.textChanged', text: this.query });
    }, 200);
  }

  /** Convert a page-local index (the i-th row visible on the current
   *  page) to the absolute index into `rows`. Selection state is stored
   *  in absolute terms so it survives a page change cleanly. */
  private absoluteIndex(pageLocalIndex: number): number {
    return this.pageOffset + pageLocalIndex;
  }

  private setSelected(pageLocalIndex: number) {
    const abs = this.absoluteIndex(pageLocalIndex);
    this.selectedRowIndex = abs;
    const row = this.rows[abs];
    postToHost({
      type: 'query.rowSelected',
      rowJson: row !== undefined ? JSON.stringify(row) : null,
    });
  }

  /** Stronger gesture than setSelected — fires on double-click and
   *  asks the host to flip the Inspector to its JSON tab so the
   *  activated row gets pulled into focus. The single-click that
   *  precedes a dblclick already updated `selectedRowIndex` (absolute),
   *  so we read straight from state. */
  private activateSelected() {
    if (this.selectedRowIndex === null) { return; }
    const row = this.rows[this.selectedRowIndex];
    if (row === undefined) { return; }
    postToHost({ type: 'query.rowActivated', rowJson: JSON.stringify(row) });
  }

  // ─── Context menu helpers ─────────────────────────────────────
  /** Open the context menu at the cursor position for a specific row. */
  private openContextMenu(e: MouseEvent, rowAbsIndex: number) {
    e.preventDefault();
    // stopPropagation so the document-level contextmenu listener that
    // closes the menu doesn't immediately fire on the same event we're
    // using to open it.
    e.stopPropagation();
    // Mark the row as selected too so the user has visual feedback that
    // the menu's actions will target this row. Matches VS Code's editor
    // right-click behaviour.
    this.selectedRowIndex = rowAbsIndex;
    const row = this.rows[rowAbsIndex];
    postToHost({
      type: 'query.rowSelected',
      rowJson: row !== undefined ? JSON.stringify(row) : null,
    });
    this.contextMenu = { x: e.clientX, y: e.clientY, rowAbsIndex };
  }

  private closeContextMenu = () => { this.contextMenu = null; };

  private contextAdd = () => {
    if (!this.contextMenu) { return; }
    const row = this.rows[this.contextMenu.rowAbsIndex];
    this.contextMenu = null;
    if (!row) { return; }
    postToHost({ type: 'query.addAttachment', rowJson: JSON.stringify(row) });
  };

  private contextDelete = () => {
    if (!this.contextMenu) { return; }
    const row = this.rows[this.contextMenu.rowAbsIndex];
    this.contextMenu = null;
    if (!row) { return; }
    postToHost({ type: 'query.deleteAttachment', rowJson: JSON.stringify(row) });
  };

  /** Right-click on the JSON viewer doesn't carry a row index — derive
   *  one from the doc's character offset against the page-local ranges
   *  and translate to absolute. Falls back to the currently-selected
   *  row if the click landed outside any document. */
  private onJsonContextMenu = (e: MouseEvent) => {
    // The json-viewer fires `documentSelected` on click; by the time
    // contextmenu fires, selectedRowIndex is already on the row the
    // user just clicked. Use that if available; otherwise no-op.
    if (this.selectedRowIndex === null) { return; }
    this.openContextMenu(e, this.selectedRowIndex);
  };

  // ─── Pagination helpers ───────────────────────────────────────
  private gotoPage(p: number) {
    const clamped = Math.max(1, Math.min(p, this.pageCount));
    if (clamped === this.currentPage) { return; }
    this.currentPage = clamped;
    // Selection is stored in absolute terms — on page change we just
    // drop it visually since the row may not be on the new page.
    this.selectedRowIndex = null;
    postToHost({ type: 'query.rowSelected', rowJson: null });
  }

  private setPageSize(size: number) {
    if (size === this.pageSize) { return; }
    // Try to keep the user roughly where they were after a size change
    // (anchor on the first row of the current page, then re-derive page).
    const firstAbs = this.pageOffset;
    this.pageSize = size;
    this.currentPage = Math.max(1, Math.floor(firstAbs / size) + 1);
    this.selectedRowIndex = null;
    postToHost({ type: 'query.rowSelected', rowJson: null });
  }

  private starCurrent() {
    if (!this.query.trim()) { return; }
    postToHost({ type: 'query.starCurrent', query: this.query });
  }

  /** Render the cog button + (when open) the popover with the two
   *  toggles. Clicking the cog opens; clicking outside the popover
   *  closes (handled by the document-level listener below). */
  private renderSettingsCog() {
    return html`
      <span class="settings-wrap">
        <button
          class=${'settings-cog' + (this.settingsMenuOpen ? ' active' : '')}
          title="Profiling and metrics settings"
          aria-label="Profiling and metrics settings"
          aria-expanded=${this.settingsMenuOpen ? 'true' : 'false'}
          @click=${(e: MouseEvent) => {
            e.stopPropagation();
            this.settingsMenuOpen = !this.settingsMenuOpen;
          }}
        >⚙</button>
        ${this.settingsMenuOpen ? html`
          <div class="settings-popover" @click=${(e: Event) => e.stopPropagation()}>
            <label class="row">
              <input
                type="checkbox"
                .checked=${this.settings.collectProfiling}
                @change=${(e: Event) => this.toggleSetting('collectProfiling', (e.target as HTMLInputElement).checked)}
              />
              <span class="label">Capture profiling data</span>
            </label>
            <label class="row">
              <input
                type="checkbox"
                .checked=${this.settings.collectMetrics}
                @change=${(e: Event) => this.toggleSetting('collectMetrics', (e.target as HTMLInputElement).checked)}
              />
              <span class="label">Capture query metrics</span>
            </label>
            <div class="hint">
              Off-toggles hide the matching tabs and skip the per-query
              SDK overhead. Changes are saved to your user settings.
            </div>
          </div>
        ` : nothing}
      </span>
    `;
  }

  private toggleSetting(key: 'collectProfiling' | 'collectMetrics', value: boolean) {
    // Optimistically update local state so the checkbox reflects
    // immediately; the host echoes back a `query.settings` after the
    // config write completes which will overwrite (and reconcile if
    // the write somehow failed).
    this.settings = { ...this.settings, [key]: value };
    postToHost({ type: 'query.setSetting', key, value });
  }

  /** Close the cog popover when the user clicks outside it. Hooked at
   *  the document level so any click in the webview body works. */
  private readonly onDocumentClick = (e: MouseEvent): void => {
    if (!this.settingsMenuOpen) { return; }
    const path = e.composedPath();
    // Walk the event path; if it includes one of our own settings nodes,
    // ignore (those handlers already e.stopPropagation()'d, but defend
    // against bubbling weirdness across shadow boundaries).
    const fromUs = path.some(t => {
      if (!(t instanceof Element)) { return false; }
      return t.classList?.contains('settings-popover')
          || t.classList?.contains('settings-cog');
    });
    if (!fromUs) { this.settingsMenuOpen = false; }
  };

  /**
   * Serialise the ENTIRE in-memory result set (not just `pagedRows`) as
   * a JSON array and ship it to the host. We pretty-print with 2-space
   * indent so the resulting file is human-readable and survives a
   * round-trip through the Import Data feature (which only requires a
   * valid JSON array of objects with `_id` — pretty-printed is fine).
   *
   * Serialisation runs on the webview thread because `this.rows` lives
   * here and shipping the full array across postMessage would cost an
   * extra structured-clone hop. A 21k-row JSON.stringify can take
   * 100-300 ms on commodity hardware — we set `isExporting = true`
   * BEFORE stringify so the button repaints disabled first, then yield
   * via a microtask so the repaint actually lands before we block.
   */
  private async exportRows(): Promise<void> {
    if (this.isExporting || this.rows.length === 0) { return; }
    this.isExporting = true;
    // Microtask yield so the disabled-button repaint commits before the
    // synchronous JSON.stringify steals the main thread.
    await Promise.resolve();
    let json: string;
    try {
      json = JSON.stringify(this.rows, null, 2);
    } catch (err) {
      // JSON.stringify only throws on cyclic refs — extremely unlikely
      // for SDK rows but we don't want a freak result to wedge the
      // button in "Exporting…" forever.
      this.isExporting = false;
      // Surface to the user via the same error banner the query error
      // path uses, so they at least see *something*.
      this.errorMessage = `Could not serialise results for export: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    postToHost({ type: 'query.exportRows', json, rowCount: this.rows.length });
  }

  private handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      this.run();
    } else if (e.key === 'Escape') {
      this.errorMessage = null;
    }
  }

  render() {
    const showModePicker = this.availableModes.length > 1;
    return html`
      <div class="editor-pane">
        <div class="top-toolbar">
          ${showModePicker ? html`
            <span class="mode-label">Run on</span>
            <select
              .value=${this.mode}
              @change=${(e: Event) => this.mode = (e.target as HTMLSelectElement).value as QueryMode}
              title="Where the query runs"
            >
              ${this.availableModes.map(m => html`
                <option value=${m} ?selected=${m === this.mode}>${m === 'local' ? 'Local' : 'HTTP'}</option>
              `)}
            </select>
          ` : nothing}
          <button class="run" ?disabled=${!this.query.trim() || this.state === 'running'} @click=${this.run}>
            ${this.state === 'running' ? 'Running…' : '▶ Run'}
          </button>
          <span class="spacer"></span>
          <button class="star" ?disabled=${!this.query.trim()} title="Save current query to favorites" @click=${this.starCurrent}>
            ★ Favorite
          </button>
          ${this.renderSettingsCog()}
        </div>
        <textarea
          .value=${this.query}
          placeholder="Type a DQL query, e.g. SELECT * FROM __small_peer_info"
          @input=${(e: Event) => this.onQueryInput((e.target as HTMLTextAreaElement).value)}
          @keydown=${this.handleKeydown}
        ></textarea>
      </div>

      ${this.errorMessage ? html`
        <div class="error-banner">
          <strong>Query failed</strong>
          <pre>${this.errorMessage}</pre>
        </div>
      ` : nothing}

      ${this.state === 'success' || this.state === 'running' ? html`
        <div class="results-header">
          <div class="results-meta">
            ${this.state === 'running'
              ? html`<span class="running-indicator">Running…</span>`
              : html`${this.rows.length} ${this.rows.length === 1 ? 'row' : 'rows'} · ${this.durationMs} ms`}
          </div>
          <div class="view-toggle">
            <button class=${this.view === 'json' ? 'active' : ''} @click=${() => this.view = 'json'}>JSON</button>
            <button class=${this.view === 'table' ? 'active' : ''} @click=${() => this.view = 'table'}>Table</button>
            ${this.settings.collectProfiling ? html`
              <button class=${this.view === 'profile' ? 'active' : ''} @click=${() => this.view = 'profile'}>Profile</button>
            ` : nothing}
          </div>
        </div>
      ` : nothing}

      <div class="results-body">
        ${this.state === 'idle' ? html`<div class="empty">Run a query to see results.</div>` : nothing}
        ${(this.state === 'success' || this.state === 'running') && this.view === 'table' ? this.renderTable() : nothing}
        ${(this.state === 'success' || this.state === 'running') && this.view === 'json' ? this.renderJson() : nothing}
        ${(this.state === 'success' || this.state === 'running') && this.view === 'profile' ? html`
          <ditto-profile-viewer
            .profile=${this.profile ?? undefined}
            .mode=${this.mode}
            .lastQueryText=${this.lastQueryRun}
          ></ditto-profile-viewer>
        ` : nothing}
      </div>
      ${this.renderPagination()}
      ${this.renderContextMenu()}
    `;
  }

  private renderTable() {
    if (this.rows.length === 0) {
      return html`<div class="empty">Query returned no rows.</div>`;
    }
    // The shared <ditto-result-table> emits absolute indices in its
    // event details (computed as pageOffset + page-local index), so
    // we translate back to page-local when calling setSelected (which
    // expects page-local) and pass absIndex straight through to
    // openContextMenu (which expects absolute).
    return html`<ditto-result-table
      .rows=${this.pagedRows}
      .columns=${this.columns}
      .selectedRowIndex=${this.selectedRowIndex}
      .pageOffset=${this.pageOffset}
      @row-selected=${(e: CustomEvent<{ absIndex: number }>) => this.setSelected(e.detail.absIndex - this.pageOffset)}
      @row-activated=${() => this.activateSelected()}
      @row-context-menu=${(e: CustomEvent<{ absIndex: number; event: MouseEvent }>) => this.openContextMenu(e.detail.event, e.detail.absIndex)}
    ></ditto-result-table>`;
  }

  /** Stringifies the CURRENT PAGE's rows (not the full result set) so
   *  CodeMirror only tokenizes pageSize rows of JSON. The `ranges` are
   *  page-local — `setSelected` translates to absolute on click. */
  private buildJsonDoc(): { doc: string; ranges: { from: number; to: number }[] } {
    const paged = this.pagedRows;
    if (paged.length === 0) { return { doc: '[]', ranges: [] }; }
    const ranges: { from: number; to: number }[] = [];
    let doc = '[\n';
    for (let i = 0; i < paged.length; i++) {
      const itemStr = JSON.stringify(paged[i], null, 2)
        .split('\n').map(l => '  ' + l).join('\n');
      const from = doc.length;
      doc += itemStr;
      const to = doc.length;
      ranges.push({ from, to });
      doc += i < paged.length - 1 ? ',\n' : '\n';
    }
    doc += ']';
    return { doc, ranges };
  }

  private renderJson() {
    const { doc, ranges } = this.buildJsonDoc();
    // selectedIndex passed to json-viewer is page-local: subtract the
    // page offset to translate the absolute selection back to the
    // current page's frame, or -1 if the selection isn't on this page.
    const pageLocalSelection =
      this.selectedRowIndex !== null
      && this.selectedRowIndex >= this.pageOffset
      && this.selectedRowIndex < this.pageOffset + this.pageSize
        ? this.selectedRowIndex - this.pageOffset
        : -1;
    return html`<json-viewer
      .value=${doc}
      .ranges=${ranges}
      .selectedIndex=${pageLocalSelection}
      wrap
      @documentSelected=${(e: CustomEvent<{ index: number }>) => this.setSelected(e.detail.index)}
      @dblclick=${() => this.activateSelected()}
      @contextmenu=${this.onJsonContextMenu}
      style="display:block; height: 100%;"
    ></json-viewer>`;
  }

  /** Floating right-click menu. Click anywhere else closes it. */
  private renderContextMenu() {
    if (!this.contextMenu) { return nothing; }
    return html`
      <div
        class="ctx-menu"
        style=${`left:${this.contextMenu.x}px; top:${this.contextMenu.y}px;`}
        @click=${(e: Event) => e.stopPropagation()}
      >
        <div class="ctx-menu-item" @click=${this.contextAdd}>Add Attachment…</div>
        <div class="ctx-menu-sep"></div>
        <div class="ctx-menu-item" @click=${this.contextDelete}>Delete Attachment…</div>
      </div>
    `;
  }

  /** Pagination footer — total count, page-size picker, prev/next,
   *  "X of Y". Mirrors SwiftUI's PaginationControls. Sits below the
   *  results so the top toolbar (Run / Mode / Favorite) stays uncrowded. */
  private renderPagination() {
    if (this.state !== 'success' || this.rows.length === 0) { return nothing; }
    const sizes = this.pageSizes;
    return html`
      <div class="pagination">
        <span class="pagination-total" title="Total rows">${this.rows.length} total</span>
        <span class="spacer"></span>
        <label class="pagination-size">
          Page size
          <select
            .value=${String(this.pageSize)}
            @change=${(e: Event) => this.setPageSize(Number((e.target as HTMLSelectElement).value))}
          >
            ${sizes.map(s => html`<option value=${String(s)} ?selected=${s === this.pageSize}>${s}</option>`)}
          </select>
        </label>
        <button
          class="page-nav"
          ?disabled=${this.currentPage <= 1}
          @click=${() => this.gotoPage(this.currentPage - 1)}
          title="Previous page"
        >‹</button>
        <span class="pagination-pos">${this.currentPage} of ${this.pageCount}</span>
        <button
          class="page-nav"
          ?disabled=${this.currentPage >= this.pageCount}
          @click=${() => this.gotoPage(this.currentPage + 1)}
          title="Next page"
        >›</button>
        <button
          class="export-btn"
          ?disabled=${this.isExporting || this.rows.length === 0}
          @click=${this.exportRows}
          title="Export all ${this.rows.length.toLocaleString()} rows to a JSON file (compatible with the Import Data feature)"
        >
          ${this.isExporting ? 'Exporting…' : '⤓ Export'}
        </button>
      </div>
    `;
  }
}
