import * as vscode from 'vscode';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { Logger } from '../logging/types.js';
import type { WelcomeIn, WelcomeOut } from '../ipc/messages.js';

/**
 * First-run onboarding panel: opens automatically when the user has
 * no databases configured (and on demand via `dittoVsce.openWelcome`).
 *
 *   - Introduces Ditto and the extension's capabilities at a glance
 *   - Links out to the public docs (Portal sign-up, app creation, the
 *     "About Ditto" primer) so the user knows where to get an SDK
 *     auth URL + token before they hit the Register dialog
 *   - Wires a "Register Database…" button straight to the existing
 *     dittoVsce.registerDatabase command so a brand-new user has one
 *     visible CTA rather than scrolling for a tree-view + symbol
 *
 * Singleton — re-`show()` reveals the existing panel instead of
 * spawning a second one. Auto-closes itself if the user successfully
 * saves a database (configStore goes from 0 → ≥1) so the onboarding
 * doesn't linger behind the freshly-opened Register editor.
 */
export class WelcomePanel {
  private static current: WelcomePanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    logger: Logger,
  ): void {
    if (WelcomePanel.current) {
      WelcomePanel.current.panel.reveal();
      WelcomePanel.current.postInit();
      return;
    }
    WelcomePanel.current = new WelcomePanel(context, configStore, logger);
  }

  /** Called by the switch/disconnect plumbing; harmless when no panel is open. */
  static dispose(): void {
    WelcomePanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Installed extension version, shown in the panel footer so the user
   *  can tell which build they are running without opening the
   *  Extensions view. Read from the manifest rather than hardcoded so
   *  it can never drift from `package.json`. */
  private readonly version: string;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore,
    private readonly logger: Logger,
  ) {
    this.version =
      (context.extension?.packageJSON as { version?: unknown } | undefined)?.version as string | undefined
      ?? '0.0.0';
    this.panel = vscode.window.createWebviewPanel(
      'dittoWelcome',
      'Welcome to Ditto',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The Welcome panel is cheap to rebuild but the user might tab
        // away to follow a doc link and tab back; keep state so the
        // scroll position survives.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };

    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'welcome.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Welcome to Ditto',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<WelcomeIn>(
        this.logger, 'ext:welcome', 'Welcome action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Auto-close once the user has saved their first database. We
    // listen on the global configStore so this fires whether the new
    // connection was added from the Register button on the welcome
    // panel itself OR from another path (tree title-bar + button,
    // direct command, etc.) — the welcome screen's job is done either
    // way.
    const initialCount = this.configStore.list().length;
    const cfgSub = this.configStore.onDidChange(() => {
      if (initialCount === 0 && this.configStore.list().length > 0) {
        this.logger.withTag('ext:Welcome').info('First database registered — closing welcome panel');
        this.panel.dispose();
      }
    });
    this.panel.onDidDispose(() => cfgSub.dispose(), null, this.disposables);

    // Defensive setTimeout — webview script needs a tick to register
    // its message listener before init lands. Same race the other
    // panels work around.
    setTimeout(() => { this.postInit(); }, 50);
  }

  private post(msg: WelcomeOut): void {
    void this.panel.webview.postMessage(msg);
  }

  private postInit(): void {
    this.post({
      type: 'welcome.init',
      hasExistingDatabases: this.configStore.list().length > 0,
      version: this.version,
    });
  }

  private async handle(msg: WelcomeIn): Promise<void> {
    switch (msg.type) {
      case 'welcome.registerDatabase':
        // Fan out to the existing command — keeps the Register flow
        // single-sourced. The DatabaseEditorPanel.show() handler is
        // responsible for actually opening the editor.
        await vscode.commands.executeCommand('dittoVsce.registerDatabase');
        return;
      case 'welcome.getQuickstarts':
        // Fan out to the quickstarts command — keeps the entry point
        // single-sourced with the Help-menu tree entry.
        await vscode.commands.executeCommand('dittoVsce.getQuickstarts');
        return;
      case 'welcome.close':
        this.panel.dispose();
        return;
    }
  }

  private dispose(): void {
    if (WelcomePanel.current === this) {
      WelcomePanel.current = undefined;
    }
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
