import * as vscode from 'vscode';
import * as path from 'node:path';
import { panelHtml, webviewMessageHandler } from './webview-utils.js';
import { DebugSocketClient } from '../ditto/DebugSocketClient.js';
import type { DebugConsoleIn, DebugConsoleOut } from '../ipc/messages.js';
import type { Logger } from '../logging/types.js';
import { MAX_QUERY_ROWS } from '../ditto/query-projection.js';

/**
 * Debug Console — the client side of the Ditto SDK 5.1 `debug_socket`
 * subsystem. Attach to a RUNNING app process's Unix debug socket and run DQL
 * diagnostics against it. Deliberately independent of the extension's own
 * Ditto connection: no database needs to be connected (or even registered),
 * so the singleton is process-wide rather than per-database.
 *
 * Socket paths: absolute paths only (a relative path resolved against an
 * arbitrary cwd is a footgun). macOS limits Unix socket paths to 104 bytes —
 * the extension cannot fix that from the client side, so a longer path earns
 * a persistent in-panel warning (see `pathWarning`), not a refusal.
 */
export class DebugConsolePanel {
  private static current: DebugConsolePanel | undefined;

  /** macOS Unix socket path limit (bytes). Linux allows 108; the panel
   *  warns at the stricter limit because the APP doing the bind might be on
   *  either platform, and 104 is the documented constraint. */
  static readonly DARWIN_SOCKET_PATH_MAX = 104;

  static show(context: vscode.ExtensionContext, logger: Logger): void {
    if (DebugConsolePanel.current) {
      DebugConsolePanel.current.panel.reveal();
      return;
    }
    DebugConsolePanel.current = new DebugConsolePanel(context, logger);
    // No autoRevealInspectorOnce here: the Inspector has no Debug Console
    // feature to display, and sliding the secondary bar open for nothing
    // would read as a glitch.
  }

  static dispose(): void {
    DebugConsolePanel.current?.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: Logger;
  private client: DebugSocketClient | undefined;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.log = logger.withTag('ext:DebugConsole');
    this.panel = vscode.window.createWebviewPanel(
      'dittoDebugConsole',
      'Debug Console',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // History is session-only (v1), and keeping the webview alive is
        // what keeps that history usable when the user flips editors.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'debugConsole.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Debug Console',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });
    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<DebugConsoleIn>(
        this.logger, 'ext:debugConsole', 'Debug console action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private post(msg: DebugConsoleOut): void { void this.panel.webview.postMessage(msg); }

  private async handle(msg: DebugConsoleIn): Promise<void> {
    if (msg?.type === 'debugConsole.connect') {
      await this.connectTo(typeof msg.path === 'string' ? msg.path : '');
    } else if (msg?.type === 'debugConsole.disconnect') {
      this.closeClient();
      this.post({ type: 'debugConsole.state', state: 'disconnected' });
    } else if (msg?.type === 'debugConsole.run') {
      await this.run(typeof msg.statement === 'string' ? msg.statement : '');
    }
  }

  private async connectTo(socketPath: string): Promise<void> {
    // Connecting again replaces the current connection — that is the
    // reconnect path for both the user and the client.
    this.closeClient();
    const trimmed = socketPath.trim();
    if (!path.isAbsolute(trimmed)) {
      this.log.warn('Debug console connect refused: path is not absolute', { path: trimmed });
      this.post({
        type: 'debugConsole.state',
        state: 'disconnected',
        error: 'Socket path must be an absolute path (e.g. /tmp/my-app-ditto-debug.sock).',
      });
      return;
    }

    // Non-blocking: the bind happens in the APP, possibly on another
    // machine/container, so we warn rather than refuse.
    const byteLen = Buffer.byteLength(trimmed);
    const pathWarning = byteLen > DebugConsolePanel.DARWIN_SOCKET_PATH_MAX
      ? `This path is ${byteLen} bytes — macOS limits Unix socket paths to `
        + `${DebugConsolePanel.DARWIN_SOCKET_PATH_MAX} bytes (Linux 108). If the app is on `
        + 'macOS its bind will have failed; pick a shorter socket path in the app.'
      : undefined;
    if (pathWarning) { this.log.warn('Debug socket path exceeds 104 bytes', { path: trimmed, byteLen }); }

    this.post({
      type: 'debugConsole.state',
      state: 'connecting',
      ...(pathWarning ? { pathWarning } : {}),
    });
    const client = new DebugSocketClient(this.log, {
      onStateChange: (state, detail) => {
        if (this.client !== client) { return; }
        if (state === 'disconnected') {
          this.post({
            type: 'debugConsole.state',
            state: 'disconnected',
            ...(detail?.error ? { error: detail.error } : {}),
            ...(pathWarning ? { pathWarning } : {}),
          });
        }
      },
    });
    this.client = client;
    try {
      await client.connect(trimmed);
      if (this.client !== client) { return; } // superseded mid-connect
      this.post({
        type: 'debugConsole.state',
        state: 'connected',
        path: trimmed,
        ...(pathWarning ? { pathWarning } : {}),
      });
    } catch (err) {
      // connect() rejected, so the socket never came up; make sure the
      // half-built client is gone before reporting.
      if (this.client === client) { this.client = undefined; }
      client.disconnect();
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Debug console connect failed', { path: trimmed, err: message });
      this.post({
        type: 'debugConsole.state',
        state: 'disconnected',
        error: `Could not connect to ${trimmed}: ${message}`,
        ...(pathWarning ? { pathWarning } : {}),
      });
    }
  }

  private async run(statement: string): Promise<void> {
    const client = this.client;
    if (!client || client.state !== 'connected') {
      this.post({
        type: 'debugConsole.runResult',
        run: {
          statement, ok: false, error: 'Not connected to a debug socket.',
          totalRowCount: 0, truncated: false, durationMs: 0,
        },
      });
      return;
    }
    const started = Date.now();
    const result = await client.query(statement);
    const durationMs = Date.now() - started;
    if (this.client !== client) { return; } // user reconnected mid-run; drop the orphan reply
    if (!result.ok) {
      this.post({
        type: 'debugConsole.runResult',
        run: { statement, ok: false, error: result.error, totalRowCount: 0, truncated: false, durationMs },
      });
      return;
    }
    const rows = result.items.slice(0, MAX_QUERY_ROWS);
    this.post({
      type: 'debugConsole.runResult',
      run: {
        statement,
        ok: true,
        rows,
        totalRowCount: result.items.length,
        truncated: result.items.length > MAX_QUERY_ROWS,
        durationMs,
      },
    });
  }

  private closeClient(): void {
    const client = this.client;
    this.client = undefined;
    client?.disconnect();
  }

  private dispose(): void {
    DebugConsolePanel.current = undefined;
    this.closeClient();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}
