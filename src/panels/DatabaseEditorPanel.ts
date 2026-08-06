import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import { newConfig, type StoredDittoConfig, type SecretSet } from '../models/DittoConfig.js';
import type { EditorIn, EditorOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import {
  normalizeCollectionSyncScopes,
  validateCollectionSyncScopes,
} from '../ditto/sync-scopes.js';

export class DatabaseEditorPanel {
  private static current: DatabaseEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configs: ConfigStore,
    secrets: SecretStore,
    logger: Logger,
    existing?: StoredDittoConfig,
  ) {
    if (DatabaseEditorPanel.current) {
      DatabaseEditorPanel.current.panel.reveal();
      DatabaseEditorPanel.current.init(existing);
      return;
    }
    DatabaseEditorPanel.current = new DatabaseEditorPanel(context, configs, secrets, logger, existing);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configs: ConfigStore,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
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

    this.panel.webview.onDidReceiveMessage((msg: EditorIn | LogIn) => this.handle(msg), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Push initial channel level to webview.
    this.panel.webview.postMessage({ type: 'log.levelChanged', level: logger.getChannelLevel() } satisfies LogOut);

    // Subscribe to level changes; track disposable so we can clean up.
    const levelSub = logger.onDidChangeChannelLevel((level) => {
      this.panel.webview.postMessage({ type: 'log.levelChanged', level } satisfies LogOut);
    });
    this.panel.onDidDispose(() => levelSub.dispose(), null, this.disposables);

    // Send init payload after the webview script has had a chance to register its listener.
    setTimeout(() => this.init(existing), 50);
  }

  private async init(existing?: StoredDittoConfig) {
    const config = existing ?? { ...newConfig(), id: cryptoRandomId() };
    const secrets: SecretSet = existing
      ? await this.secrets.read(existing.id)
      : { token: '' };
    this.post({ type: 'editor.init', config, secrets });
  }

  private post(msg: EditorOut) { this.panel.webview.postMessage(msg); }

  private async handle(msg: EditorIn | LogIn) {
    if (msg.type === 'log') {
      const wlog = this.logger.withTag('webview:dittoDatabaseEditor');
      wlog[msg.level](msg.message, msg.ctx);
      return;
    }
    if (msg.type === 'editor.cancel') {
      this.panel.dispose();
      return;
    }
    if (msg.type === 'editor.save') {
      const err = validate(msg.config, msg.secrets, this.configs.list());
      if (err) {
        this.post({ type: 'editor.validationError', message: err.message, field: err.field });
        return;
      }
      const scopes = normalizeCollectionSyncScopes(
        msg.config.advancedConfig?.collectionSyncScopes,
      );
      const normalizedConfig: StoredDittoConfig = {
        ...msg.config,
        advancedConfig: {
          ...msg.config.advancedConfig,
          collectionSyncScopes: scopes,
        },
      };
      try {
        await this.configs.save(normalizedConfig);
      } catch (saveErr) {
        // Surface store-level invariant failures (e.g. duplicate databaseId
        // racing in via parallel writes) the same way as form validation.
        this.post({
          type: 'editor.validationError',
          message: saveErr instanceof Error ? saveErr.message : String(saveErr),
        });
        return;
      }
      await this.secrets.write(normalizedConfig.id, msg.secrets);
      vscode.window.showInformationMessage(`Saved connection "${normalizedConfig.name}".`);
      this.panel.dispose();
    }
  }

  private dispose() {
    DatabaseEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
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
  return null;
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
