import test from 'node:test';
import assert from 'node:assert/strict';
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
