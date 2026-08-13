import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

type In = { type: 'sub.init'; id?: string; name: string; query: string };

@customElement('ditto-subscription-editor')
export class SubscriptionEditor extends LitElement {
  @state() private subId: string | undefined;
  @state() private name = '';
  @state() private query = '';

  static styles = css`
    :host { display: block; padding: 24px; max-width: 640px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    h2 { margin-top: 24px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input, textarea {
      width: 100%; padding: 6px 8px; box-sizing: border-box;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font: inherit;
    }
    textarea { font-family: var(--vscode-editor-font-family); min-height: 160px; resize: vertical; }
    .help { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer button { padding: 6px 16px; cursor: pointer; border: none; }
    .footer .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  `;

  /** Disposes the host-message subscription; without it every re-attach
   *  leaves another live handler bound to a stale element. */
  private disposeHostMessages: (() => void) | undefined;

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeHostMessages = onHostMessage<In>(msg => {
      if (msg.type === 'sub.init') { this.subId = msg.id; this.name = msg.name; this.query = msg.query; }
    });
  }

  disconnectedCallback(): void {
    this.disposeHostMessages?.();
    this.disposeHostMessages = undefined;
    super.disconnectedCallback();
  }

  private isValid() { return this.name.trim().length > 0 && this.query.trim().length > 0; }
  private save() { postToHost({ type: 'sub.save', id: this.subId, name: this.name, query: this.query }); }
  private cancel() { postToHost({ type: 'sub.cancel' }); }

  render() {
    return html`
      <h2>Basic Information</h2>
      <label>Name</label>
      <input type="text" .value=${this.name} @input=${(e: Event) => this.name = (e.target as HTMLInputElement).value} />

      <h2>Query</h2>
      <textarea .value=${this.query} @input=${(e: Event) => this.query = (e.target as HTMLTextAreaElement).value}></textarea>
      <div class="help">Ex: SELECT * FROM collectionName</div>

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.save}>Save</button>
      </div>
    `;
  }
}
