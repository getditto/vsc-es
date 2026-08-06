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
  advancedConfig?: {
    collectionSyncScopes?: CollectionSyncScopeEntry[];
    systemSettings?: SystemSetting[];
  };
}

interface CollectionSyncScopeEntry { collection: string; scope: string; }
type SystemSettingType = 'boolean' | 'integer' | 'string' | 'json';
interface SystemSetting { parameter: string; type: SystemSettingType; value: unknown; }
interface SystemSettingOption extends SystemSetting {}
const COLLECTION_SYNC_SCOPES = new Set<string>([
  'AllPeers', 'BigPeerOnly', 'SmallPeersOnly', 'LocalPeerOnly',
]);

interface SecretSet { token: string; secretKey?: string; httpApiKey?: string; }

type In =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet; isActiveConnection: boolean }
  | { type: 'editor.initError'; message: string }
  | { type: 'editor.activeConnectionChanged'; isActiveConnection: boolean }
  | { type: 'editor.systemSettingsLoaded'; options: SystemSettingOption[] }
  | { type: 'editor.systemSettingsLoadError'; message: string }
  | { type: 'editor.validationError'; message: string; field?: 'advancedConfig' };

@customElement('ditto-database-editor')
export class DatabaseEditor extends LitElement {
  @state() private config: StoredDittoConfig | null = null;
  @state() private secrets: SecretSet = { token: '' };
  @state() private validationError: string | null = null;
  @state() private advancedOpen = false;
  @state() private isActiveConnection = false;
  @state() private systemSettingOptions: SystemSettingOption[] = [];
  @state() private systemSettingsLoadError: string | null = null;
  @state() private jsonDrafts: Record<number, string> = {};
  @state() private integerDrafts: Record<number, string> = {};
  @state() private initError: string | null = null;
  @state() private saving = false;
  private initialSystemSettings: SystemSetting[] = [];

