// webview-ui/importData/import-data-element.ts
//
// Mirrors the SwiftUI ImportDataView UI:
//   - File picker (host-side dialog; webview just sends the request)
//   - Existing/new collection segmented control
//   - Insert-type switch (Regular vs Initial)
//   - Status section with progress bar, error pane, or success message
//
// State machine is intentionally small:
//   'idle'        — user can pick a file, configure collection, click Import
//   'importing'   — Import button disabled, progress bar live
//   'done'        — success message + Done button (no re-import without
//                   picking a new file, matching SwiftUI)

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';

type InsertType = 'regular' | 'initial';

type Msg =
  | { type: 'importData.init'; databaseName: string; existingCollections: string[]; preselectedCollection?: string }
  | { type: 'importData.collectionsRefreshed'; existingCollections: string[] }
  | { type: 'importData.fileSelected'; fileName: string; documentCount: number }
  | { type: 'importData.progress'; current: number; total: number; currentDocumentId?: string }
  | { type: 'importData.done'; successCount: number; failureCount: number; errors: string[]; collection: string }
  | { type: 'importData.error'; message: string };

@customElement('ditto-import-data')
export class ImportDataElement extends LitElement {
  @state() private databaseName = '';
  @state() private existingCollections: string[] = [];
  @state() private useExistingCollection = true;
  @state() private selectedExistingCollection = '';
  @state() private newCollectionName = '';
  @state() private insertType: InsertType = 'regular';

  @state() private fileName: string | undefined;
  @state() private documentCount: number | undefined;

  /** Status surfaces — only one of these is set at a time. */
  @state() private isImporting = false;
  @state() private progressCurrent = 0;
  @state() private progressTotal = 0;
  @state() private progressDocId: string | undefined;
  @state() private errorMessage: string | undefined;
  @state() private done: { successCount: number; failureCount: number; errors: string[]; collection: string } | undefined;

