import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as vscode from 'vscode';

/**
 * McpServerController against the shared vscode stub: the per-connection
 * flag drives start/stop, the commands edit that flag on the active
 * connection, and the Copilot definition provider follows the listener.
 */

const stub = vscode as unknown as {
  __resetStub(): void;
  window: { shownInfos: string[]; shownErrors: string[]; warningResponse?: string };
  workspace: { configValues: Record<string, Record<string, unknown>> };
  env: { clipboardText: string };
  lm: { registeredMcpProviders: { id: string; provider: { provideMcpServerDefinitions(): unknown[] } }[] };
  createdStatusBarItems: { text: string; shown: boolean }[];
};

const { __resetStub } = stub;
const { McpServerController } = await import('../mcp/McpServerController.js');
const { registerCopilotMcpProvider } = await import('../mcp/copilot.js');
const { MCP_DEFAULT_PORT } = await import('../mcp/settings.js');
const { makeContext, seedConfig } = await import('./fixtures/mcp-fakes.js');

type ContextBundle = Awaited<ReturnType<typeof makeContext>>;

function setup(opts: {
  activeId?: string | null;
  flagOn?: boolean;
  port?: number;
}): { controller: InstanceType<typeof McpServerController>; bundle: ContextBundle } {
  __resetStub();
  stub.workspace.configValues['dittoVsce.mcpServer'] = { port: opts.port ?? 0 };
  const advancedConfig = opts.flagOn
    ? { collectionSyncScopes: [], systemSettings: [], mcpServerEnabled: true }
    : undefined;
  const bundle = makeContext({
    configs: [seedConfig(advancedConfig ? { advancedConfig } : {})],
    activeId: opts.activeId ?? null,
  });
  const controller = new McpServerController(bundle.ctx, '9.9.9-test', bundle.logger);
  return { controller, bundle };
}

test('server stays off when the active connection has no flag', async (t) => {
  const { controller } = setup({ activeId: 'cfg-1', flagOn: false });
  t.after(() => controller.dispose());
  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, false);
  assert.equal(controller.url, undefined);
});

test('flagged connection starts the server; disconnect stops it', async (t) => {
  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true });
  t.after(() => controller.dispose());
  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, true);
  assert.match(controller.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(stub.createdStatusBarItems.at(-1)?.shown, true, 'status bar item shows while running');

  bundle.manager.state.activeId = null; // disconnect
  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, false);
});

test('start command with no active connection explains where the toggle lives', async (t) => {
  const { controller } = setup({ activeId: null });
  t.after(() => controller.dispose());
  await controller.startCommand();
  assert.equal(controller.isRunning, false);
  assert.ok(stub.window.shownInfos.some(m => /Connect to a database first/.test(m)));
});

test('start/stop commands flip the flag on the active connection and take effect', async (t) => {
  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: false });
  t.after(() => controller.dispose());

  await controller.startCommand();
  assert.equal(controller.isRunning, true);
  assert.equal(bundle.configStore.get('cfg-1')?.advancedConfig?.mcpServerEnabled, true,
    'the flag is persisted on the connection, not in a second settings store');

  await controller.stopCommand();
  assert.equal(controller.isRunning, false);
  assert.equal(bundle.configStore.get('cfg-1')?.advancedConfig?.mcpServerEnabled, false);
});

test('a port change restarts the listener when running', async (t) => {
  const { controller } = setup({ activeId: 'cfg-1', flagOn: true });
  t.after(() => controller.dispose());
  await controller.syncToActiveConnection();
  const firstUrl = controller.url;
  assert.ok(firstUrl);

  stub.workspace.configValues['dittoVsce.mcpServer'] = { port: 0 }; // re-ephemeral
  await controller.reconcile();
  assert.ok(controller.url);
  assert.notEqual(controller.url, firstUrl, 'reconcile stops the old listener');
});