  static styles = css`
    :host { display: block; padding: 24px; max-width: 720px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    h2 { margin-top: 32px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    label { display: block; margin: 12px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    input[type=text], input[type=password], input[type=number], select, textarea {
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
    details.advanced { margin-top: 28px; border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); }
    details.advanced > summary { padding: 12px 0; cursor: pointer; font-weight: 600; }
    details.advanced > summary::marker { color: var(--vscode-descriptionForeground); }
    .scope-count { float: right; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: normal; }
    .advanced-content { padding-bottom: 20px; }
    .advanced-content h2:first-child { margin-top: 12px; }
    .scope-list { display: grid; gap: 8px; margin-top: 12px; }
    .scope-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(170px, 0.8fr) auto; gap: 8px; align-items: end; }
    .scope-field label { margin-top: 0; }
    .scope-remove { padding: 6px 10px; border: none; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .add-scope { margin-top: 12px; padding: 6px 12px; border: none; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .scope-error { color: var(--vscode-inputValidation-errorForeground); font-size: 11px; margin-top: 8px; }
    .scope-help { margin: 10px 0 0 18px; padding: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .scope-help li { margin: 3px 0; }
    .setting-list { display: grid; gap: 8px; margin-top: 12px; }
    .setting-row { display: grid; grid-template-columns: minmax(190px, 1.4fr) minmax(105px, 0.55fr) minmax(150px, 1fr) auto; gap: 8px; align-items: end; }
    .setting-field label { margin-top: 0; }
    .setting-remove { padding: 6px 10px; border: none; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .setting-warning { color: var(--vscode-editorWarning-foreground); border-left: 3px solid var(--vscode-editorWarning-foreground); padding: 8px 12px; margin-top: 12px; }
    .setting-warning strong { display: block; margin-bottom: 4px; }
    .setting-error { color: var(--vscode-inputValidation-errorForeground); font-size: 11px; margin-top: 8px; }
    .change-summary { margin-top: 4px; font-size: 11px; }
    @media (max-width: 520px) {
      :host { padding: 16px; }
      .scope-row, .setting-row { grid-template-columns: 1fr; }
      .scope-remove, .setting-remove { justify-self: start; }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'editor.init') {
        this.config = msg.config;
        this.secrets = msg.secrets;
        this.isActiveConnection = msg.isActiveConnection;
        this.initialSystemSettings = structuredClone(this.systemSettings());
        this.systemSettingOptions = [];
        this.systemSettingsLoadError = null;
        this.jsonDrafts = {};
        this.integerDrafts = {};
        this.saving = false;
        this.initError = null;
        this.advancedOpen = this.scopeError() !== null || this.systemSettingsError() !== null;
      }
      if (msg.type === 'editor.initError') { this.initError = msg.message; }
      if (msg.type === 'editor.activeConnectionChanged') {
        this.isActiveConnection = msg.isActiveConnection;
      }
      if (msg.type === 'editor.systemSettingsLoaded') {
        this.systemSettingOptions = msg.options;
      }
      if (msg.type === 'editor.systemSettingsLoadError') {
        this.systemSettingsLoadError = msg.message;
      }
        if (msg.type === 'editor.validationError') {
          this.saving = false;
          this.validationError = msg.message;
        if (msg.field === 'advancedConfig') { this.advancedOpen = true; }
      }
    });
  }

  private update_(field: keyof StoredDittoConfig, value: any) {
    if (!this.config) { return; }
    this.config = { ...this.config, [field]: value };
  }

  private updateSecret(field: keyof SecretSet, value: string) {
    this.secrets = { ...this.secrets, [field]: value };
  }

  private scopes(): CollectionSyncScopeEntry[] {
    const raw = this.config?.advancedConfig?.collectionSyncScopes as unknown;
    if (!Array.isArray(raw)) { return []; }
    return raw.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { collection: '', scope: '' };
      }
      const candidate = entry as Record<string, unknown>;
      return {
        collection: typeof candidate.collection === 'string' ? candidate.collection : '',
        scope: typeof candidate.scope === 'string' ? candidate.scope : '',
      };
    });
  }

  private setScopes(collectionSyncScopes: CollectionSyncScopeEntry[]) {
    if (!this.config) { return; }
    this.config = {
      ...this.config,
      advancedConfig: { ...this.config.advancedConfig, collectionSyncScopes },
    };
    this.validationError = null;
  }

  private addScope() {
    this.advancedOpen = true;
    this.setScopes([...this.scopes(), { collection: '', scope: 'AllPeers' }]);
  }

  private updateScope(index: number, patch: Partial<CollectionSyncScopeEntry>) {
    this.setScopes(this.scopes().map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  }

  private removeScope(index: number) {
    this.setScopes(this.scopes().filter((_, i) => i !== index));
  }

  private systemSettings(): SystemSetting[] {
    const raw = this.config?.advancedConfig?.systemSettings as unknown;
    if (!Array.isArray(raw)) { return []; }
    return raw.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { parameter: '', type: 'string', value: '' };
      }
      const candidate = entry as Record<string, unknown>;
      const type = ['boolean', 'integer', 'string', 'json'].includes(String(candidate.type))
        ? candidate.type as SystemSettingType
        : 'string';
      return {
        parameter: typeof candidate.parameter === 'string' ? candidate.parameter : '',
        type,
        value: candidate.value,
      };
    });
  }

  private setSystemSettings(systemSettings: SystemSetting[]) {
    if (!this.config) { return; }
    this.config = {
      ...this.config,
      advancedConfig: { ...this.config.advancedConfig, systemSettings },
    };
    this.validationError = null;
  }

  private addSystemSetting() {
    this.advancedOpen = true;
    const configured = new Set(this.systemSettings().map(entry => entry.parameter.trim().toUpperCase()));
    const option = this.systemSettingOptions.find(entry => !configured.has(entry.parameter));
    this.setSystemSettings([
      ...this.systemSettings(),
      option ? structuredClone(option) : { parameter: '', type: 'string', value: '' },
    ]);
  }

  private updateSystemSetting(index: number, patch: Partial<SystemSetting>) {
    this.setSystemSettings(this.systemSettings().map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  }

  private selectSystemSetting(index: number, parameter: string) {
    const option = this.systemSettingOptions.find(entry => entry.parameter === parameter);
    this.clearSettingDrafts(index);
    this.updateSystemSetting(index, option ? structuredClone(option) : { parameter });
  }

  private changeSystemSettingType(index: number, type: SystemSettingType) {
    const defaults: Record<SystemSettingType, unknown> = {
      boolean: false, integer: 0, string: '', json: {},
    };
    this.clearSettingDrafts(index);
    this.updateSystemSetting(index, { type, value: defaults[type] });
  }

  private removeSystemSetting(index: number) {
    this.jsonDrafts = Object.fromEntries(
      Object.entries(this.jsonDrafts)
        .filter(([draftIndex]) => Number(draftIndex) !== index)
        .map(([draftIndex, draft]) => {
          const numericIndex = Number(draftIndex);
          return [numericIndex > index ? numericIndex - 1 : numericIndex, draft];
        }),
    );
    this.integerDrafts = this.reindexDraftsAfterRemoval(this.integerDrafts, index);
    this.setSystemSettings(this.systemSettings().filter((_, i) => i !== index));
  }

  private reindexDraftsAfterRemoval(drafts: Record<number, string>, index: number): Record<number, string> {
    return Object.fromEntries(
      Object.entries(drafts)
        .filter(([draftIndex]) => Number(draftIndex) !== index)
        .map(([draftIndex, draft]) => {
          const numericIndex = Number(draftIndex);
          return [numericIndex > index ? numericIndex - 1 : numericIndex, draft];
        }),
    );
  }

  private clearJsonDraft(index: number) {
    const { [index]: _removed, ...remaining } = this.jsonDrafts;
    this.jsonDrafts = remaining;
  }

  private clearIntegerDraft(index: number) {
    const { [index]: _removed, ...remaining } = this.integerDrafts;
    this.integerDrafts = remaining;
  }

  private clearSettingDrafts(index: number) {
    this.clearJsonDraft(index);
    this.clearIntegerDraft(index);
  }

  private updateIntegerSetting(index: number, text: string) {
    const value = Number(text);
    if (!text.trim() || !Number.isSafeInteger(value)) {
      this.integerDrafts = { ...this.integerDrafts, [index]: text };
      return;
    }
    this.clearIntegerDraft(index);
    this.updateSystemSetting(index, { value });
  }

  private availableSystemSettingOptions(index: number): SystemSettingOption[] {
    const configuredElsewhere = new Set(
      this.systemSettings()
        .filter((_, settingIndex) => settingIndex !== index)
        .map(entry => entry.parameter.trim().toUpperCase()),
    );
    return this.systemSettingOptions.filter(option => !configuredElsewhere.has(option.parameter));
  }

  private updateJsonSetting(index: number, text: string) {
    try {
      const value = JSON.parse(text);
      this.clearJsonDraft(index);
      this.updateSystemSetting(index, { value });
    } catch {
      this.jsonDrafts = { ...this.jsonDrafts, [index]: text };
    }
  }

  private systemSettingsError(): string | null {
    const raw = this.config?.advancedConfig?.systemSettings as unknown;
    if (raw !== undefined && !Array.isArray(raw)) { return 'Startup system settings must be a list.'; }
    const seen = new Set<string>();
    if (Object.keys(this.jsonDrafts).length > 0) { return 'Enter valid JSON for every JSON startup setting.'; }
    if (Object.keys(this.integerDrafts).length > 0) { return 'Enter a safe integer for every integer startup setting.'; }
    for (const entry of this.systemSettings()) {
      const parameter = entry.parameter.trim().toUpperCase();
      if (!parameter) { return 'Enter a parameter name for every startup setting.'; }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(parameter)) { return `Parameter “${entry.parameter}” has an invalid name.`; }
      if (parameter === 'USER_COLLECTION_SYNC_SCOPES' || parameter === 'DQL_STRICT_MODE') {
        return `Parameter “${parameter}” is managed by a dedicated control.`;
      }
      if (seen.has(parameter)) { return `Parameter “${parameter}” is configured more than once.`; }
      seen.add(parameter);
      if (entry.type === 'integer' && !Number.isSafeInteger(entry.value)) {
        return `Parameter “${parameter}” must be an integer.`;
      }
      if (entry.type === 'boolean' && typeof entry.value !== 'boolean') {
        return `Parameter “${parameter}” must be true or false.`;
      }
      if (entry.type === 'string' && typeof entry.value !== 'string') {
        return `Parameter “${parameter}” must be text.`;
      }
      if (entry.type === 'json' && !this.isJsonValue(entry.value)) {
        return `Parameter “${parameter}” must contain valid JSON.`;
      }
    }
    return null;
  }

  private settingChanges() {
    const key = (entry: SystemSetting) => entry.parameter.trim().toUpperCase();
    const initial = new Map(this.initialSystemSettings.map(entry => [key(entry), entry]));
    const current = new Map(this.systemSettings().map(entry => [key(entry), entry]));
    let added = 0; let removed = 0; let changed = 0;
    for (const [parameter, entry] of current) {
      if (!initial.has(parameter)) { added++; }
      else if (!this.systemSettingEqual(initial.get(parameter)!, entry)) { changed++; }
    }
    for (const parameter of initial.keys()) { if (!current.has(parameter)) { removed++; } }
    return { added, removed, changed, total: added + removed + changed };
  }

  private systemSettingEqual(left: SystemSetting, right: SystemSetting): boolean {
    const normalize = (entry: SystemSetting) => ({
      ...entry,
      parameter: entry.parameter.trim().toUpperCase(),
    });
    return this.stableJson(normalize(left)) === this.stableJson(normalize(right));
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) { return `[${value.map(entry => this.stableJson(entry)).join(',')}]`; }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${this.stableJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private isJsonValue(value: unknown): boolean {
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    const seen = new WeakSet<object>();
    let visited = 0;
    let textUnits = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (++visited > 10_000 || current.depth > 64) { return false; }
      const candidate = current.value;
      if (candidate === null || typeof candidate === 'boolean') { continue; }
      if (typeof candidate === 'string') {
        textUnits += candidate.length;
        if (textUnits > 1_000_000) { return false; }
        continue;
      }
      if (typeof candidate === 'number') {
        if (!Number.isFinite(candidate)) { return false; }
        continue;
      }
      if (typeof candidate !== 'object' || seen.has(candidate)) { return false; }
      seen.add(candidate);
      if (Array.isArray(candidate)) {
        for (const entry of candidate) { pending.push({ value: entry, depth: current.depth + 1 }); }
        continue;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) { return false; }
      for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
        textUnits += key.length;
        if (textUnits > 1_000_000) { return false; }
        pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
    return true;
  }

  private settingParameterInvalid(index: number): boolean {
    const entries = this.systemSettings();
    const entry = entries[index];
    if (!entry) { return false; }
    const parameter = entry.parameter.trim().toUpperCase();
    return !parameter
      || !/^[A-Z_][A-Z0-9_]*$/.test(parameter)
      || parameter === 'USER_COLLECTION_SYNC_SCOPES'
      || parameter === 'DQL_STRICT_MODE'
      || entries.some((other, otherIndex) =>
        otherIndex !== index && other.parameter.trim().toUpperCase() === parameter,
      );
  }

  private settingValueInvalid(index: number): boolean {
    const entry = this.systemSettings()[index];
    if (!entry) { return false; }
    if (index in this.jsonDrafts || index in this.integerDrafts) { return true; }
    if (entry.type === 'integer') { return !Number.isSafeInteger(entry.value); }
    if (entry.type === 'boolean') { return typeof entry.value !== 'boolean'; }
    if (entry.type === 'string') { return typeof entry.value !== 'string'; }
    return !this.isJsonValue(entry.value);
  }

  private scopeError(): string | null {
    const raw = this.config?.advancedConfig?.collectionSyncScopes as unknown;
    if (raw !== undefined && !Array.isArray(raw)) {
      return 'Collection sync scopes must be a list.';
    }
    const seen = new Set<string>();
    for (const entry of this.scopes()) {
      const name = entry.collection.trim();
      if (!name) { return 'Enter a collection name for every scope.'; }
      if (name.startsWith('__')) { return 'System collections beginning with “__” cannot be scoped.'; }
      if (seen.has(name)) { return `Collection “${name}” is listed more than once.`; }
      if (!COLLECTION_SYNC_SCOPES.has(entry.scope)) {
        return `Collection “${name}” has an unsupported sync scope.`;
      }
      seen.add(name);
    }
    return null;
  }

  private scopeEntryInvalid(index: number): boolean {
    const entries = this.scopes();
    const entry = entries[index];
    if (!entry || !entry.collection.trim() || entry.collection.trim().startsWith('__')) { return true; }
    if (!COLLECTION_SYNC_SCOPES.has(entry.scope)) { return true; }
    return entries.some((other, otherIndex) =>
      otherIndex !== index && other.collection.trim() === entry.collection.trim(),
    );
  }

  private isValid(): boolean {
    const c = this.config;
    if (!c) { return false; }
    if (!c.name.trim() || !c.databaseId.trim() || !this.secrets.token.trim()) { return false; }
    if (c.mode === 'server' && !c.authUrl.trim()) { return false; }
    return this.scopeError() === null && this.systemSettingsError() === null;
  }

  private save() {
    if (!this.config || this.saving) { return; }
    const scopeError = this.scopeError();
    const systemSettingsError = this.systemSettingsError();
    if (scopeError || systemSettingsError) {
      this.validationError = scopeError ?? systemSettingsError;
      this.advancedOpen = true;
      return;
    }
    this.saving = true;
    postToHost({ type: 'editor.save', config: this.config, secrets: this.secrets });
  }

  private cancel() { postToHost({ type: 'editor.cancel' }); }

  render() {
    if (!this.config) {
      return this.initError
        ? html`<div class="error-banner" role="alert">${this.initError}</div>
          <div class="footer"><button class="cancel" @click=${this.cancel}>Close</button></div>`
        : html`<p>Loading…</p>`;
    }
    const c = this.config;
    const scopes = this.scopes();
    const scopeError = this.scopeError();
    const systemSettings = this.systemSettings();
    const systemSettingsError = this.systemSettingsError();
    const settingChanges = this.settingChanges();
    const advancedCount = `${scopes.length} ${scopes.length === 1 ? 'scope' : 'scopes'} · ${systemSettings.length} startup ${systemSettings.length === 1 ? 'setting' : 'settings'}`;
    return html`
      ${this.validationError ? html`<div class="error-banner" role="alert">${this.validationError}</div>` : nothing}

