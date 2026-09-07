import * as vscode from 'vscode';
import type { McpServerController } from './McpServerController.js';

/** Contribution id — must match package.json
 *  `contributes.mcpServerDefinitionProviders[].id`. */
const PROVIDER_ID = 'ditto-edge-studio';

/**
 * Advertise the embedded MCP server to VS Code's own MCP machinery (so
 * Copilot agent mode + anything else using `vscode.lm` sees it), without
 * giving the editor a process to spawn: the server lives in THIS extension
 * host because the whole point is sharing its live Ditto instance.
 *
 * While the server is off we provide zero definitions (there is no URL to
 * hand out); starting/stopping fires onDidChangeMcpServerDefinitions and
 * the editor re-queries.
 */
export function registerCopilotMcpProvider(
  controller: McpServerController,
  extensionVersion: string,
): vscode.Disposable {
  const changeEmitter = new vscode.EventEmitter<void>();
  const stateSub = controller.onDidChangeState(() => { changeEmitter.fire(); });
  const registration = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changeEmitter.event,
    provideMcpServerDefinitions: () => {
      const url = controller.url;
      if (!url) { return []; }
      return [new vscode.McpHttpServerDefinition(
        'Ditto Edge Studio',
        vscode.Uri.parse(url),
        undefined,
        extensionVersion,
      )];
    },
  });
  return vscode.Disposable.from(registration, stateSub, changeEmitter);
}
