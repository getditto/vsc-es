import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';

interface ImportableSubscription {
  id: string;
  deviceName: string;
  deviceInfo: string;
  collectionName: string;
  query: string;
}

type In =
  | { type: 'importSubs.loading' }
  | { type: 'importSubs.loaded'; subscriptions: ImportableSubscription[] }
  | { type: 'importSubs.error'; message: string }
  | { type: 'importSubs.importing'; status: string }
  | { type: 'importSubs.imported'; count: number };

type ViewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; rows: ImportableSubscription[]; selected: Set<string> }
  | { kind: 'error'; message: string }
  | { kind: 'importing'; status: string };

@customElement('ditto-import-subscriptions')
export class ImportSubscriptionsElement extends LitElement {
  @state() private view: ViewState = { kind: 'loading' };

  static styles = css`
    :host {
      display: block; padding: 24px; max-width: 820px;
      font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    }
    h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    .center { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 0; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .list { border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .row:last-child { border-bottom: none; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row input[type="checkbox"] { margin-top: 4px; cursor: pointer; }
    .row .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .row .collection { font-weight: 600; font-size: 13px; }
    .row .query { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-foreground); word-break: break-word; }
    .row .device { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .toolbar { display: flex; gap: 8px; align-items: center; margin: 12px 0 16px; font-size: 12px; }
    .toolbar button.linklike { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
    .toolbar .count { margin-left: auto; color: var(--vscode-descriptionForeground); }
    .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer button { padding: 6px 16px; cursor: pointer; border: none; border-radius: 2px; font: inherit; }
    .footer .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .progress { font-size: 12px; color: var(--vscode-descriptionForeground); margin-right: auto; }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<In>(this, (msg) => {
    switch (msg.type) {
      case 'importSubs.loading':
        this.view = { kind: 'loading' };
        break;
      case 'importSubs.loaded':
        this.view = { kind: 'loaded', rows: msg.subscriptions, selected: new Set() };
        break;
      case 'importSubs.error':
        this.view = { kind: 'error', message: msg.message };
        break;
      case 'importSubs.importing':
        this.view = { kind: 'importing', status: msg.status };
        break;
      case 'importSubs.imported':
        // Host closes the panel right after — no UI work needed.
        break;
    }
  });

  private toggle(id: string): void {
    if (this.view.kind !== 'loaded') { return; }
    const selected = new Set(this.view.selected);
    if (selected.has(id)) { selected.delete(id); } else { selected.add(id); }
    this.view = { ...this.view, selected };
  }

  private selectAll(): void {
    if (this.view.kind !== 'loaded') { return; }
    this.view = { ...this.view, selected: new Set(this.view.rows.map(r => r.id)) };
  }

  private selectNone(): void {
    if (this.view.kind !== 'loaded') { return; }
    this.view = { ...this.view, selected: new Set() };
  }

  private importSelected(): void {
    if (this.view.kind !== 'loaded') { return; }
    const queries = this.view.rows
      .filter(r => this.view.kind === 'loaded' && this.view.selected.has(r.id))
      .map(r => r.query);
    if (queries.length === 0) { return; }
    postToHost({ type: 'importSubs.importSelected', queries });
  }

  private cancel(): void { postToHost({ type: 'importSubs.cancel' }); }

  render(): TemplateResult {
    return html`
      <h2>Import Subscriptions from Server</h2>
      <div class="subtitle">
        Subscriptions are pulled live from the Ditto Server's
        <code>__small_peer_info</code> table. Already-imported queries are filtered out.
      </div>
      ${this.renderBody()}
      ${this.renderFooter()}
    `;
  }

  private renderBody(): TemplateResult {
    switch (this.view.kind) {
      case 'loading':
        return html`<div class="center">Loading device subscriptions…</div>`;
      case 'error':
        return html`<div class="center error">${this.view.message}</div>`;
      case 'importing':
        return html`<div class="center">${this.view.status}</div>`;
      case 'loaded':
        if (this.view.rows.length === 0) {
          return html`<div class="center">
            <div>No new subscriptions found.</div>
            <div style="font-size: 11px;">All device subscriptions are already imported.</div>
          </div>`;
        }
        return this.renderList(this.view.rows, this.view.selected);
    }
  }

  private renderList(rows: ImportableSubscription[], selected: Set<string>): TemplateResult {
    return html`
      <div class="toolbar">
        <button class="linklike" @click=${this.selectAll}>Select all</button>
        <button class="linklike" @click=${this.selectNone}>Select none</button>
        <span class="count">${selected.size} of ${rows.length} selected</span>
      </div>
      <div class="list">
        ${rows.map(r => html`
          <label class="row">
            <input
              type="checkbox"
              .checked=${selected.has(r.id)}
              @change=${() => this.toggle(r.id)}
            />
            <div class="body">
              <div class="collection">${r.collectionName}</div>
              <div class="query">${r.query}</div>
              <div class="device">${r.deviceName} · ${r.deviceInfo}</div>
            </div>
          </label>
        `)}
      </div>
    `;
  }

  private renderFooter(): TemplateResult {
    if (this.view.kind === 'importing') {
      return html`
        <div class="footer">
          <span class="progress">${this.view.status}</span>
        </div>
      `;
    }
    const canImport = this.view.kind === 'loaded' && this.view.selected.size > 0;
    const count = this.view.kind === 'loaded' ? this.view.selected.size : 0;
    return html`
      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button
          class="save"
          ?disabled=${!canImport}
          @click=${this.importSelected}
        >Import ${count > 0 ? `(${count})` : ''}</button>
      </div>
    `;
  }
}