      <div class="mode-picker" role="group" aria-label="Authorization mode">
        <button aria-pressed=${c.mode === 'server' ? 'true' : 'false'} class=${c.mode === 'server' ? 'active' : ''} @click=${() => this.update_('mode', 'server')}>Server</button>
        <button aria-pressed=${c.mode === 'smallPeersOnly' ? 'true' : 'false'} class=${c.mode === 'smallPeersOnly' ? 'active' : ''} @click=${() => this.update_('mode', 'smallPeersOnly')}>Small Peers Only</button>
      </div>

      <h2>Basic Information</h2>
      <label for="connection-name">Name</label>
      <input id="connection-name" type="text" .value=${c.name} @input=${(e: Event) => this.update_('name', (e.target as HTMLInputElement).value)} />

      <h2>Authorization Information</h2>
      <label for="database-id">Database ID</label>
      <input id="database-id" type="text" .value=${c.databaseId} @input=${(e: Event) => this.update_('databaseId', (e.target as HTMLInputElement).value.trim())} style="font-family: var(--vscode-editor-font-family)" />

      <label for="connection-token">${c.mode === 'server' ? 'Token' : 'Offline Token'}</label>
      <input id="connection-token" type="password" .value=${this.secrets.token} @input=${(e: Event) => this.updateSecret('token', (e.target as HTMLInputElement).value.trim())} />
      ${c.mode === 'smallPeersOnly' ? html`<div class="help">Required for sync activation in Small Peers Only mode. Obtain from <a href="https://portal.ditto.live">portal.ditto.live</a>.</div>` : nothing}

