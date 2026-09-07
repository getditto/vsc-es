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
  // Serialization makes the count deterministic: one ERROR line per sync.
  assert.equal(bundle.logger.written.filter(l => l.startsWith('ERROR MCP server failed to start')).length, 2);

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

test('overlapping syncs start exactly one server — no phantom port-in-use failure', async (t) => {
  // The Start command path fires two syncs on the same tick (the ConfigStore
  // save event + the command's own sync). Without serialization both see an
  // empty slot and race to bind: the loser reports "port already in use"
  // while the winner runs fine, and failures latch.
  const probe = http.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const probeAddr = probe.address();
  assert.ok(probeAddr && typeof probeAddr === 'object');
  const freePort = probeAddr.port;
  await new Promise<void>(r => { probe.close(() => r()); });

  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true, port: freePort });
  t.after(() => controller.dispose());
  await Promise.all([
    controller.syncToActiveConnection(),
    controller.syncToActiveConnection(),
  ]);
  assert.equal(controller.isRunning, true);
  assert.equal(stub.window.shownErrors.length, 0, 'no false failure toast while the server is up');
  assert.equal(
    bundle.logger.written.filter(l => l === 'INFO MCP server starting').length,
    1,
    `exactly one bind attempt; got: ${bundle.logger.written.join(' | ')}`,
  );
});

test('a failing port-change restart is recorded + toasted instead of rejecting silently', async (t) => {
  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true, port: 0 });
  t.after(() => controller.dispose());
  await controller.syncToActiveConnection();
  assert.equal(controller.isRunning, true);

  // Occupy the port the user is about to move to.
  const blocker = http.createServer();
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === 'object');
  t.after(() => new Promise<void>(r => { blocker.close(() => r()); }));
  stub.workspace.configValues['dittoVsce.mcpServer'] = { port: addr.port };

  await controller.reconcile();
  assert.equal(controller.isRunning, false, 'old listener stopped');
  assert.equal(stub.window.shownErrors.length, 1, 'the failure is visible, not swallowed');
  assert.ok(bundle.logger.written.some(l => l.startsWith('ERROR MCP server failed to start')),
    'the log line the mcp_server_start_failure Log-Analyzer pattern keys on must fire');
});

test('a flag flipped off mid-bind stops the fresh listener before it serves', async (t) => {
  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true, port: 0 });
  t.after(() => controller.dispose());
  // Simulate: sync begins (bind in flight), then a queued sync observes the
  // flag off. Serialization alone would leave a bind-window gap, so the
  // controller re-checks the flag after the bind completes and stands down.
  const sync = controller.syncToActiveConnection();
  bundle.manager.state.activeId = null; // disconnect lands during the bind
  await sync;
  await controller.syncToActiveConnection(); // the queued corrective run
  assert.equal(controller.isRunning, false);
  assert.equal(controller.url, undefined);
});

test('dispose inside the bind window stands the listener down and nothing can resurrect it', async (t) => {
  // Find a free port to prove release afterwards.
  const probe = http.createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const probeAddr = probe.address();
  assert.ok(probeAddr && typeof probeAddr === 'object');
  const freePort = probeAddr.port;
  await new Promise<void>(r => { probe.close(() => r()); });

  const { controller, bundle } = setup({ activeId: 'cfg-1', flagOn: true, port: freePort });
  // Dispose must land INSIDE the async bind window deterministically: the
  // op logs 'MCP server starting' synchronously before its first listen
  // await, and the two loopback binds need at least two event-loop poll
  // phases, so polling the log via setImmediate is guaranteed to resume
  // while start() is still suspended. (Regression: dispose() used to
  // bypass the queue and could leave a bound server nothing could ever
  // stop.)
  const sync = controller.syncToActiveConnection();
  while (!bundle.logger.written.some(l => l.includes('MCP server starting'))) {
    await new Promise<void>(r => setImmediate(r));
  }
  controller.dispose();
  await sync;
  assert.equal(controller.isRunning, false, 'no listener survives the disposed controller');
  assert.equal(controller.url, undefined, 'url stays cleared once disposed');

  // Later transitions bail out instead of resurrecting the listener.
  await controller.syncToActiveConnection();
  await controller.reconcile();
  assert.equal(controller.isRunning, false);

  // The port is provably free: a new server can take it (v4 loopback).
  const rebind = http.createServer();
  t.after(() => new Promise<void>(r => { rebind.close(() => r()); }));
  await new Promise<void>((resolve, reject) => {
    rebind.once('error', reject);
    rebind.listen(freePort, '127.0.0.1', () => resolve());
  });
  assert.equal(rebind.listening, true, 'the disposed controller released the port');
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
