import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import type { IndexField } from '../../src/models/DittoCollection.js';

type In =
  | { type: 'addIndex.init'; collections: string[]; preselected?: string }
  | { type: 'addIndex.error'; message: string }
  | { type: 'addIndex.created' };

@customElement('ditto-add-index')
export class AddIndexElement extends LitElement {
  @state() private collections: string[] = [];
  @state() private selectedCollection = '';
  /** Ordered keys. Ditto SDK 5.1 supports composite indexes, and the order is
   *  significant to the query optimizer, so the rows are reorderable rather
   *  than sorted for display. */
  @state() private fields: IndexField[] = [{ name: '', ascending: true }];
  @state() private isCreating = false;
  @state() private errorMessage: string | undefined;

  static override styles = css`
    :host {
      display: block;
      padding: 24px;
      max-width: 640px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    h2 {
      margin-top: 24px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    label {
      display: block;
      margin: 12px 0 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    input, select {
      width: 100%;
      padding: 6px 8px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font: inherit;
    }
    select {
      /* Native dropdown caret rendering uses the platform; just ensure
         text/background follow VS Code theme tokens. */
      appearance: auto;
    }
    .key-row {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 6px;
    }
    /* The field name takes the slack; the direction stays wide enough to read
       and the icon buttons stay square. */
    .key-row input { flex: 1 1 auto; width: auto; }
    .key-row select { flex: 0 0 84px; width: auto; }
    .row-btn {
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      cursor: pointer;
      font: inherit;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .row-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
    .add-field {
      margin-top: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .info {
      margin-top: 24px;
      padding: 12px 0;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .info p {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 8px 0;
      line-height: 1.5;
    }
    .info p:last-child { margin-bottom: 0; }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textBlockQuote-background, transparent);
      padding: 0 2px;
      border-radius: 2px;
    }
    .error {
      margin-top: 12px;
      font-size: 11px;
      color: var(--vscode-errorForeground, #f48771);
    }
    .footer {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .footer button {
      padding: 6px 16px;
      cursor: pointer;
      border: none;
      font: inherit;
    }
    .footer .save {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<In>(this, msg => {
    if (msg.type === 'addIndex.init') {
      this.collections = msg.collections;
      const fallback = msg.collections[0] ?? '';
      this.selectedCollection = msg.preselected ?? fallback;
    } else if (msg.type === 'addIndex.error') {
      this.errorMessage = msg.message;
      this.isCreating = false;
    }
    // 'addIndex.created' results in panel disposal — no-op here.
  });

  /** Non-blank keys, trimmed, in the order shown. */
  private cleanFields(): IndexField[] {
    return this.fields
      .map(f => ({ name: f.name.trim(), ascending: f.ascending }))
      .filter(f => f.name.length > 0);
  }

  /** A key repeated in the list, if any — reported inline rather than as a
   *  round-trip error, since the user can see both rows. */
  private duplicateField(): string | undefined {
    const seen = new Set<string>();
    for (const f of this.cleanFields()) {
      if (seen.has(f.name)) { return f.name; }
      seen.add(f.name);
    }
    return undefined;
  }

  private isValid(): boolean {
    return this.selectedCollection.trim().length > 0
        && this.cleanFields().length > 0
        && this.duplicateField() === undefined
        && !this.isCreating;
  }

  private create(): void {
    if (!this.isValid()) { return; }
    this.isCreating = true;
    this.errorMessage = undefined;
    postToHost({
      type: 'addIndex.create',
      collection: this.selectedCollection,
      fields: this.cleanFields(),
    });
  }

  private setFieldName(i: number, name: string): void {
    this.fields = this.fields.map((f, j) => (j === i ? { ...f, name } : f));
  }

  private setFieldDirection(i: number, ascending: boolean): void {
    this.fields = this.fields.map((f, j) => (j === i ? { ...f, ascending } : f));
  }

  private addField(): void {
    this.fields = [...this.fields, { name: '', ascending: true }];
  }

  private removeField(i: number): void {
    // Always leave one row: an empty editor has nothing to type into.
    const next = this.fields.filter((_, j) => j !== i);
    this.fields = next.length > 0 ? next : [{ name: '', ascending: true }];
  }

  /** Move a key one place up or down. Order decides which queries the index
   *  can serve, so it has to be editable without retyping every row. */
  private moveField(i: number, delta: -1 | 1): void {
    const to = i + delta;
    if (to < 0 || to >= this.fields.length) { return; }
    const next = [...this.fields];
    const a = next[i];
    const b = next[to];
    if (a === undefined || b === undefined) { return; }
    next[i] = b;
    next[to] = a;
    this.fields = next;
  }

  private cancel(): void {
    postToHost({ type: 'addIndex.cancel' });
  }

  override render() {
    return html`
      <h2>Index</h2>

      <label>Collection</label>
      <select
        .value=${this.selectedCollection}
        @change=${(e: Event) => this.selectedCollection = (e.target as HTMLSelectElement).value}
      >
        ${this.collections.map(name => html`
          <option value=${name} ?selected=${name === this.selectedCollection}>${name}</option>
        `)}
      </select>

      <label>Fields</label>
      ${this.fields.map((f, i) => html`
        <div class="key-row">
          <input
            type="text"
            placeholder="field or nested.path"
            aria-label=${`Index field ${i + 1}`}
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            .value=${f.name}
            @input=${(e: Event) => this.setFieldName(i, (e.target as HTMLInputElement).value)}
          />
          <select
            aria-label=${`Sort direction for field ${i + 1}`}
            .value=${f.ascending ? 'ASC' : 'DESC'}
            @change=${(e: Event) =>
              this.setFieldDirection(i, (e.target as HTMLSelectElement).value === 'ASC')}
          >
            <option value="ASC" ?selected=${f.ascending}>ASC</option>
            <option value="DESC" ?selected=${!f.ascending}>DESC</option>
          </select>
          <button
            class="row-btn" title="Move up" aria-label=${`Move field ${i + 1} up`}
            ?disabled=${i === 0}
            @click=${() => this.moveField(i, -1)}
          >↑</button>
          <button
            class="row-btn" title="Move down" aria-label=${`Move field ${i + 1} down`}
            ?disabled=${i === this.fields.length - 1}
            @click=${() => this.moveField(i, 1)}
          >↓</button>
          <button
            class="row-btn" title="Remove field" aria-label=${`Remove field ${i + 1}`}
            ?disabled=${this.fields.length === 1 && f.name.trim().length === 0}
            @click=${() => this.removeField(i)}
          >✕</button>
        </div>
      `)}
      <button class="add-field" @click=${this.addField}>+ Add field</button>

      <div class="info">
        <p>Two or more fields create a <strong>composite index</strong>. Field order matters: put fields used in equality filters first, then fields used for range filters or sorting. A query that skips the leading field gets little benefit from the index.</p>
        <p>Example — <code>(status ASC, createdAt DESC)</code> serves <code>WHERE status = 'open' ORDER BY createdAt DESC</code>.</p>
        <p>Separate single-field indexes are often better for unrelated filters: DQL supports union and intersect scans for <code>OR</code>, <code>IN</code> and <code>AND</code>, so the optimizer can combine several indexes in one query.</p>
      </div>

      ${this.duplicateField() !== undefined
        ? html`<div class="error">Field "${this.duplicateField()}" is listed more than once.</div>`
        : ''}
      ${this.errorMessage ? html`<div class="error">${this.errorMessage}</div>` : ''}

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.create}>Create</button>
      </div>
    `;
  }
}
