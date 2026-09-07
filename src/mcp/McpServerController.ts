import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServerService, McpPortInUseError } from './McpServerService.js';
import { readMcpPort, mcpClientConfigSnippet } from './settings.js';
import { registerAllTools } from './registry.js';
import { registerAllResources } from './resources.js';
import type { McpToolContext } from './context.js';
import type { Logger } from '../logging/types.js';

/**
 * Owns the MCP server lifecycle. The on/off switch is PER-CONNECTION for
 * security: `advancedConfig.mcpServerEnabled` on the active
 * StoredDittoConfig (edited in the connection editor's Advanced tab,
 * default off). The controller follows the active connection:
 *
 *   connect(A, flag on)  → server starts (global port setting)
 *   switch A(on) → B(off) → server stops
 *   disconnect           → server stops
 *   edit + save flag     → immediate start/stop (configStore change event)
 *   port setting change  → restart with the new port
 *
 * The Start/Stop commands are shortcuts for toggling the flag on the
 * ACTIVE connection — state lives in exactly one place.
 */
export class McpServerController {
  private service: McpServerService | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fired on start/stop so the MCP definition provider re-resolves. */
  readonly onDidChangeState = this.changeEmitter.event;
  private readonly log: Logger;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(
    private readonly toolContext: McpToolContext,
    private readonly extensionVersion: string,
    parentLogger: Logger,
  ) {
    this.log = parentLogger.withTag('mcp');
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    this.statusItem.command = 'dittoVsce.mcpServerCopyConfig';
    this.statusItem.tooltip = 'Ditto MCP server — click to copy the client config';
  }

  /** URL agents should connect to; undefined unless running. */
  get url(): string | undefined { return this.service?.url; }
  get isRunning(): boolean { return this.service?.isRunning ?? false; }

  /** The active connection's MCP flag — false when nothing is connected. */
  private desiredEnabled(): boolean {
    const id = this.toolContext.manager.getActiveConfigId();
    const cfg = id ? this.toolContext.configStore.get(id) : undefined;
    return cfg?.advancedConfig?.mcpServerEnabled === true;
  }

  /** Follow the active connection's flag. Call on lifecycle transitions
   *  and on ConfigStore change (an editor save flipping the checkbox). */
  async syncToActiveConnection(): Promise<void> {
    if (!this.desiredEnabled()) {
      if (this.service) { await this.stop(); }
      return;
    }
    await this.startIfNeeded();
  }

  /** Settings-edit path: a port change restarts the listener when running. */
  async reconcile(): Promise<void> {
    const port = readMcpPort();
    if (this.service && this.service.port !== port && this.desiredEnabled()) {
      await this.stop();
      await this.startIfNeeded();
      return;
    }
    await this.syncToActiveConnection();
  }

  /** Start when the flag wants it and the port differs; no-op otherwise. */
  private async startIfNeeded(): Promise<void> {
    const port = readMcpPort();
    if (this.service?.isRunning && this.service.port === port) { return; }
    if (this.service) { await this.stop(); }
    const service = new McpServerService({
      name: 'ditto-edge-studio-vscode',
      version: this.extensionVersion,
      register: (server: McpServer) => {
        registerAllTools(server, this.toolContext);
        registerAllResources(server, this.toolContext);
      },
      log: this.log,
    });
    await service.start(port);
    this.service = service;
    this.statusItem.text = `$(plug) Ditto MCP :${port}`;
    this.statusItem.show();
    this.changeEmitter.fire();
    this.log.info('MCP server started', { port });
  }

  /** Hard stop regardless of flags. */
  async stop(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    await service?.stop();
    this.statusItem.hide();
    this.changeEmitter.fire();
  }

  /** Set (or clear) the MCP flag on the active connection and make the
   *  change take effect immediately. The per-connection flag edit updates
   *  ConfigStore, and the extension's onDidChange subscription calls
   *  syncToActiveConnection too — this direct call just skips the wait. */
  private async setFlagOnActiveConnection(enabled: boolean): Promise<void> {
    const id = this.toolContext.manager.getActiveConfigId();
    const cfg = id ? this.toolContext.configStore.get(id) : undefined;
    if (!id || !cfg) {
      vscode.window.showInformationMessage(
        'Connect to a database first — the MCP server toggle lives on each connection (Edit Configuration → Advanced).',
      );
      return;
    }
    await this.toolContext.configStore.save({
      ...cfg,
      advancedConfig: { ...cfg.advancedConfig, mcpServerEnabled: enabled },
    });
    try {
      await this.syncToActiveConnection();
    } catch (e) {
      if (e instanceof McpPortInUseError) {
        vscode.window.showErrorMessage(e.message);
        return;
      }
      vscode.window.showErrorMessage(`Failed to start the Ditto MCP server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async startCommand(): Promise<void> {
    await this.setFlagOnActiveConnection(true);
  }

  async stopCommand(): Promise<void> {
    await this.setFlagOnActiveConnection(false);
  }

  async copyConfigCommand(): Promise<void> {
    const port = readMcpPort();
    await vscode.env.clipboard.writeText(mcpClientConfigSnippet(port));
    vscode.window.showInformationMessage(
      `MCP client config copied (points at port ${port}).`
      + (this.isRunning
        ? ''
        : ' Note: the server starts only while a connection with "MCP Server" enabled (Advanced tab) is active.'),
    );
  }

  dispose(): void {
    void this.stop();
    this.changeEmitter.dispose();
    this.statusItem.dispose();
  }
}