  static override styles = css`
    :host {
      display: block;
      padding: 24px;
      max-width: 640px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      line-height: 1.4;
    }
    h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
    .subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
    }
    section { margin-bottom: 20px; }
    section > .label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-foreground);
      margin-bottom: 8px;
    }

    /* File row — name on the left, button on the right. */
    .file-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 6px;
    }
    .file-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-name.placeholder { color: var(--vscode-descriptionForeground); }
    .file-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }

    /* Segmented control. */
    .segmented {
      display: inline-flex;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
      width: 100%;
    }
    .segmented button {
      flex: 1;
      padding: 6px 12px;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      cursor: pointer;
      font: inherit;
    }
    .segmented button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    select, input[type="text"] {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      font: inherit;
      box-sizing: border-box;
    }
    .empty-collections {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 8px 0;
    }

    /* Insert-type toggle area. */
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .switch {
      position: relative;
      width: 34px; height: 18px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .switch::after {
      content: '';
      position: absolute;
      top: 1px; left: 1px;
      width: 14px; height: 14px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      transition: transform 0.15s ease;
    }
    .switch.on { background: var(--vscode-button-background); }
    .switch.on::after { transform: translateX(16px); background: var(--vscode-button-foreground); }
    .toggle-body { flex: 1; }
    .toggle-body .title { font-size: 13px; }
    .toggle-body .desc { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .initial-info {
      margin-top: 8px;
      padding: 8px;
      background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
      border-radius: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* Status card. */
    .status-card {
      padding: 12px;
      border-radius: 6px;
      font-size: 12px;
    }
    .status-card.progress {
      background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
    }
    .status-card.error {
      background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
      color: var(--vscode-errorForeground);
    }
    .status-card.success {
      background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 15%, transparent);
      color: var(--vscode-foreground);
    }
    .progress-bar {
      width: 100%;
      height: 6px;
      background: var(--vscode-input-background);
      border-radius: 3px;
      overflow: hidden;
      margin: 6px 0;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-button-background);
      transition: width 0.15s ease;
    }
    .doc-id { font-family: var(--vscode-editor-font-family); margin-top: 4px; word-break: break-all; }
    .error-detail {
      margin-top: 6px;
      max-height: 160px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }

    /* Footer */
    .footer {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .footer button {
      padding: 6px 16px;
      cursor: pointer;
      border: none;
      border-radius: 2px;
      font: inherit;
    }
    .footer button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .footer button.primary[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<Msg>(this, (msg) => this.onHost(msg));

  private onHost(msg: Msg): void {
    switch (msg.type) {
      case 'importData.init':
        this.databaseName = msg.databaseName;
        this.existingCollections = msg.existingCollections;
        // Apply preselect first so the user lands on the collection they
        // right-clicked. Fall back to the first existing collection so
        // the dropdown isn't empty by default.
        if (msg.preselectedCollection && msg.existingCollections.includes(msg.preselectedCollection)) {
          this.useExistingCollection = true;
          this.selectedExistingCollection = msg.preselectedCollection;
        } else if (msg.existingCollections.length > 0 && !this.selectedExistingCollection) {
          const first = msg.existingCollections[0];
          if (first) { this.selectedExistingCollection = first; }
        }
        break;
      case 'importData.collectionsRefreshed':
        this.existingCollections = msg.existingCollections;
        if (!this.selectedExistingCollection && msg.existingCollections.length > 0) {
          const first = msg.existingCollections[0];
          if (first) { this.selectedExistingCollection = first; }
        }
        break;
      case 'importData.fileSelected':
        this.fileName = msg.fileName;
        this.documentCount = msg.documentCount;
        // A new file invalidates any previous error/done state — the
        // user wants to start fresh.
        this.errorMessage = undefined;
        this.done = undefined;
        break;
      case 'importData.progress':
        this.isImporting = true;
        this.progressCurrent = msg.current;
        this.progressTotal = msg.total;
        this.progressDocId = msg.currentDocumentId;
        break;
      case 'importData.done':
        this.isImporting = false;
        this.done = {
          successCount: msg.successCount,
          failureCount: msg.failureCount,
          errors: msg.errors,
          collection: msg.collection,
        };
        // Clear the buffered file so the user has to pick another to
        // re-import (matches SwiftUI: success state shows a Done button,
        // not another Import).
        this.fileName = undefined;
        this.documentCount = undefined;
        break;
      case 'importData.error':
        this.isImporting = false;
        this.errorMessage = msg.message;
        break;
    }
  }

  // ─── Event handlers ────────────────────────────────────────

  private chooseFile = (): void => {
    this.errorMessage = undefined;
    postToHost({ type: 'importData.chooseFile' });
  };

  private setUseExisting = (useExisting: boolean): void => {
    this.useExistingCollection = useExisting;
    // Newly switching to existing — refresh in case the user opened the
    // panel before the collection sync completed.
    if (useExisting) { postToHost({ type: 'importData.refreshCollections' }); }
  };

  private toggleInsertType = (): void => {
    this.insertType = this.insertType === 'regular' ? 'initial' : 'regular';
  };

  private get targetCollection(): string {
    if (this.useExistingCollection) { return this.selectedExistingCollection; }
    return this.newCollectionName.trim();
  }

  private get canImport(): boolean {
    if (this.isImporting) { return false; }
    if (!this.fileName || this.documentCount === undefined) { return false; }
    return this.targetCollection.length > 0;
  }

  private startImport = (): void => {
    if (!this.canImport) { return; }
    this.errorMessage = undefined;
    this.done = undefined;
    this.isImporting = true;
    this.progressCurrent = 0;
    this.progressTotal = this.documentCount ?? 0;
    this.progressDocId = undefined;
    postToHost({
      type: 'importData.start',
      collection: this.targetCollection,
      insertType: this.insertType,
    });
  };

  private cancel = (): void => {
    postToHost({ type: 'importData.cancel' });
  };

  // ─── Render ────────────────────────────────────────────────

  override render(): TemplateResult {
    return html`
      <h2>Import JSON Data</h2>
      <div class="subtitle">
        Bulk-insert documents into <strong>${this.databaseName}</strong>
        from a JSON file. The file must contain an array of objects, each
        with an <code>_id</code> field.
      </div>