      ${c.mode === 'server' ? html`
        <h2>Ditto Server (BigPeer) Information</h2>
        <label for="auth-url">URL</label>
        <input id="auth-url" type="text" .value=${c.authUrl} @input=${(e: Event) => this.update_('authUrl', (e.target as HTMLInputElement).value)} />

        <h2>Ditto Server — HTTP API (Optional)</h2>
        <label for="http-api-url">HTTP API URL</label>
        <input id="http-api-url" type="text" .value=${c.httpApiUrl} @input=${(e: Event) => this.update_('httpApiUrl', (e.target as HTMLInputElement).value)} />
        <label for="http-api-key">HTTP API Key</label>
        <input id="http-api-key" type="password" .value=${this.secrets.httpApiKey ?? ''} @input=${(e: Event) => this.updateSecret('httpApiKey', (e.target as HTMLInputElement).value)} />
        <div class="checkbox-row">
          <input type="checkbox" id="cb-untrusted" .checked=${c.allowUntrustedCerts} @change=${(e: Event) => this.update_('allowUntrustedCerts', (e.target as HTMLInputElement).checked)} />
          <label for="cb-untrusted" style="margin: 0">Allow untrusted certificates</label>
        </div>
        <div class="warn">By allowing untrusted certificates, you bypass SSL validation. Use only in development.</div>
      ` : nothing}

