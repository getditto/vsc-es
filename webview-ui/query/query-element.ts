import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';
import '../shared/json-viewer.js';

type QueryMode = 'local' | 'http';

type In =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number; metadata?: unknown }
  | { type: 'query.error'; message: string }
  | { type: 'query.setText'; text: string }
  | { type: 'query.modeInit'; availableModes: QueryMode[] };

type View = 'table' | 'json';
type RunState = 'idle' | 'running' | 'success' | 'error';

const TRUNCATE_AT = 120;

function renderCell(value: unknown): { display: string; full: string; nullish: boolean } {
  if (value === null) { return { display: 'null', full: 'null', nullish: true }; }
  if (value === undefined) { return { display: 'undefined', full: 'undefined', nullish: true }; }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return {
      display: json.length > TRUNCATE_AT ? json.slice(0, TRUNCATE_AT) + '…' : json,
      full: json,
      nullish: false,
    };
  }
  const s = String(value);
  return {
    display: s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT) + '…' : s,
    full: s,
    nullish: false,
  };
}

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
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      vertical-align: top;
    }
    th {
      background: var(--vscode-editorWidget-background);
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      font-size: 11px;
      position: sticky;
      top: 0;
    }
    td {
      font-family: var(--vscode-editor-font-family);
      max-width: 480px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    td.nullish {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    tbody tr { cursor: pointer; }
    tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tbody tr.selected td.nullish {
      color: var(--vscode-list-activeSelectionForeground);
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

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'query.result') {
        this.rows = msg.rows;
        this.columns = msg.columns;
        this.durationMs = msg.durationMs;
        this.errorMessage = null;
        this.state = 'success';
        this.selectedRowIndex = null;
      } else if (msg.type === 'query.error') {
        this.errorMessage = msg.message;
        this.rows = [];
        this.columns = [];
        this.state = 'error';
        this.selectedRowIndex = null;
      } else if (msg.type === 'query.setText') {
        this.query = msg.text;
        // Sync the host immediately so the tab title matches the loaded query
        // (no debounce needed — this is a deliberate user action).
        postToHost({ type: 'query.textChanged', text: this.query });
      } else if (msg.type === 'query.modeInit') {
        this.availableModes = msg.availableModes.length > 0 ? msg.availableModes : ['local'];
        // Pin the current selection to a still-valid mode (e.g. host
        // re-pushes after a config change that removed HTTP creds).
        if (!this.availableModes.includes(this.mode)) {
          this.mode = this.availableModes[0];
        }
      }
    });
  }

  private run() {
    if (!this.query.trim() || this.state === 'running') { return; }
    this.state = 'running';
    this.errorMessage = null;
    this.selectedRowIndex = null;
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

  private setSelected(i: number) {
    this.selectedRowIndex = i;
    const row = this.rows[i];
    postToHost({
      type: 'query.rowSelected',
      rowJson: row !== undefined ? JSON.stringify(row) : null,
    });
  }

  /** Stronger gesture than setSelected — fires on double-click and
   *  asks the host to flip the Inspector to its JSON tab so the
   *  activated row gets pulled into focus. The single-click that
   *  precedes a dblclick already updated `selectedRowIndex`, so we
   *  read straight from state. */
  private activateSelected() {
    if (this.selectedRowIndex === null) { return; }
    const row = this.rows[this.selectedRowIndex];
    if (row === undefined) { return; }
    postToHost({ type: 'query.rowActivated', rowJson: JSON.stringify(row) });
  }

  private starCurrent() {
    if (!this.query.trim()) { return; }
    postToHost({ type: 'query.starCurrent', query: this.query });
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
          </div>
        </div>
      ` : nothing}

      <div class="results-body">
        ${this.state === 'idle' ? html`<div class="empty">Run a query to see results.</div>` : nothing}
        ${(this.state === 'success' || this.state === 'running') && this.view === 'table' ? this.renderTable() : nothing}
        ${(this.state === 'success' || this.state === 'running') && this.view === 'json' ? this.renderJson() : nothing}
      </div>
    `;
  }

  private renderTable() {
    if (this.rows.length === 0) {
      return html`<div class="empty">Query returned no rows.</div>`;
    }
    return html`
      <table>
        <thead>
          <tr>
            ${this.columns.map(c => html`<th scope="col">${c}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${this.rows.map((row, i) => {
            const isSelected = this.selectedRowIndex === i;
            return html`
              <tr
                class=${isSelected ? 'selected' : ''}
                aria-selected=${isSelected ? 'true' : 'false'}
                @click=${() => this.setSelected(i)}
                @dblclick=${() => this.activateSelected()}
              >
                ${this.columns.map(c => {
                  const cell = renderCell(row[c]);
                  return html`<td class=${cell.nullish ? 'nullish' : ''} title=${cell.full}>${cell.display}</td>`;
                })}
              </tr>
            `;
          })}
        </tbody>
      </table>
    `;
  }

  /** Stringifies rows as a JSON array AND records the [from,to] character
   *  range of each top-level item, so the embedded <json-viewer> can map a
   *  click position back to a row index. */
  private buildJsonDoc(): { doc: string; ranges: { from: number; to: number }[] } {
    if (this.rows.length === 0) { return { doc: '[]', ranges: [] }; }
    const ranges: { from: number; to: number }[] = [];
    let doc = '[\n';
    for (let i = 0; i < this.rows.length; i++) {
      const itemStr = JSON.stringify(this.rows[i], null, 2)
        .split('\n').map(l => '  ' + l).join('\n');
      const from = doc.length;
      doc += itemStr;
      const to = doc.length;
      ranges.push({ from, to });
      doc += i < this.rows.length - 1 ? ',\n' : '\n';
    }
    doc += ']';
    return { doc, ranges };
  }

  private renderJson() {
    const { doc, ranges } = this.buildJsonDoc();
    return html`<json-viewer
      .value=${doc}
      .ranges=${ranges}
      .selectedIndex=${this.selectedRowIndex ?? -1}
      wrap
      @documentSelected=${(e: CustomEvent<{ index: number }>) => this.setSelected(e.detail.index)}
      @dblclick=${() => this.activateSelected()}
      style="display:block; height: 100%;"
    ></json-viewer>`;
  }
}
