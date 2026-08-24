import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Logger, LogContext, LogLevel } from '../logging/types.js';

/**
 * Per-panel behaviour, with real fakes rather than the permissive stubs the
 * lifecycle contract uses.
 *
 * Scope is deliberate: these cover the panel-level behaviour changed during
 * this review that had no test of its own — PeerListingPanel's transport-apply
 * guard on the sync toggle, and LogAnalyzerPanel's bootstrap and refresh. Both
 * were fixes reasoned about by reading, which is exactly the situation a test
 * is supposed to replace.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: FakePanel[];
  window: { shownErrors: string[] };
  commands: { executed: { command: string; args: unknown[] }[] };
  __resetStub(): void;
};

interface FakePanel {
  disposed: boolean;
  webview: { posted: unknown[]; html: string };
  dispose(): void;
  fireMessage(msg: unknown): void;
}

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const self = {
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return { logger: self, errors };
}

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

const noopInspector = {
  setActiveFeature: () => {},
  setLastResultMetadata: () => {},
  setSelectedRowJson: () => {},
  onContentChange: () => ({ dispose: () => {} }),
} as never;

/** Let the panels' deferred constructor work (setTimeout … 50) run. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 80));

// ─── PeerListingPanel: the transport-apply guard ────────────────

interface FakeManager {
  applying: boolean;
  toggleCount: number;
  isApplyingTransports(): boolean;
  toggleSync(): Promise<string>;
  onPresence(): { dispose(): void };
  onStatusChange(): { dispose(): void };
  onSyncChange(): { dispose(): void };
  getLatestSnapshot(): unknown;
  getSyncState(): string;
  getActiveConfigId(): string | null;
}

function fakeManager(): FakeManager {
  const sub = { dispose: () => {} };
  const m: FakeManager = {
    applying: false,
    toggleCount: 0,
    isApplyingTransports: () => m.applying,
    toggleSync: () => { m.toggleCount += 1; return Promise.resolve('active'); },
    onPresence: () => sub,
    onStatusChange: () => sub,
    onSyncChange: () => sub,
    getLatestSnapshot: () => ({ local: undefined, remote: [] }),
    getSyncState: () => 'idle',
    getActiveConfigId: () => 'db-1',
  };
  return m;
}

async function showPeerListing(manager: FakeManager): Promise<FakePanel> {
  stub.__resetStub();
  const { PeerListingPanel } = await import('../panels/PeerListingPanel.js');
  PeerListingPanel.dispose();
  stub.__resetStub();
  PeerListingPanel.show(
    fakeContext(),
    manager as never,
    { get: () => ({ id: 'db-1', name: 'db' }) } as never,
    'db-1',
    { setPeers: () => Promise.resolve(), get: () => ({ query: [], peers: false }) } as never,
    noopInspector,
    recordingLogger().logger,
  );
  await settle();
  // show() just created this panel, so index 0 is present.
  return stub.createdWebviewPanels[0]!;
}

test('PeerListingPanel: the sync toggle reaches the manager', async () => {
  const manager = fakeManager();
  const panel = await showPeerListing(manager);

  panel.fireMessage({ type: 'peer.toggleSync' });
  await settle();

  assert.equal(manager.toggleCount, 1);
});

test('PeerListingPanel: the sync toggle is ignored while transports are applying', async () => {
  // A transport apply stops sync mid-cycle with the observers detached. Letting
  // the webview's toggle race it leaves sync and the UI disagreeing, and the
  // command path already guards on the same flag — the webview path did not.
  const manager = fakeManager();
  const panel = await showPeerListing(manager);
  manager.applying = true;

  panel.fireMessage({ type: 'peer.toggleSync' });
  await settle();

  assert.equal(manager.toggleCount, 0, 'toggle must not run during a transport apply');
});

test('PeerListingPanel: the toggle works again once the apply finishes', async () => {
  const manager = fakeManager();
  const panel = await showPeerListing(manager);

  manager.applying = true;
  panel.fireMessage({ type: 'peer.toggleSync' });
  await settle();
  assert.equal(manager.toggleCount, 0);

  manager.applying = false;
  panel.fireMessage({ type: 'peer.toggleSync' });
  await settle();
  assert.equal(manager.toggleCount, 1, 'the guard must not latch');
});

// ─── LogAnalyzerPanel: bootstrap and webview queries ───────────

interface FakeService {
  starts: { lines: readonly string[] | undefined }[];
  clears: number;
  pauses: number;
  resumes: number;
  queried: { filter?: string; offset?: number; limit?: number }[];
  start(p?: { backfillLines?: readonly string[] }): void;
  clear(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
  onDiff(): { dispose(): void };
  queryLines(o: { filter?: string; offset?: number; limit?: number }): { items: unknown[]; total: number };
  getLineDetail(): { line: null; before: never[]; after: never[] };
}

function fakeService(): FakeService {
  const svc: FakeService = {
    starts: [], clears: 0, pauses: 0, resumes: 0, queried: [],
    start: (p) => { svc.starts.push({ lines: p?.backfillLines }); },
    clear: () => { svc.clears += 1; },
    pause: () => { svc.pauses += 1; },
    resume: () => { svc.resumes += 1; },
    dispose: () => {},
    onDiff: () => ({ dispose: () => {} }),
    queryLines: (o) => { svc.queried.push(o); return { items: [], total: 0 }; },
    getLineDetail: () => ({ line: null, before: [], after: [] }),
  };
  return svc;
}

async function showAnalyzer(
  svc: FakeService,
  backfill: () => Promise<string[]>,
): Promise<FakePanel> {
  const { LogAnalyzerPanel } = await import('../panels/LogAnalyzerPanel.js');
  LogAnalyzerPanel.dispose();
  stub.__resetStub();
  LogAnalyzerPanel.show(
    fakeContext(), 'db-1', 'DB One', svc as never, backfill,
    recordingLogger().logger, noopInspector,
  );
  await settle();
  // show() just created this panel, so index 0 is present.
  return stub.createdWebviewPanels[0]!;
}

test('LogAnalyzerPanel: bootstrap starts the service with the backfill lines', async () => {
  const svc = fakeService();
  await showAnalyzer(svc, () => Promise.resolve(['line a', 'line b']));

  assert.equal(svc.starts.length, 1);
  assert.deepEqual(svc.starts[0]?.lines, ['line a', 'line b']);
});

test('LogAnalyzerPanel: a failed backfill still starts live ingestion', async () => {
  // Losing history is recoverable; losing the live stream means the panel shows
  // nothing at all for the rest of the session.
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.reject(new Error('disk gone')));

  assert.equal(svc.starts.length, 1, 'started anyway');
  assert.equal(svc.starts[0]?.lines, undefined, 'with no backfill');
  const errs = panel.webview.posted.filter(
    (m): m is { type: string; stage: string } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'analyzer.error',
  );
  assert.equal(errs.length, 1, 'and told the webview');
  assert.equal(errs[0]?.stage, 'backfill');
});

test('LogAnalyzerPanel: a line detail request posts the detail payload', async () => {
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.resolve(['a', 'b']));

  panel.fireMessage({ type: 'analyzer.requestLineDetail', lineId: 7, requestId: 'd1' });
  await settle();

  const details = panel.webview.posted.filter(
    (m): m is { type: string; requestId: string; line: unknown; before: unknown[]; after: unknown[] } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'analyzer.lineDetail',
  );
  assert.equal(details.length, 1, 'one detail response');
  assert.equal(details[0]?.requestId, 'd1', 'request id echoed back');
});

test('LogAnalyzerPanel: repeated line queries each reach the service once', async () => {
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.resolve(['a']));
  for (let i = 0; i < 3; i++) {
    panel.fireMessage({
      type: 'analyzer.queryLines', filter: 'all', limit: 100, requestId: `r${i}`,
    });
    await settle();
  }
  assert.equal(svc.queried.length, 3, 'one query per request');
  const results = panel.webview.posted.filter(
    (m): m is { type: string; requestId: string } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'analyzer.linesResult',
  );
  assert.deepEqual(results.map(r => r.requestId), ['r0', 'r1', 'r2'],
    'and each request got exactly one response, in order');
});

test('LogAnalyzerPanel: clear, pause and resume forward to the service', async () => {
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.resolve([]));

  panel.fireMessage({ type: 'analyzer.pause' });
  panel.fireMessage({ type: 'analyzer.resume' });
  panel.fireMessage({ type: 'analyzer.clear' });
  await settle();

  assert.equal(svc.pauses, 1);
  assert.equal(svc.resumes, 1);
  assert.equal(svc.clears, 1);
});

test('LogAnalyzerPanel: a line query echoes its offset back', async () => {
  // The table positions rows by absolute index, so a windowed response it
  // cannot place is worse than no response.
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.resolve([]));

  panel.fireMessage({
    type: 'analyzer.queryLines', filter: 'error', limit: 300, offset: 600, requestId: 'r1',
  });
  await settle();

  assert.deepEqual(svc.queried[svc.queried.length - 1]?.offset, 600, 'offset reached the service');
  const results = panel.webview.posted.filter(
    (m): m is { type: string; requestId: string; offset: number } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'analyzer.linesResult',
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.requestId, 'r1');
  assert.equal(results[0]?.offset, 600, 'the response must say which window it is');
});

test('LogAnalyzerPanel: opening the pattern editor goes through the command', async () => {
  // Routing via the command keeps a single owner for that panel rather than
  // two constructors racing.
  const svc = fakeService();
  const panel = await showAnalyzer(svc, () => Promise.resolve([]));
  stub.commands.executed.length = 0;

  panel.fireMessage({ type: 'analyzer.openPatternEditor' });
  await settle();

  assert.ok(
    stub.commands.executed.some(c => c.command === 'dittoVsce.openLogPatternEditor'),
    `saw ${JSON.stringify(stub.commands.executed.map(c => c.command))}`,
  );
});

test('LogAnalyzerPanel: closing the panel disposes the service', async () => {
  // The service holds a live sink subscription and the line buffer. A panel
  // closed without disposing it keeps ingesting for the rest of the session.
  const svc = fakeService();
  let disposed = false;
  svc.dispose = () => { disposed = true; };
  const panel = await showAnalyzer(svc, () => Promise.resolve([]));

  panel.dispose();
  await settle();

  assert.equal(disposed, true);
});

test('LogAnalyzerPanel: showing the same database again reveals rather than rebuilding', async () => {
  // One service per database. A second panel would double-subscribe the sink.
  const svc = fakeService();
  await showAnalyzer(svc, () => Promise.resolve([]));
  const countAfterFirst = stub.createdWebviewPanels.length;

  const { LogAnalyzerPanel } = await import('../panels/LogAnalyzerPanel.js');
  LogAnalyzerPanel.show(
    fakeContext(), 'db-1', 'DB One', fakeService() as never,
    () => Promise.resolve([]), recordingLogger().logger, noopInspector,
  );
  await settle();

  assert.equal(
    stub.createdWebviewPanels.length, countAfterFirst,
    'a second show for the same database must not create a second panel',
  );
  assert.equal(svc.starts.length, 1, 'and must not re-bootstrap');
});