      ${this.renderFileSection()}
      ${this.renderCollectionSection()}
      ${this.renderInsertTypeSection()}
      ${this.renderStatusSection()}
      ${this.renderFooter()}
    `;
  }

  private renderFileSection(): TemplateResult {
    return html`
      <section>
        <div class="label">Select JSON File</div>
        <div class="file-row">
          <div class="file-name ${this.fileName ? '' : 'placeholder'}">
            ${this.fileName ?? 'No file selected'}
            ${this.documentCount !== undefined ? html`
              <div class="file-meta">${this.documentCount} document${this.documentCount === 1 ? '' : 's'}</div>
            ` : ''}
          </div>
          <button class="primary" @click=${this.chooseFile} ?disabled=${this.isImporting}>
            Choose File…
          </button>
        </div>
      </section>
    `;
  }

  private renderCollectionSection(): TemplateResult {
    return html`
      <section>
        <div class="label">Target Collection</div>
        <div class="segmented">
          <button
            class=${this.useExistingCollection ? 'active' : ''}
            @click=${() => this.setUseExisting(true)}
            ?disabled=${this.isImporting}
          >Existing Collection</button>
          <button
            class=${this.useExistingCollection ? '' : 'active'}
            @click=${() => this.setUseExisting(false)}
            ?disabled=${this.isImporting}
          >New Collection</button>
        </div>
        <div style="margin-top: 8px;">
          ${this.useExistingCollection ? this.renderExistingPicker() : this.renderNewInput()}
        </div>
      </section>
    `;
  }

  private renderExistingPicker(): TemplateResult {
    if (this.existingCollections.length === 0) {
      return html`<div class="empty-collections">
        No existing collections found. Switch to "New Collection" to create one.
      </div>`;
    }
    return html`
      <select
        .value=${this.selectedExistingCollection}
        @change=${(e: Event) => { this.selectedExistingCollection = (e.target as HTMLSelectElement).value; }}
        ?disabled=${this.isImporting}
      >
        ${this.existingCollections.map(c => html`<option value=${c}>${c}</option>`)}
      </select>
    `;
  }

  private renderNewInput(): TemplateResult {
    return html`
      <input
        id="new-collection-input"
        type="text"
        placeholder="New collection name"
        .value=${this.newCollectionName}
        @input=${(e: Event) => { this.newCollectionName = (e.target as HTMLInputElement).value; }}
        ?disabled=${this.isImporting}
      />
      <div class="file-meta" style="margin-top: 4px;">
        Only letters, numbers, and underscores are allowed.
      </div>
    `;
  }

  private renderInsertTypeSection(): TemplateResult {
    const isInitial = this.insertType === 'initial';
    return html`
      <section>
        <div class="label">Insert Type</div>
        <div class="toggle-row">
          <div
            class="switch ${isInitial ? 'on' : ''}"
            role="switch"
            aria-checked=${isInitial}
            tabindex="0"
            @click=${this.toggleInsertType}
            @keydown=${(e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.toggleInsertType(); } }}
          ></div>
          <div class="toggle-body">
            <div class="title">${isInitial ? 'Initial Documents Insert' : 'Regular Insert'}</div>
            <div class="desc">
              ${isInitial
                ? 'Use for first-time data import (INITIAL DOCUMENTS)'
                : 'Use for adding data to existing collections (upserts on _id conflict)'}
            </div>
          </div>
        </div>
        ${isInitial ? html`
          <div class="initial-info">
            Initial insert is designed for loading data for the first time and has special optimizations.
          </div>
        ` : ''}
      </section>
    `;
  }

  private renderStatusSection(): TemplateResult {
    if (this.isImporting) {
      const pct = this.progressTotal > 0
        ? Math.min(100, Math.round((this.progressCurrent / this.progressTotal) * 100))
        : 0;
      return html`
        <section>
          <div class="label">Status</div>
          <div class="status-card progress">
            <div>Importing: ${this.progressCurrent} of ${this.progressTotal} documents (${pct}%)</div>
            <div class="progress-bar"><div class="progress-fill" style=${`width: ${pct}%`}></div></div>
            ${this.progressDocId ? html`<div class="doc-id">Processing: ${this.progressDocId}</div>` : ''}
          </div>
        </section>
      `;
    }
    if (this.errorMessage) {
      return html`
        <section>
          <div class="label">Status</div>
          <div class="status-card error">
            <strong>Error</strong>
            <div class="error-detail">${this.errorMessage}</div>
          </div>
        </section>
      `;
    }
    if (this.done) {
      const { successCount, failureCount, errors, collection } = this.done;
      const headline = failureCount === 0
        ? `Successfully imported ${successCount} document${successCount === 1 ? '' : 's'} to ${collection}`
        : `Imported ${successCount} document${successCount === 1 ? '' : 's'} to ${collection} with ${failureCount} failure${failureCount === 1 ? '' : 's'}`;
      return html`
        <section>
          <div class="label">Status</div>
          <div class="status-card ${failureCount === 0 ? 'success' : 'error'}">
            <div>${headline}</div>
            ${errors.length > 0 ? html`
              <div class="error-detail">
                ${errors.map(e => html`<div>${e}</div>`)}
              </div>
            ` : ''}
          </div>
        </section>
      `;
    }
    return html``;
  }

  private renderFooter(): TemplateResult {
    if (this.done) {
      // SwiftUI parity: success/partial-success replaces Import with Done.
      return html`
        <div class="footer">
          <button class="primary" @click=${this.cancel}>Done</button>
        </div>
      `;
    }
    return html`
      <div class="footer">
        <button class="secondary" @click=${this.cancel} ?disabled=${this.isImporting}>Cancel</button>
        <button class="primary" @click=${this.startImport} ?disabled=${!this.canImport}>
          ${this.isImporting ? 'Importing…' : 'Import'}
        </button>
      </div>
    `;
  }
}