test('copilot provider hands out the HTTP definition only while running', async (t) => {
  const { controller } = setup({ activeId: 'cfg-1', flagOn: true });
  t.after(() => controller.dispose());
  const registration = registerCopilotMcpProvider(controller, '9.9.9-test');
  t.after(() => registration.dispose());

  const entry = stub.lm.registeredMcpProviders.at(-1);
  assert.ok(entry, 'provider registered');
  assert.equal(entry.id, 'ditto-edge-studio');
  assert.deepEqual(entry.provider.provideMcpServerDefinitions(), []);

  await controller.syncToActiveConnection();
  const defs = entry.provider.provideMcpServerDefinitions() as { label: string; uri: { scheme: string; path: string }; version: string }[];
  assert.equal(defs.length, 1);
  const def = defs[0];
  assert.ok(def);
  assert.equal(def.label, 'Ditto Edge Studio');
  assert.equal(def.uri.scheme, 'http');
  assert.match(def.uri.path, /\/mcp$/);
  assert.equal(def.version, '9.9.9-test');

  await controller.stop();
  assert.deepEqual(entry.provider.provideMcpServerDefinitions(), []);
});

test('start failure is logged for the Log Analyzer, toasted once, and clears on success', async (t) => {
  // Occupy the configured port so the bind must fail.
  const blocker = http.createServer();
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === 'object');
  const busyPort = (addr).port;

  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true, port: busyPort });
  t.after(() => controller.dispose());

  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, false);
  assert.ok(
    bundle.logger.written.some(l => l.startsWith('ERROR MCP server failed to start')),
    `expected an [mcp] error line (Log Analyzer surfaces these as problems); got: ${bundle.logger.written.join(' | ')}`,
  );
  assert.equal(stub.window.shownErrors.length, 1, 'toast exactly once per failure episode');

  // A second failing sync logs again but does not re-toast.
  await controller.syncToActiveConnection();
  assert.equal(stub.window.shownErrors.length, 1);
  assert.ok(bundle.logger.written.filter(l => l.startsWith('ERROR MCP server failed to start')).length >= 2);

  // Free the port; the next sync starts and resets the latch.
  await new Promise<void>(r => { blocker.close(() => r()); });
  stub.workspace.configValues['dittoVsce.mcpServer'] = { port: 0 };
  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, true);
  assert.ok(bundle.logger.written.includes('INFO MCP server started'));

  // And the latch really is reset: a later failure toasts again.
  const otherBlocker = http.createServer();
  await new Promise<void>(r => otherBlocker.listen(0, '127.0.0.1', r));
  const addr2 = otherBlocker.address();
  assert.ok(addr2 && typeof addr2 === 'object');
  const busyPort2 = (addr2).port;
  t.after(() => new Promise<void>(r => { otherBlocker.close(() => r()); }));

  await controller.stop();
  stub.workspace.configValues['dittoVsce.mcpServer'] = { port: busyPort2 };
  await controller.syncToActiveConnection();
  assert.equal(stub.window.shownErrors.length, 2, 'new failure episode after success re-toasts');
});

test('status command logs the full state (Log Analyzer backfill) and shows it', async (t) => {
  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true });
  t.after(() => controller.dispose());
  await controller.syncToActiveConnection();
  await controller.statusCommand();
  assert.ok(bundle.logger.written.includes('INFO MCP server status'));
  const toast = stub.window.shownInfos.find(m => /Running: yes/.test(m));
  assert.ok(toast, 'status modal shown');
  assert.match(toast, /URL: http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.match(toast, /MCP enabled on active connection: yes/);
});

test('status command while disconnected explains instead of lying', async (t) => {
  const { controller } = setup({ activeId: null });
  t.after(() => controller.dispose());
  await controller.statusCommand();
  const toast = stub.window.shownInfos.find(m => /Running: no/.test(m));
  assert.ok(toast);
  assert.match(toast, /Active connection: none/);
  assert.match(toast, /n\/a \(nothing connected\)/);
});

test('copy config command writes a client snippet for the configured port', async (t) => {
  const { controller } = setup({ activeId: null, port: MCP_DEFAULT_PORT });
  t.after(() => controller.dispose());
  await controller.copyConfigCommand();
  const snippet = JSON.parse(stub.env.clipboardText) as { mcpServers: Record<string, { url: string }> };
  const serverEntry = snippet.mcpServers['ditto-edge-studio-vscode'];
  assert.ok(serverEntry);
  assert.equal(serverEntry.url, `http://127.0.0.1:${MCP_DEFAULT_PORT}/mcp`);
  // Server not running → the info toast says so rather than implying otherwise.
  assert.ok(stub.window.shownInfos.some(m => /not currently running|starts only while/.test(m)));
});
