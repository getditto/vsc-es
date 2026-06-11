import * as vscode from 'vscode';
import { panelHtml } from './webview-utils.js';
import type { PatternStore } from '../logAnalyzer/PatternStore.js';
import type { Logger } from '../logging/types.js';
import type { PatternEditorIn, PatternEditorOut } from '../ipc/messages.js';
import type { InspectorController } from '../inspector/InspectorController.js';

/**
 * Webview wrapper for managing user-defined log analyzer patterns.
 * Bundled patterns are listed read-only. Singleton.
 */
export class PatternEditorPanel {
  private static current: PatternEditorPanel | undefined;

  static show(
    context: vscode.ExtensionContext,
    store: PatternStore,
    logger: Logger,
    inspector: InspectorController,
  ): void {
    if (PatternEditorPanel.current) {
      PatternEditorPanel.current.panel.reveal();
      // Re-assert the active feature on a reveal so the inspector
      // re-renders the patternEditor help even if it had drifted to a
      // different feature in the meantime.
      inspector.setActiveFeature({ kind: 'patternEditor' });
      return;
    }
    PatternEditorPanel.current = new PatternEditorPanel(context, store, logger, inspector);
  }

  static dispose(): void {
    PatternEditorPanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private storeSub: { dispose(): void } | null = null;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly store: PatternStore,
    private readonly logger: Logger,
    private readonly inspector: InspectorController,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoPatternEditor',
      'Log Patterns',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'patternEditor.js'),
    );
    const styleUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'codicon.css'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Log Patterns', scriptUri, styleUri, cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      (m: PatternEditorIn) => { void this.handle(m); }, undefined, this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.storeSub = this.store.onDidChange(() => this.sendSnapshot());

    // Drive the Inspector help into 'patternEditor' mode whenever this
    // panel gains focus so the docs render in the secondary sidebar.
    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({ kind: 'patternEditor' });
        }
      }),
    );
    // Set immediately so the help shows on first open too.
    this.inspector.setActiveFeature({ kind: 'patternEditor' });

    void this.sendSnapshot();
  }

  private sendSnapshot(): void {
    const { bundled, user } = this.store.listAll();
    this.post({ type: 'patternEditor.snapshot', bundled, user });
  }

  private async handle(m: PatternEditorIn): Promise<void> {
    if (m.type === 'patternEditor.save') {
      try {
        if (m.replaceKey) {
          await this.store.update(m.replaceKey, m.pattern);
        } else {
          await this.store.add(m.pattern);
        }
        this.post({ type: 'patternEditor.saveOk', key: m.pattern.key });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn('PatternEditorPanel: save failed', { key: m.pattern.key, message });
        this.post({ type: 'patternEditor.saveFailed', key: m.pattern.key, message });
      }
    } else if (m.type === 'patternEditor.delete') {
      try { await this.store.delete(m.key); }
      catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn('PatternEditorPanel: delete failed', { key: m.key, message });
        this.post({ type: 'patternEditor.saveFailed', key: m.key, message });
      }
    }
  }

  private post(m: PatternEditorOut): void { void this.panel.webview.postMessage(m); }

  private dispose(): void {
    PatternEditorPanel.current = undefined;
    this.storeSub?.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
