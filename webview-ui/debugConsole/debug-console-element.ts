// webview-ui/debugConsole/debug-console-element.ts
//
// Debug Console UI — attach to a running app's Ditto 5.1 `debug_socket` and
// run DQL against it live. The wire shapes below mirror the "Debug console"
// block in src/ipc/messages.ts (kept in sync by hand, like the other panels).
//
// The live-mutation warning banner is ALWAYS rendered: full DQL (mutations,
// ALTER SYSTEM) is enabled over the debug socket by default and statements
// execute against the app's store the moment they are sent — this is not a
// sandbox. Do not weaken this to a dismissable tip.

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

interface ConsoleRun {
  statement: string;
  ok: boolean;
  error?: string;
  rows?: unknown[];
  totalRowCount: number;
  truncated: boolean;
  durationMs: number;
}

type In =
  | {
      type: 'debugConsole.state';
      state: ConnectionState;
      path?: string;
      error?: string;
      pathWarning?: string;
    }
  | { type: 'debugConsole.runResult'; run: ConsoleRun };

/** Newest-first run history. Session-only (v1): nothing is persisted, and
 *  closed panels lose it. Bounded so a long session cannot grow the DOM
 *  without limit. */
const MAX_HISTORY = 50;

/** Object-valued cells render as compact JSON truncated to this length. */
const CELL_PREVIEW_CHARS = 120;