      ${c.mode === 'smallPeersOnly' ? html`
        <h2>Optional Shared Secret Key</h2>
        <label for="shared-secret">Shared Secret Key</label>
        <input id="shared-secret" type="password" .value=${this.secrets.secretKey ?? ''} @input=${(e: Event) => this.updateSecret('secretKey', (e.target as HTMLInputElement).value)} />
        <div class="help">Optional secret key for shared key identity encryption. Leave empty if not using Shared Key.</div>
      ` : nothing}

      <details class="advanced" .open=${this.advancedOpen}
        @toggle=${(e: Event) => { this.advancedOpen = (e.currentTarget as HTMLDetailsElement).open; }}>
        <summary>
          Advanced Configuration
          <span class="scope-count">${this.isActiveConnection && settingChanges.total > 0 ? 'Reconnect required' : advancedCount}</span>
        </summary>
        <div class="advanced-content">
          <h2>Collection Sync Scopes</h2>
          <div class="help">Control where each user collection may synchronize. Changes apply the next time this connection starts.</div>

          <div class="scope-list">
            ${scopes.map((entry, index) => html`
              <div class="scope-row">
                <div class="scope-field">
                  <label for=${`scope-collection-${index}`}>Collection</label>
                  <input id=${`scope-collection-${index}`} type="text" .value=${entry.collection}
                    aria-invalid=${this.scopeEntryInvalid(index) ? 'true' : 'false'}
                    aria-describedby=${this.scopeEntryInvalid(index) ? 'scope-error' : nothing}
                    @input=${(e: Event) => this.updateScope(index, { collection: (e.target as HTMLInputElement).value })} />
                </div>
                <div class="scope-field">
                  <label for=${`scope-value-${index}`}>Scope</label>
                  <select id=${`scope-value-${index}`} .value=${entry.scope}
                    aria-invalid=${COLLECTION_SYNC_SCOPES.has(entry.scope) ? 'false' : 'true'}
                    aria-describedby=${COLLECTION_SYNC_SCOPES.has(entry.scope) ? nothing : 'scope-error'}
                    @change=${(e: Event) => this.updateScope(index, { scope: (e.target as HTMLSelectElement).value })}>
                    ${COLLECTION_SYNC_SCOPES.has(entry.scope) ? nothing : html`
                      <option value=${entry.scope}>Unsupported scope (${entry.scope || 'missing'})</option>
                    `}
                    <option value="AllPeers">All Peers</option>
                    <option value="BigPeerOnly">Big Peer Only</option>
                    <option value="SmallPeersOnly">Small Peers Only</option>
                    <option value="LocalPeerOnly">Local Peer Only</option>
                  </select>
                </div>
                <button class="scope-remove" type="button" @click=${() => this.removeScope(index)} aria-label=${`Remove sync scope for ${entry.collection || 'new collection'}`}>Remove</button>
              </div>
            `)}
          </div>
          ${scopeError ? html`<div id="scope-error" class="scope-error" role="alert">${scopeError}</div>` : nothing}
          <button class="add-scope" type="button" @click=${this.addScope}>+ Add collection</button>
          <ul class="scope-help">
            <li><strong>All Peers</strong> — Ditto Server and Small Peers</li>
            <li><strong>Big Peer Only</strong> — Ditto Server only</li>
            <li><strong>Small Peers Only</strong> — Small Peers only</li>
            <li><strong>Local Peer Only</strong> — never leaves this device</li>
          </ul>

