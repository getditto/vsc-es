import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface StoredDittoConfig {
  id: string;
  name: string;
  databaseId: string;
  mode: 'server' | 'smallPeersOnly';
  authUrl: string;
  websocketUrl?: string;
  httpApiUrl: string;
  allowUntrustedCerts: boolean;
  logLevel: 'error' | 'warning' | 'info' | 'debug' | 'verbose';
  isStrictModeEnabled: boolean;
}

interface SecretSet { token: string; secretKey?: string; httpApiKey?: string; }

type In =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.validationError'; message: string };

@customElement('ditto-database-editor')
export class DatabaseEditor extends LitElement {
  @state() private config: StoredDittoConfig | null = null;
  @state() private secrets: SecretSet = { token: '' };
  @state() private validationError: string | null = null;

  static styles = css`
    :host { display: block; padding: 24px; max-width: 720px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    h2 { margin-top: 32px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input[type=text], input[type=password], select, textarea {
      width: 100%; padding: 6px 8px; box-sizing: border-box;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font: inherit; font-family: var(--vscode-editor-font-family);
    }
    .mode-picker { display: flex; gap: 4px; margin: 16px 0; }
    .mode-picker button { flex: 1; padding: 6px 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; cursor: pointer; }
    .mode-picker button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .help { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .warn { font-size: 11px; color: var(--vscode-editorWarning-foreground); margin-top: 4px; }
    .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    .footer button { padding: 6px 16px; cursor: pointer; border: none; }
    .footer .save { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .footer .save[disabled] { opacity: 0.5; cursor: not-allowed; }
    .footer .cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .error-banner { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px 12px; margin-bottom: 16px; border-radius: 2px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'editor.init') { this.config = msg.config; this.secrets = msg.secrets; }
      if (msg.type === 'editor.validationError') { this.validationError = msg.message; }
    });
  }

  private update_(field: keyof StoredDittoConfig, value: any) {
    if (!this.config) { return; }
    this.config = { ...this.config, [field]: value };
  }

  private updateSecret(field: keyof SecretSet, value: string) {
    this.secrets = { ...this.secrets, [field]: value };
  }

  private isValid(): boolean {
    const c = this.config;
    if (!c) { return false; }
    if (!c.name.trim() || !c.databaseId.trim() || !this.secrets.token.trim()) { return false; }
    return true;
  }

  private save() {
    if (!this.config) { return; }
    postToHost({ type: 'editor.save', config: this.config, secrets: this.secrets });
  }

  private cancel() { postToHost({ type: 'editor.cancel' }); }

  render() {
    if (!this.config) { return html`<p>Loading…</p>`; }
    const c = this.config;
    return html`
      ${this.validationError ? html`<div class="error-banner">${this.validationError}</div>` : nothing}

      <div class="mode-picker" role="tablist">
        <button class=${c.mode === 'server' ? 'active' : ''} @click=${() => this.update_('mode', 'server')}>Server</button>
        <button class=${c.mode === 'smallPeersOnly' ? 'active' : ''} @click=${() => this.update_('mode', 'smallPeersOnly')}>Small Peers Only</button>
      </div>

      <h2>Basic Information</h2>
      <label>Name</label>
      <input type="text" .value=${c.name} @input=${(e: Event) => this.update_('name', (e.target as HTMLInputElement).value)} />

      <h2>Authorization Information</h2>
      <label>Database ID</label>
      <input type="text" .value=${c.databaseId} @input=${(e: Event) => this.update_('databaseId', (e.target as HTMLInputElement).value.trim())} style="font-family: var(--vscode-editor-font-family)" />

      <label>${c.mode === 'server' ? 'Token' : 'Offline Token'}</label>
      <input type="password" .value=${this.secrets.token} @input=${(e: Event) => this.updateSecret('token', (e.target as HTMLInputElement).value.trim())} />
      ${c.mode === 'smallPeersOnly' ? html`<div class="help">Required for sync activation in Small Peers Only mode. Obtain from <a href="https://portal.ditto.live">portal.ditto.live</a>.</div>` : nothing}

      ${c.mode === 'server' ? html`
        <h2>Ditto Server (BigPeer) Information</h2>
        <label>URL</label>
        <input type="text" .value=${c.authUrl} @input=${(e: Event) => this.update_('authUrl', (e.target as HTMLInputElement).value)} />

        <h2>Ditto Server — HTTP API (Optional)</h2>
        <label>HTTP API URL</label>
        <input type="text" .value=${c.httpApiUrl} @input=${(e: Event) => this.update_('httpApiUrl', (e.target as HTMLInputElement).value)} />
        <label>HTTP API Key</label>
        <input type="password" .value=${this.secrets.httpApiKey ?? ''} @input=${(e: Event) => this.updateSecret('httpApiKey', (e.target as HTMLInputElement).value)} />
        <div class="checkbox-row">
          <input type="checkbox" id="cb-untrusted" .checked=${c.allowUntrustedCerts} @change=${(e: Event) => this.update_('allowUntrustedCerts', (e.target as HTMLInputElement).checked)} />
          <label for="cb-untrusted" style="margin: 0">Allow untrusted certificates</label>
        </div>
        <div class="warn">By allowing untrusted certificates, you bypass SSL validation. Use only in development.</div>
      ` : nothing}

      ${c.mode === 'smallPeersOnly' ? html`
        <h2>Optional Shared Secret Key</h2>
        <input type="password" .value=${this.secrets.secretKey ?? ''} @input=${(e: Event) => this.updateSecret('secretKey', (e.target as HTMLInputElement).value)} />
        <div class="help">Optional secret key for shared key identity encryption. Leave empty if not using Shared Key.</div>
      ` : nothing}

      <h2>Developer Options</h2>
      <label>SDK Log Level</label>
      <select .value=${c.logLevel} @change=${(e: Event) => this.update_('logLevel', (e.target as HTMLSelectElement).value)}>
        <option value="error">Error</option>
        <option value="warning">Warning</option>
        <option value="info">Info (Default)</option>
        <option value="debug">Debug</option>
        <option value="verbose">Verbose</option>
      </select>
      <div class="help">Controls DittoLogger.minimumLogLevel when this database is activated.</div>

      <div class="checkbox-row">
        <input type="checkbox" id="cb-strict" .checked=${c.isStrictModeEnabled} @change=${(e: Event) => this.update_('isStrictModeEnabled', (e.target as HTMLInputElement).checked)} />
        <label for="cb-strict" style="margin: 0">Enable DQL Strict Mode</label>
      </div>
      <div class="warn">⚠️ For most users of Ditto SDK 5.0+, strict mode should remain disabled. Enable only if you require SDK 4.x compatibility.</div>

      <div class="footer">
        <button class="cancel" @click=${this.cancel}>Cancel</button>
        <button class="save" ?disabled=${!this.isValid()} @click=${this.save}>Save</button>
      </div>
    `;
  }
}
