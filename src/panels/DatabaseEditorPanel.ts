import * as vscode from 'vscode';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import { validateHttpApiUrl } from '../ditto/HttpQueryService.js';
import { randomId } from '../util/id.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import { newConfig, type StoredDittoConfig, type SecretSet } from '../models/DittoConfig.js';
import type { EditorIn, EditorOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import {
  normalizeCollectionSyncScopes,
  validateCollectionSyncScopes,
} from '../ditto/sync-scopes.js';
import {
  normalizeSystemSettings,
  systemSettingsEqual,
  validateSystemSettings,
} from '../ditto/system-settings.js';
import { assertEditorSaveIsCurrent, saveConnectionAtomically } from './save-connection.js';
import {
  isConnectionPersistenceBusy,
  withConnectionPersistenceLock,
} from '../storage/connection-persistence-lock.js';

export class DatabaseEditorPanel {
  private static current: DatabaseEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    secrets: SecretStore,
    logger: Logger,
    manager: DittoManager,
    existing?: StoredDittoConfig,
  ) {
    if (isConnectionPersistenceBusy() && !DatabaseEditorPanel.current) {
      void vscode.window.showInformationMessage('Connection storage is currently being updated. Try again in a moment.');
      return;
    }
    if (DatabaseEditorPanel.current) {
      DatabaseEditorPanel.current.panel.reveal();
      // init() is async — a bare call drops the rejection, so a failed
      // re-init would leave the reopened editor showing the previous
      // connection's values with nothing logged.
      void DatabaseEditorPanel.current.init(existing).catch((err: unknown) => {
        logger.warn('Database editor re-init failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }
    DatabaseEditorPanel.current = new DatabaseEditorPanel(context, configs, secrets, logger, manager, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private initGeneration = 0;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private saving = false;
  private editingExisting = false;
  private expectedConfigId: string | null = null;
  private baselineConfig: StoredDittoConfig | undefined;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configs: ConfigStore,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
    private readonly manager: DittoManager,
    existing?: StoredDittoConfig,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoDatabaseEditor',
      existing ? `Edit Database — ${existing.name}` : 'Register Database',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')]
      }
    );

    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'editor.js')
    );
    this.panel.webview.html = panelHtml({
      title: existing ? 'Edit Database' : 'Register Database',
      scriptUri,
      cspSource: this.panel.webview.cspSource
    });

    // Route through the shared error-surfacing wrapper like every other
    // panel — this is the credentials editor, the worst place for a
    // rejection to be swallowed with nothing logged and nothing shown.
    // `handle` keeps its own malformed-message validation (it consumes
    // `unknown` deliberately).
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<EditorIn>(
        this.logger, 'ext:dbEditor', 'Database editor action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    this.disposables.push(this.manager.onLifecycleStateChange(() => {
      if (this.expectedConfigId) {
        this.post({
          type: 'editor.activeConnectionChanged',
          isActiveConnection: this.manager.getActiveConfigId() === this.expectedConfigId,
        });
      }
    }));

    // Send init payload after the webview script has had a chance to register its listener.
    this.initTimer = setTimeout(() => {
      this.initTimer = undefined;
      void this.init(existing);
    }, 50);
  }

  private async init(existing?: StoredDittoConfig) {
    const generation = ++this.initGeneration;
    const config = existing
      ? this.configs.get(existing.id) ?? existing
      : { ...newConfig(), id: randomId(16) };
    let secrets: SecretSet;
    try {
      secrets = existing ? await this.secrets.read(existing.id) : { token: '' };
    } catch {
      if (!this.disposed && generation === this.initGeneration) {
        this.post({
          type: 'editor.initError',
          message: 'Connection credentials could not be loaded. Close and reopen the editor to retry.',
        });
      }
      return;
    }
    if (this.disposed || generation !== this.initGeneration) { return; }
    this.editingExisting = existing !== undefined;
    this.expectedConfigId = config.id;
    this.baselineConfig = existing ? structuredClone(config) : undefined;
    const isActiveConnection = existing !== undefined
      && this.manager.getActiveConfigId() === config.id;
    this.post({ type: 'editor.init', config, secrets, isActiveConnection });
    if (isActiveConnection) {
      try {
        const options = await this.manager.getSystemSettingOptions(config.id);
        if (this.disposed || generation !== this.initGeneration) { return; }
        this.post({ type: 'editor.systemSettingsLoaded', options });
      } catch (error) {
        if (this.disposed || generation !== this.initGeneration) { return; }
        this.post({
          type: 'editor.systemSettingsLoadError',
          message: 'The current system settings could not be loaded. You can still enter a parameter manually.',
        });
      }
    }
  }

  private post(msg: EditorOut) {
    if (this.disposed) { return; }
    void this.panel.webview.postMessage(msg).then(
      delivered => {
        if (!delivered && !this.disposed) {
          this.logger.warn('Database editor message was not delivered', { type: msg.type });
        }
      },
      () => {
        if (!this.disposed) {
          this.logger.warn('Database editor message delivery failed', { type: msg.type });
        }
      },
    );
  }

  private async handle(raw: unknown) {
    if (this.disposed) { return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as { type?: unknown }).type !== 'string') {
      this.logger.warn('Ignored malformed database editor message');
      return;
    }
    const messageType = (raw as { type: string }).type;
    const msg = raw as EditorIn;
    if (msg.type === 'editor.cancel') {
      this.panel.dispose();
      return;
    }
    if (msg.type === 'editor.save') {
      if (!msg.config || typeof msg.config !== 'object'
        || !msg.secrets || typeof msg.secrets !== 'object') {
        this.logger.warn('Ignored malformed database editor save message');
        return;
      }
      if (!this.expectedConfigId || msg.config.id !== this.expectedConfigId) {
        this.post({ type: 'editor.validationError', message: 'Connection identity changed unexpectedly. Close and reopen the editor.' });
        return;
      }
      if (this.saving) { return; }
      const err = validate(msg.config, msg.secrets, this.configs.list());
      if (err) {
        this.post({ type: 'editor.validationError', message: err.message, field: err.field });
        return;
      }
      const scopes = normalizeCollectionSyncScopes(
        msg.config.advancedConfig?.collectionSyncScopes,
      );
      const systemSettings = normalizeSystemSettings(
        msg.config.advancedConfig?.systemSettings,
      );
      const previousSettings = normalizeSystemSettings(
        this.configs.get(msg.config.id)?.advancedConfig?.systemSettings,
      );
      const reconnectRequired = this.manager.getActiveConfigId() === msg.config.id
        && !systemSettingsEqual(previousSettings, systemSettings);
      const normalizedConfig: StoredDittoConfig = {
        ...msg.config,
        advancedConfig: {
          ...msg.config.advancedConfig,
          collectionSyncScopes: scopes,
          systemSettings,
        },
      };
      this.saving = true;
      try {
        // Once persistence starts, finish or compensate both stores even if
        // the panel closes. Closing suppresses feedback, not consistency work.
        await withConnectionPersistenceLock(async () => {
          assertEditorSaveIsCurrent({
            expectedId: this.expectedConfigId!,
            incomingId: normalizedConfig.id,
            editingExisting: this.editingExisting,
            baseline: this.baselineConfig,
            current: this.configs.get(normalizedConfig.id),
          });
          await saveConnectionAtomically(this.configs, this.secrets, normalizedConfig, msg.secrets);
        });
      } catch (saveErr) {
        this.saving = false;
        // Surface store-level invariant failures (e.g. duplicate databaseId
        // racing in via parallel writes) the same way as form validation.
        this.post({
          type: 'editor.validationError',
          message: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
        return;
      }
      if (this.disposed) { return; }
      if (reconnectRequired) {
        vscode.window.showWarningMessage(
          `Startup settings saved. Disconnect and reconnect "${normalizedConfig.name}" to apply them.`,
        );
      } else {
        vscode.window.showInformationMessage(`Saved connection "${normalizedConfig.name}".`);
      }
      this.panel.dispose();
      return;
    }
    this.logger.warn('Ignored unknown database editor message', { type: messageType });
  }

  private dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    this.initGeneration++;
    if (this.initTimer !== undefined) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    DatabaseEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }
}

