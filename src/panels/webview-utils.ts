import * as vscode from 'vscode';

export function nonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
  return text;
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
  const styleLink = styleUri ? `<link rel="stylesheet" href="${styleUri}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; font-src ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${styleLink}
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
