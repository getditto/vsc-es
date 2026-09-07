import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServerService } from './McpServerService.js';
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
 * Every lifecycle beat is logged under the `mcp` tag (visible in the
 * "Ditto Edge Studio" output channel AND the Log Analyzer — backfill
 * included). Start failures are logged as errors and toasted ONCE per
 * failure episode: the lifecycle listener can fire several times around a
 * connect, and a stuck port must not spam.
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
  /** Toast-once latch for start failures (reset on the next success). */
  private failureNotified = false;
  /** Last start failure, surfaced by the status command/tool. */
  private lastStartError: string | undefined;

  constructor(
    private readonly toolContext: McpToolContext,
    private readonly extensionVersion: string,
    parentLogger: Logger,
  ) {
    this.log = parentLogger.withTag('mcp');
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    this.statusItem.command = 'dittoVsce.mcpServerStatus';
    this.statusItem.tooltip = 'Ditto MCP server — click for status';
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
   *  and on ConfigStore change (an editor save flipping the checkbox).
   *  Never rejects — failures are logged + toasted once per episode. */
  async syncToActiveConnection(): Promise<void> {
    if (!this.desiredEnabled()) {
      if (this.service) { await this.stop(); }
      return;
    }
    try {
      await this.startIfNeeded();
    } catch (e) {
      this.recordStartFailure(e);
    }
  }

  /** Settings-edit path: a port change restarts the listener when running. */
  async reconcile(): Promise<void> {
    const port = readMcpPort();
    if (this.service && this.service.port !== port && this.desiredEnabled()) {
      this.log.info('MCP port setting changed — restarting listener', { from: this.service.port, to: port });
      await this.stop();
      await this.startIfNeeded();
      return;
    }
    await this.syncToActiveConnection();
  }

  private recordStartFailure(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.lastStartError = message;
    this.log.error('MCP server failed to start', { err: message });
    if (!this.failureNotified) {
      this.failureNotified = true;
      void vscode.window.showErrorMessage(`Ditto MCP server could not start: ${message}`);
    }
  }

  /** Start when the flag wants it and the port differs; no-op otherwise. */
  private async startIfNeeded(): Promise<void> {
    const port = readMcpPort();
    if (this.service?.isRunning && this.service.port === port) { return; }
    if (this.service) { await this.stop(); }
    this.log.info('MCP server starting', { port });
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
    this.lastStartError = undefined;
    this.failureNotified = false;
    this.statusItem.text = `$(plug) Ditto MCP :${port}`;
    this.statusItem.show();
    this.changeEmitter.fire();
    this.log.info('MCP server started', {
      port,
      url: service.url,
      tools: 'see tools/list',
    });
  }

  /** Hard stop regardless of flags. */
  async stop(): Promise<void> {
    const service = this.service;
    if (!service) { return; }
    this.service = undefined;
    await service.stop();
    this.statusItem.hide();
    this.changeEmitter.fire();
    this.log.info('MCP server stopped', { hadSessions: service.sessionCount });
  }

  /** Human-readable current state — logged at info AND shown, so the Log
   *  Analyzer and the Output channel both carry the answer to "is it
   *  even running?" without needing the user to reproduce anything. */
  async statusCommand(): Promise<void> {
    const id = this.toolContext.manager.getActiveConfigId();
    const cfg = id ? this.toolContext.configStore.get(id) : undefined;
    const flagOn = cfg?.advancedConfig?.mcpServerEnabled === true;
    const configuredPort = readMcpPort();
    const lines = [
      `Running: ${this.isRunning ? 'yes' : 'no'}`,
      `URL: ${this.url ?? '—'}`,
      `Configured port: ${configuredPort}`,
      `Active MCP sessions: ${this.service?.sessionCount ?? 0}`,
      `Active connection: ${cfg ? `${cfg.name} (${cfg.id})` : 'none'}`,
      `MCP enabled on active connection: ${id ? (flagOn ? 'yes' : 'no') : 'n/a (nothing connected)'}`,
      `Last start error: ${this.lastStartError ?? 'none'}`,
    ];
    const text = lines.join('\n');
    this.log.info('MCP server status', {
      running: this.isRunning,
      url: this.url,
      port: configuredPort,
      sessions: this.service?.sessionCount ?? 0,
      activeConfigId: id ?? 'none',
      enabledOnActive: id ? flagOn : 'n/a',
      lastStartError: this.lastStartError,
    });
    void vscode.window.showInformationMessage(`Ditto MCP server\n${text}`, { modal: true });
  }

  /** Set (or clear) the MCP flag on the active connection and make the
   *  change take effect immediately. */
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
    this.log.info(enabled ? 'MCP enabled on connection' : 'MCP disabled on connection', {
      configId: id, name: cfg.name,
    });
    try {
      await this.syncToActiveConnection();
      if (enabled && this.isRunning) {
        vscode.window.showInformationMessage(`Ditto MCP server running at ${this.url}`);
      }
    } catch (e) {
      this.recordStartFailure(e);
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