interface ValidationFailure {
  message: string;
  field?: 'advancedConfig';
}

function validate(
  config: StoredDittoConfig,
  secrets: SecretSet,
  existingConfigs: StoredDittoConfig[],
): ValidationFailure | null {
  if (typeof config.name !== 'string'
    || typeof config.databaseId !== 'string'
    || !['server', 'smallPeersOnly'].includes(config.mode)
    || typeof config.authUrl !== 'string'
    || typeof config.httpApiUrl !== 'string'
    || (config.websocketUrl !== undefined && typeof config.websocketUrl !== 'string')
    || typeof config.allowUntrustedCerts !== 'boolean'
    || !['error', 'warning', 'info', 'debug', 'verbose'].includes(config.logLevel)
    || typeof config.isStrictModeEnabled !== 'boolean'
    || (config.isLanEnabled !== undefined && typeof config.isLanEnabled !== 'boolean')
    || (config.isBluetoothLeEnabled !== undefined && typeof config.isBluetoothLeEnabled !== 'boolean')
    || (config.isAwdlEnabled !== undefined && typeof config.isAwdlEnabled !== 'boolean')
    || typeof secrets.token !== 'string'
    || (secrets.secretKey !== undefined && typeof secrets.secretKey !== 'string')
    || (secrets.httpApiKey !== undefined && typeof secrets.httpApiKey !== 'string')) {
    return { message: 'Connection data is malformed.' };
  }
  if (!config.name.trim()) { return { message: 'Name is required.' }; }
  const dbId = config.databaseId.trim();
  if (!dbId) { return { message: 'Database ID is required.' }; }
  // Block duplicate databaseIds before they reach the store. Two connections
  // pointing at the same Ditto database can race for the working-directory
  // lock and confuse users about which local store they're looking at.
  const conflict = existingConfigs.find(c => c.id !== config.id && c.databaseId.trim() === dbId);
  if (conflict) {
    return { message: `Database ID "${dbId}" is already used by connection "${conflict.name}". Each connection must use a unique Database ID.` };
  }
  if (!secrets.token.trim()) { return { message: 'Token is required.' }; }
  if (config.mode === 'server' && !config.authUrl.trim()) { return { message: 'URL is required for Server mode.' }; }
  // Both URLs are glued into `https://${value}` later with the bearer key
  // attached — a `good.com@evil.com`-style value would send the credential
  // to the wrong host. The validator refuses `@`, credentials-in-URL user
  // info, and anything that doesn't parse as scheme-less host[:port][/path].
  const authUrlError = validateHttpApiUrl(config.authUrl);
  if (authUrlError) { return { message: `Auth URL: ${authUrlError}` }; }
  const httpApiUrlError = validateHttpApiUrl(config.httpApiUrl);
  if (httpApiUrlError) { return { message: `HTTP API URL: ${httpApiUrlError}` }; }
  const advanced = config.advancedConfig as unknown;
  if (advanced !== undefined && (
    !advanced || typeof advanced !== 'object' || Array.isArray(advanced)
  )) {
    return { message: 'Advanced configuration is invalid.', field: 'advancedConfig' };
  }
  const syncScopeError = validateCollectionSyncScopes(
    config.advancedConfig?.collectionSyncScopes,
  );
  if (syncScopeError) { return { message: syncScopeError, field: 'advancedConfig' }; }
  const systemSettingsError = validateSystemSettings(
    config.advancedConfig?.systemSettings,
  );
  if (systemSettingsError) {
    return { message: systemSettingsError, field: 'advancedConfig' };
  }
  return null;
}
