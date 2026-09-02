import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Logger } from '../logging/types.js';

/** Per-document CSP nonce.
 *
 *  Must come from a CSPRNG, not Math.random(): `script-src 'nonce-…'` is the
 *  only directive standing between an injected `<script>` and execution, and
 *  a predictable nonce is one an attacker who can inject markup can simply
 *  guess or replay. 128 bits, base64url so it needs no HTML escaping. */
function nonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Wrap an async webview-message handler for `webview.onDidReceiveMessage`.
 *
 * `onDidReceiveMessage` ignores the listener's return value, so handing it a
 * bare `async handle(msg)` turns any rejection into an unhandled rejection:
 * nothing is logged and the user sees the action silently do nothing. This
 * reports both, and also catches synchronous throws from the handler itself.
 *
 * `what` is the user-facing prefix, e.g. 'Save observer failed'.
 */
export function webviewMessageHandler<M extends { type?: string }>(
  logger: Logger,
  tag: string,
  what: string,
  handler: (msg: M) => Promise<void> | void,
): (msg: M) => void {
  const report = (msg: M, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    logger.withTag(tag).error(what, { messageType: msg?.type, err: message });
    void vscode.window.showErrorMessage(`${what}: ${message}`);
  };
  return (msg: M): void => {
    try {
      const result = handler(msg);
      if (result instanceof Promise) {
        void result.catch((err: unknown) => report(msg, err));
      }
    } catch (err) {
      report(msg, err);
    }
  };
}

export interface PanelHtmlOptions {
  title: string;
  scriptUri: vscode.Uri;
  cspSource: string;
  /**
   * Optional URI to a stylesheet (typically codicon.css) to load at the document level.
   * Required when the panel uses codicons inside Lit shadow DOM — Lit's Constructed
   * Stylesheets don't support `@import`, so the @font-face must be registered globally.
   */
  styleUri?: vscode.Uri;
}

/**
 * Reveals the Ditto Inspector view exactly once across the lifetime of the
 * installed extension (tracked via a globalState flag). Call from each
 * long-lived panel's `show()` after the panel is constructed.
 */
export function autoRevealInspectorOnce(context: vscode.ExtensionContext): void {
  const flagKey = 'dittoInspectorAutoRevealed.v1';
  if (context.globalState.get(flagKey)) { return; }
  void context.globalState.update(flagKey, true);
  void vscode.commands.executeCommand('dittoVsce.inspector.focus');
}

export function panelHtml({ title, scriptUri, cspSource, styleUri }: PanelHtmlOptions): string {
  const n = nonce();
  const styleLink = styleUri ? `<link rel="stylesheet" href="${styleUri.toString()}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${cspSource}; base-uri 'none'; form-action 'none';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${styleLink}
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}
