import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import { newConfig, type StoredDittoConfig, type SecretSet } from '../models/DittoConfig.js';
import type { EditorIn, EditorOut, LogIn, LogOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';

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
    private readonly context: vscode.ExtensionContext,
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
      const err = validate(msg.config, msg.secrets);
      if (err) {
        this.post({ type: 'editor.validationError', message: err });
        return;
      }
      await this.configs.save(msg.config);
      await this.secrets.write(msg.config.id, msg.secrets);
      vscode.window.showInformationMessage(`Saved connection "${msg.config.name}".`);
      this.panel.dispose();
    }
  }

  private dispose() {
    DatabaseEditorPanel.current = undefined;
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function validate(config: StoredDittoConfig, secrets: SecretSet): string | null {
  if (!config.name.trim()) { return 'Name is required.'; }
  if (!config.databaseId.trim()) { return 'Database ID is required.'; }
  if (!secrets.token.trim()) { return 'Token is required.'; }
  if (config.mode === 'server' && !config.authUrl.trim()) { return 'URL is required for Server mode.'; }
  if (config.mode === 'server' && !config.websocketUrl.trim()) { return 'Websocket URL is required for Server mode.'; }
  return null;
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
