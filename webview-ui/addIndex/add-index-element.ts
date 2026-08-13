import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

type In =
  | { type: 'addIndex.init'; collections: string[]; preselected?: string }
  | { type: 'addIndex.error'; message: string }
  | { type: 'addIndex.created' };

@customElement('ditto-add-index')
export class AddIndexElement extends LitElement {
  @state() private collections: string[] = [];
  @state() private selectedCollection = '';
  @state() private field = '';
  @state() private isCreating = false;
  @state() private errorMessage: string | undefined;

  static styles = css`
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

  /** Disposes the host-message subscription; without it every re-attach
   *  leaves another live handler bound to a stale element. */
  private disposeHostMessages: (() => void) | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeHostMessages = onHostMessage<In>(msg => {
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
  }

  disconnectedCallback(): void {
    this.disposeHostMessages?.();
    this.disposeHostMessages = undefined;
    super.disconnectedCallback();
  }

  private isValid(): boolean {
    return this.selectedCollection.trim().length > 0
        && this.field.trim().length > 0
        && !this.isCreating;
  }

  private create(): void {
    if (!this.isValid()) { return; }
    this.isCreating = true;
    this.errorMessage = undefined;
    postToHost({
      type: 'addIndex.create',
      collection: this.selectedCollection,
      field: this.field.trim(),
    });
  }

  private cancel(): void {
    postToHost({ type: 'addIndex.cancel' });
  }

  render() {
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

      <label>Field</label>
      <input
        type="text"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        .value=${this.field}
        @input=${(e: Event) => this.field = (e.target as HTMLInputElement).value}
      />

      <div class="info">
        <p>DQL limits indexes to a single field on a collection. You can create multiple indexes on a single collection.</p>
        <p>DQL supports union and intersect scans for queries with OR, IN, and AND operators. This allows the query optimizer to use multiple indexes simultaneously in a single query. For example, a query like <code>WHERE status = 'active' OR priority = 'high'</code> can leverage separate indexes on both status and priority fields, combining results through a union scan.</p>
      </div>

      ${this.errorMessage ? html`<div class="error">${this.errorMessage}</div>` : ''}

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.create}>Create</button>
      </div>
    `;
  }
}