          <h2>Startup System Settings</h2>
          <div class="help">Applied after Ditto opens and before sync or subscriptions start.</div>
          ${this.isActiveConnection && settingChanges.total > 0 ? html`
            <div class="setting-warning" role="status" aria-live="polite">
              <strong>⚠ Reconnect required</strong>
              You changed startup settings while “${c.name}” is connected. Save your changes, then disconnect and reconnect to apply them.
              <div class="change-summary">${[
                settingChanges.added ? `${settingChanges.added} added` : '',
                settingChanges.changed ? `${settingChanges.changed} changed` : '',
                settingChanges.removed ? `${settingChanges.removed} removed` : '',
              ].filter(Boolean).join(' · ')}</div>
            </div>
          ` : nothing}
          ${this.systemSettingsLoadError ? html`
            <div class="warn">Current settings could not be loaded: ${this.systemSettingsLoadError}. You can still enter a parameter manually.</div>
          ` : nothing}

          <div class="setting-list">
            ${systemSettings.map((entry, index) => html`
              <div class="setting-row">
                <div class="setting-field">
                  <label for=${`setting-parameter-${index}`}>Parameter</label>
                  ${this.isActiveConnection && this.systemSettingOptions.length > 0 ? html`
                    <select id=${`setting-parameter-${index}`} .value=${entry.parameter.trim().toUpperCase()}
                      aria-invalid=${this.settingParameterInvalid(index) ? 'true' : 'false'}
                      aria-describedby=${this.settingParameterInvalid(index) ? 'setting-error' : nothing}
                      @change=${(e: Event) => this.selectSystemSetting(index, (e.target as HTMLSelectElement).value)}>
                      ${this.availableSystemSettingOptions(index).some(option => option.parameter === entry.parameter.trim().toUpperCase()) ? nothing : html`
                        <option value=${entry.parameter.trim().toUpperCase()}>${entry.parameter || 'Manual parameter'}</option>
                      `}
                      ${this.availableSystemSettingOptions(index).map(option => html`
                        <option value=${option.parameter}>${option.parameter}</option>
                      `)}
                    </select>
                  ` : html`
                    <input id=${`setting-parameter-${index}`} type="text" .value=${entry.parameter}
                      aria-invalid=${this.settingParameterInvalid(index) ? 'true' : 'false'}
                      aria-describedby=${this.settingParameterInvalid(index) ? 'setting-error' : nothing}
                      @input=${(e: Event) => this.updateSystemSetting(index, { parameter: (e.target as HTMLInputElement).value })} />
                  `}
                </div>
                <div class="setting-field">
                  <label for=${`setting-type-${index}`}>Type</label>
                  <select id=${`setting-type-${index}`} .value=${entry.type}
                    ?disabled=${this.isActiveConnection && this.systemSettingOptions.some(option => option.parameter === entry.parameter.trim().toUpperCase())}
                    @change=${(e: Event) => this.changeSystemSettingType(index, (e.target as HTMLSelectElement).value as SystemSettingType)}>
                    <option value="boolean">Boolean</option>
                    <option value="integer">Integer</option>
                    <option value="string">String</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                <div class="setting-field">
                  <label for=${`setting-value-${index}`}>Value</label>
                  ${entry.type === 'boolean' ? html`
                    <select id=${`setting-value-${index}`} .value=${String(entry.value)}
                      aria-invalid=${this.settingValueInvalid(index) ? 'true' : 'false'}
                      aria-describedby=${this.settingValueInvalid(index) ? 'setting-error' : nothing}
                      @change=${(e: Event) => this.updateSystemSetting(index, { value: (e.target as HTMLSelectElement).value === 'true' })}>
                      <option value="true">True</option><option value="false">False</option>
                    </select>
                  ` : entry.type === 'json' ? html`
                    <textarea id=${`setting-value-${index}`} .value=${this.jsonDrafts[index] ?? JSON.stringify(entry.value)}
                      aria-invalid=${this.settingValueInvalid(index) ? 'true' : 'false'}
                      aria-describedby=${this.settingValueInvalid(index) ? 'setting-error' : nothing}
                      @input=${(e: Event) => this.updateJsonSetting(index, (e.target as HTMLTextAreaElement).value)}></textarea>
                  ` : html`
                    <input id=${`setting-value-${index}`} type=${entry.type === 'integer' ? 'number' : 'text'}
                      aria-invalid=${this.settingValueInvalid(index) ? 'true' : 'false'}
                      aria-describedby=${this.settingValueInvalid(index) ? 'setting-error' : nothing}
                      step=${entry.type === 'integer' ? '1' : nothing}
                      .value=${entry.type === 'integer'
                        ? this.integerDrafts[index] ?? String(entry.value ?? '')
                        : String(entry.value ?? '')}
                      @input=${(e: Event) => entry.type === 'integer'
                        ? this.updateIntegerSetting(index, (e.target as HTMLInputElement).value)
                        : this.updateSystemSetting(index, { value: (e.target as HTMLInputElement).value })} />
                  `}
                </div>
                <button class="setting-remove" type="button" @click=${() => this.removeSystemSetting(index)}
                  aria-label=${`Remove startup setting ${entry.parameter || 'new parameter'}`}>Remove</button>
              </div>
            `)}
          </div>
          ${systemSettingsError ? html`<div id="setting-error" class="setting-error" role="alert">${systemSettingsError}</div>` : nothing}
          <button class="add-scope" type="button" @click=${this.addSystemSetting}>+ Add startup setting</button>

          <h2>Developer Options</h2>
          <label for="sdk-log-level">SDK Log Level</label>
          <select id="sdk-log-level" .value=${c.logLevel} @change=${(e: Event) => this.update_('logLevel', (e.target as HTMLSelectElement).value)}>
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
        </div>
      </details>

      <div class="footer">
        <button class="cancel" ?disabled=${this.saving} @click=${this.cancel}>${this.saving ? 'Saving in progress…' : 'Cancel'}</button>
        <button class="save" ?disabled=${!this.isValid() || this.saving} @click=${this.save}>${this.saving ? 'Saving…' : 'Save'}</button>
      </div>
    `;
  }
}