function isPlainRow(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

@customElement('ditto-debug-console')
export class DebugConsoleElement extends LitElement {
  @state() private conn: {
    state: ConnectionState;
    path?: string | undefined;
    error?: string | undefined;
    pathWarning?: string | undefined;
  } = { state: 'disconnected' };

  @state() private socketPath = '';
  @state() private statement = '';
  @state() private runs: ConsoleRun[] = [];
  @state() private running = false;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      height: 100vh;
      box-sizing: border-box;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .header {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }
    .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .header .sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .warning-banner {
      padding: 8px 12px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 12px;
      line-height: 1.5;
    }

    .connect-bar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .connect-bar input {
      flex: 1;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
    }
    .path-warning {
      padding: 6px 12px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 12px;
    }
    .pill {
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill.disconnected {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .pill.connecting {
      background: var(--vscode-progressBar-background, var(--vscode-panel-border));
      color: var(--vscode-foreground);
    }
    .pill.connected {
      background: var(--vscode-testing-iconPassed, #73c991);
      color: var(--vscode-editor-background, #1e1e1e);
    }

    .editor {
      display: flex;
      gap: 8px;
      align-items: stretch;
    }
    .editor textarea {
      flex: 1;
      resize: vertical;
      min-height: 2.2em;
      max-height: 8em;
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
    }
    button {
      padding: 4px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, var(--vscode-panel-border));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }

    .history {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .run {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editorWidget-background);
      padding: 8px 12px;
    }
    .run .statement {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .run .meta {
      margin-top: 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .run .error {
      margin-top: 6px;
      padding: 8px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
      font-size: 12px;
      white-space: pre-wrap;
    }
    .truncate-note {
      margin-top: 6px;
      padding: 6px 10px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 11px;
    }
    table {
      margin-top: 8px;
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      vertical-align: top;
    }
    th {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    td { font-family: var(--vscode-editor-font-family); }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    pre.raw {
      margin: 8px 0 0;
      padding: 8px;
      background: var(--vscode-textCodeBlock-background, transparent);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
    }
  `;

  /** Host-message subscription with managed lifetime (re-parent safe). */
  readonly hostMessages = new HostMessages<In>(this, m => this.onHost(m));

  private onHost(m: In): void {
    if (m.type === 'debugConsole.state') {
      this.conn = { state: m.state, path: m.path, error: m.error, pathWarning: m.pathWarning };
      if (m.state !== 'connected') { this.running = false; }
    } else if (m.type === 'debugConsole.runResult') {
      this.runs = [m.run, ...this.runs].slice(0, MAX_HISTORY);
      this.running = false;
    }
  }

  private connect(): void {
    if (this.socketPath.trim().length === 0) { return; }
    postToHost({ type: 'debugConsole.connect', path: this.socketPath.trim() });
  }

  private disconnect(): void {
    postToHost({ type: 'debugConsole.disconnect' });
  }

  private run(): void {
    const statement = this.statement.trim();
    if (statement.length === 0 || this.running || this.conn.state !== 'connected') { return; }
    this.running = true;
    postToHost({ type: 'debugConsole.run', statement });
    this.statement = '';
  }

  private onStatementKeydown(e: KeyboardEvent): void {
    // Enter runs; Shift+Enter inserts a newline (the host client rejects
    // multi-line statements, but the textarea stays a comfortable editor for
    // pasting).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.run();
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="header">
        <h1>Debug Console</h1>
        <span class="sub">Attach to a running app's Ditto <code>debug_socket</code> and run DQL against it.</span>
      </div>

      <div class="warning-banner" role="alert">
        Statements run live against the connected app's Ditto store — full DQL,
        including mutations and <code>ALTER SYSTEM</code>, is enabled by default
        (SDK 5.1 <code>dql_enable_remote_full_syntax</code>). This is not a
        sandbox; there is no undo.
      </div>

      <div class="connect-bar">
        <input
          type="text"
          placeholder="/path/to/ditto-debug.sock"
          .value=${this.socketPath}
          ?disabled=${this.conn.state === 'connected' || this.conn.state === 'connecting'}
          @input=${(e: Event) => { this.socketPath = (e.target as HTMLInputElement).value; }}
          aria-label="Debug socket path"
        />
        ${this.conn.state === 'connected' || this.conn.state === 'connecting'
          ? html`<button class="secondary" @click=${this.disconnect}>Disconnect</button>`
          : html`<button ?disabled=${this.socketPath.trim().length === 0} @click=${this.connect}>Connect</button>`}
        <span class="pill ${this.conn.state}">${this.pillLabel()}</span>
      </div>
      ${this.conn.pathWarning ? html`<div class="path-warning" role="alert">${this.conn.pathWarning}</div>` : nothing}
      ${this.conn.state === 'disconnected' && this.conn.error
        ? html`<div class="run"><div class="error">${this.conn.error}</div></div>`
        : nothing}

      <div class="editor">
        <textarea
          placeholder="SELECT * FROM system:data_sync_info"
          .value=${this.statement}
          ?disabled=${this.conn.state !== 'connected'}
          @input=${(e: Event) => { this.statement = (e.target as HTMLTextAreaElement).value; }}
          @keydown=${this.onStatementKeydown}
          aria-label="DQL statement"
        ></textarea>
        <button
          ?disabled=${this.conn.state !== 'connected' || this.statement.trim().length === 0 || this.running}
          @click=${this.run}
        >${this.running ? 'Running…' : 'Run'}</button>
      </div>

      <div class="history">
        ${this.runs.length === 0
          ? html`<div class="empty">Runs appear here for this session (newest first, last ${MAX_HISTORY} kept).</div>`
          : this.runs.map(r => this.renderRun(r))}
      </div>
    `;
  }

  private pillLabel(): string {
    switch (this.conn.state) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting…';
      case 'disconnected': return 'Disconnected';
    }
  }

  private renderRun(run: ConsoleRun): TemplateResult {
    return html`
      <div class="run">
        <div class="statement">${run.statement}</div>
        <div class="meta">
          ${run.ok
            ? html`${run.totalRowCount.toLocaleString()} item${run.totalRowCount === 1 ? '' : 's'} · ${run.durationMs} ms`
            : html`failed · ${run.durationMs} ms`}
        </div>
        ${run.ok ? this.renderRows(run) : html`<div class="error">${run.error}</div>`}
      </div>
    `;
  }

  private renderRows(run: ConsoleRun): TemplateResult | typeof nothing {
    const rows = run.rows ?? [];
    const columns = rows.every(isPlainRow) && rows.length > 0
      ? [...new Set(rows.flatMap(r => Object.keys(r)))]
      : [];
    return html`
      ${run.truncated
        ? html`<div class="truncate-note">Showing the first ${rows.length.toLocaleString()} of ${run.totalRowCount.toLocaleString()} items — the debug socket has no row cap, so the console caps display.</div>`
        : nothing}
      ${rows.length === 0
        ? html`<div class="meta">Empty result ([]).</div>`
        : columns.length > 0
          ? html`
            <table>
              <thead><tr>${columns.map(c => html`<th>${c}</th>`)}</tr></thead>
              <tbody>
                ${rows.map(r => html`
                  <tr>${columns.map(c => this.renderCell((r as Record<string, unknown>)[c]))}</tr>
                `)}
              </tbody>
            </table>`
          : html`<pre class="raw">${JSON.stringify(rows, null, 2)}</pre>`}
    `;
  }

  private renderCell(value: unknown): TemplateResult {
    if (value === undefined || value === null) {
      return html`<td class="null">null</td>`;
    }
    if (typeof value === 'object') {
      const json = JSON.stringify(value);
      const preview = json.length > CELL_PREVIEW_CHARS ? `${json.slice(0, CELL_PREVIEW_CHARS)}…` : json;
      return html`<td title=${json}>${preview}</td>`;
    }
    // Remaining scalars (number/boolean): JSON values over the socket are
    // never symbols or functions.
    if (typeof value === 'string') { return html`<td>${value}</td>`; }
    return html`<td>${JSON.stringify(value) ?? ''}</td>`;
  }
}
