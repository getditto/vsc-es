import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DebugConsolePanel } from '../panels/DebugConsolePanel.js';

/**
 * Behaviour tests for the Debug Console panel: message traffic between the
 * webview and the DebugSocketClient, driven through the vscode stub's fake
 * webview panel and — for the socket side — a REAL in-process fake server
 * that speaks the debug_socket newline protocol. This is the one place where
 * panel ⇄ client wiring is exercised end to end without an Extension
 * Development Host.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[] };
  __resetStub(): void;
};

interface FakePanel {
  webview: { posted: unknown[]; html: string };
  dispose(): void;
  fireMessage(msg: unknown): void;
}

const silentLogger = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'withTag') { return () => silentLogger; }
    return () => { /* no-op log sink */ };
  },
}) as never;

// Debug socket integration requires the SDK's Unix-domain-socket listener.
const unixSocketTest = process.platform === 'win32' ? test.skip : test;

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('/ext'),
    globalStorageUri: vscode.Uri.file('/global'),
    subscriptions: [],
    globalState: {
      keys: () => [...store.keys()],
      get: <T>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

interface FakeServer { socketPath: string; close(): void; }

function startFakeServer(reply: (statement: string) => string): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-debug-panel-test-'));
  const socketPath = path.join(dir, 'app.sock');
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) { break; }
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length === 0) { continue; }
        socket.write(reply(line) + '\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close() {
          server.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for panel traffic'); }
    await new Promise(r => setTimeout(r, 5));
  }
}

function showPanel(): FakePanel {
  DebugConsolePanel.show(fakeContext(), silentLogger);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel, 'panel created');
  return panel;
}

test.beforeEach(() => { stub.__resetStub(); });
test.afterEach(() => { DebugConsolePanel.dispose(); stub.__resetStub(); });

unixSocketTest('connect → state connected is posted with the path echoed', async (t) => {
  const srv = await startFakeServer(() => '[]');
  t.after(() => srv.close());
  const panel = showPanel();

  panel.fireMessage({ type: 'debugConsole.connect', path: srv.socketPath });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string; state?: string }).state === 'connected',
  ));
  const connected = panel.webview.posted.find(
    m => (m as { state?: string }).state === 'connected',
  ) as { path?: string };
  assert.equal(connected.path, srv.socketPath);
});

unixSocketTest('running a statement posts a runResult with rows and metadata', async (t) => {
  const srv = await startFakeServer(
    (stmt) => (stmt.startsWith('SELECT') ? '[{"_id":"abc","make":"Toyota"}]' : 'ERROR: nope'),
  );
  t.after(() => srv.close());
  const panel = showPanel();

  panel.fireMessage({ type: 'debugConsole.connect', path: srv.socketPath });
  await waitFor(() => panel.webview.posted.some(m => (m as { state?: string }).state === 'connected'));

  panel.fireMessage({ type: 'debugConsole.run', statement: 'SELECT * FROM cars' });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ));
  const { run } = panel.webview.posted.find(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ) as { run: { ok: boolean; rows?: unknown[]; totalRowCount: number; truncated: boolean; statement: string } };

  assert.equal(run.ok, true);
  assert.equal(run.statement, 'SELECT * FROM cars');
  assert.deepEqual(run.rows, [{ _id: 'abc', make: 'Toyota' }]);
  assert.equal(run.totalRowCount, 1);
  assert.equal(run.truncated, false);
});

unixSocketTest('a server ERROR: line surfaces as an error runResult, not a thrown handler', async (t) => {
  const srv = await startFakeServer(() => 'ERROR: Parse error: unexpected token `*`');
  t.after(() => srv.close());
  const panel = showPanel();

  panel.fireMessage({ type: 'debugConsole.connect', path: srv.socketPath });
  await waitFor(() => panel.webview.posted.some(m => (m as { state?: string }).state === 'connected'));
  panel.fireMessage({ type: 'debugConsole.run', statement: 'SELECT *** FROM cars' });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ));

  const { run } = panel.webview.posted.find(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ) as { run: { ok: boolean; error?: string } };
  assert.equal(run.ok, false);
  assert.match(run.error ?? '', /Parse error/);
});

test('run while disconnected posts an error runResult rather than throwing', async () => {
  const panel = showPanel();
  panel.fireMessage({ type: 'debugConsole.run', statement: 'SELECT 1' });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ));
  const { run } = panel.webview.posted.find(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ) as { run: { ok: boolean; error?: string } };
  assert.equal(run.ok, false);
  assert.match(run.error ?? '', /[Nn]ot connected/);
  assert.deepEqual(stub.window.shownErrors, [], 'no error dialog for a routine refusal');
});

test('a relative socket path is refused through the panel error path', async () => {
  const panel = showPanel();
  panel.fireMessage({ type: 'debugConsole.connect', path: 'relative/path.sock' });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { state?: string; error?: string }).state === 'disconnected'
      && (m as { error?: string }).error !== undefined,
  ));
  const refused = panel.webview.posted.find(
    m => (m as { error?: string }).error !== undefined,
  ) as { error: string };
  assert.match(refused.error, /absolute/);
});

test('a connect to a nonexistent socket posts disconnected state with the OS error', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-debug-panel-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const panel = showPanel();
  panel.fireMessage({ type: 'debugConsole.connect', path: path.join(dir, 'nope.sock') });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { error?: string }).error !== undefined,
  ));
  const failed = panel.webview.posted.find(
    m => (m as { error?: string }).error !== undefined,
  ) as { error: string };
  assert.match(failed.error, /Could not connect/);
});

unixSocketTest('disconnect message closes the socket and posts disconnected state', async (t) => {
  const srv = await startFakeServer(() => '[]');
  t.after(() => srv.close());
  const panel = showPanel();
  panel.fireMessage({ type: 'debugConsole.connect', path: srv.socketPath });
  await waitFor(() => panel.webview.posted.some(m => (m as { state?: string }).state === 'connected'));

  panel.fireMessage({ type: 'debugConsole.disconnect' });
  await waitFor(() => panel.webview.posted.some(m => (m as { state?: string }).state === 'disconnected'));

  panel.fireMessage({ type: 'debugConsole.run', statement: 'SELECT 1' });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ));
  const { run } = panel.webview.posted.find(
    m => (m as { type: string }).type === 'debugConsole.runResult',
  ) as { run: { ok: boolean; error?: string } };
  assert.equal(run.ok, false);
  assert.match(run.error ?? '', /[Nn]ot connected/);
});

test('a >104-byte path carries the darwin path warning', async (t) => {
  // macOS itself refuses to bind a socket at a >104-byte path (that is
  // exactly why the panel warns), so no fixture server can exist here — the
  // assertion is that the connecting/failed state messages carry the
  // warning regardless of how the connect attempt ends.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-debug-panel-longpath-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(
    dir, ...Array.from({ length: 10 }, (_, i) => `segment-${i}`), 'app-debug.sock',
  );
  assert.ok(Buffer.byteLength(socketPath) > 104, 'fixture path should exceed 104 bytes');

  const panel = showPanel();
  panel.fireMessage({ type: 'debugConsole.connect', path: socketPath });
  await waitFor(() => panel.webview.posted.some(
    m => (m as { error?: string }).error !== undefined,
  ));
  for (const m of panel.webview.posted) {
    assert.match(
      (m as { pathWarning?: string }).pathWarning ?? '',
      /104 bytes/,
      'every state message for this path carries the warning',
    );
  }
});
