import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import { MAX_QUERY_ROWS } from '../ditto/query-projection.js';
import type { Logger, LogLevel } from '../logging/types.js';
import type { QueryResultMetadata } from '../inspector/inspector-state.js';
import type { HttpQueryRequest, HttpQueryResponse } from '../ditto/HttpQueryService.js';

/**
 * QueryEditorPanel behaviour not covered by the advise/attachments/tabs/
 * dispose suites: run-result payloads (local + HTTP), failure surfacing,
 * export, attachment size gates, and the Inspector/history/favorites/metrics
 * integration points.
 *
 * HTTP runs go through a scripted HttpQueryService: the panel imports
 * `executeRemoteQuery` as a module binding, so the `registerHooks` resolve
 * hook below rewrites that one import (this test file's process only) to the
 * fake in `fixtures/`. Local-mode tests never touch the fake.
 *
 * The hook must be registered BEFORE the panel module resolves, so the panel
 * (and only it) is pulled in with a dynamic import — a static top-level
 * import would hoist above the registration.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/HttpQueryService.js')
        && context.parentURL?.endsWith('/src/panels/QueryEditorPanel.ts')) {
      return {
        url: new URL('./fixtures/fake-http-query-service.ts', import.meta.url).href,
        shortCircuit: true,
        format: 'module',
      };
    }
    return nextResolve(specifier, context);
  },
});

const fakeHttp = await import('./fixtures/fake-http-query-service.js');
const { QueryEditorPanel } = await import('../panels/QueryEditorPanel.js');
// The constructor is private, so InstanceType<> can't name the instance —
// take it from the public static factory's return type instead.
type QueryEditorPanelInstance = NonNullable<ReturnType<typeof QueryEditorPanel.show>>;

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    title: string;
    webview: { posted: unknown[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
    fireViewState(active: boolean): void;
  }[];
  window: {
    openDialogResult: unknown;
    saveDialogResult: unknown;
    lastSaveDialogOptions: { defaultUri?: { fsPath?: string } } | undefined;
    quickPickResult: unknown;
    inputBoxResult: unknown;
    warningResponse: unknown;
    shownErrors: string[];
    shownWarnings: string[];
    shownInfos: string[];
  };
  workspace: { fsStatSize: number };
  Uri: { file(p: string): unknown };
  __resetStub(): void;
};

function memento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T) =>
      (store.has(key) ? store.get(key) : defaultValue) as T,
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  };
}

interface RecordedLogs { logger: Logger; errors: string[]; warns: string[] }

function recordingLogger(): RecordedLogs {
  const errors: string[] = [];
  const warns: string[] = [];
  const self = {
    error: (m: string) => { errors.push(m); },
    warn: (m: string) => { warns.push(m); },
    info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return { logger: self, errors, warns };
}

interface ExecuteQueryCall {
  query: string;
  opts: { collectProfiling: boolean; collectMetrics: boolean } | undefined;
}

interface Deps {
  manager: unknown;
  configs: unknown;
  secrets: unknown;
  tracker: OpenPanelsTracker;
  inspector: {
    features: unknown[];
    metadata: QueryResultMetadata[];
    selectedJson: (string | null)[];
    queryTabs: string[];
  };
  history: { adds: { databaseId: string; query: string }[] };
  favorites: { adds: { databaseId: string; query: string }[] };
  metrics: { captures: { databaseId: string; metadata: QueryResultMetadata }[] };
  logs: RecordedLogs;
  state: { activeId: string | null };
  executeQueryCalls: ExecuteQueryCall[];
  rawCalls: { query: string; args?: Record<string, unknown> | undefined }[];
  attachments: { filePath: string; metadata: Record<string, string> }[];
}

function makeDeps(opts: {
  activeId?: string | null;
  rows?: Record<string, unknown>[];
  executeQueryImpl?: (query: string) => Promise<{
    rows: Record<string, unknown>[];
    durationMs: number;
    metadata: QueryResultMetadata;
  }>;
  config?: unknown;
  secretsImpl?: () => Promise<unknown>;
  newAttachmentImpl?: () => Promise<unknown>;
} = {}): Deps {
  const state = { activeId: opts.activeId === undefined ? 'db-A' as string | null : opts.activeId };
  const executeQueryCalls: ExecuteQueryCall[] = [];
  const rawCalls: Deps['rawCalls'] = [];
  const attachments: Deps['attachments'] = [];
  const logs = recordingLogger();
  const rows = opts.rows ?? [{ _id: 'a' }];

  const manager = {
    getActiveConfigId: () => state.activeId,
    executeQuery: async (
      query: string,
      qopts?: { collectProfiling: boolean; collectMetrics: boolean },
    ) => {
      executeQueryCalls.push({ query, opts: qopts });
      if (opts.executeQueryImpl) { return opts.executeQueryImpl(query); }
      return {
        rows,
        durationMs: 1,
        metadata: {
          dql: query, durationMs: 1, resultCount: rows.length, explain: '', timestamp: 0,
        } as QueryResultMetadata,
      };
    },
    executeRaw: async (query: string, args?: Record<string, unknown>) => {
      rawCalls.push({ query, args });
      return [];
    },
    newAttachment: async (filePath: string, metadata: Record<string, string>) => {
      attachments.push({ filePath, metadata });
      if (opts.newAttachmentImpl) { return opts.newAttachmentImpl(); }
      return { id: 'att-new', len: Number(metadata.length ?? 0), metadata, close: async () => {} };
    },
  };

  const inspector = {
    features: [] as unknown[],
    metadata: [] as QueryResultMetadata[],
    selectedJson: [] as (string | null)[],
    queryTabs: [] as string[],
    setActiveFeature(f: unknown) { inspector.features.push(f); },
    setLastResultMetadata(m: QueryResultMetadata) { inspector.metadata.push(m); },
    setSelectedRowJson(j: string | null) { inspector.selectedJson.push(j); },
    setQueryTab(t: string) { inspector.queryTabs.push(t); return Promise.resolve(); },
  };

  const deps: Deps = {
    manager,
    configs: { get: () => opts.config },
    secrets: { read: opts.secretsImpl ?? (() => Promise.resolve({})) },
    tracker: new OpenPanelsTracker(memento()),
    inspector,
    history: { adds: [] },
    favorites: { adds: [] },
    metrics: { captures: [] },
    logs,
    state,
    executeQueryCalls,
    rawCalls,
    attachments,
  };
  return deps;
}

function showPanel(deps: Deps): QueryEditorPanelInstance | undefined {
  const history = { add: async (databaseId: string, query: string) => { deps.history.adds.push({ databaseId, query }); } };
  const favorites = { add: async (databaseId: string, query: string) => { deps.favorites.adds.push({ databaseId, query }); } };
  const metrics = { capture: (databaseId: string, metadata: QueryResultMetadata) => { deps.metrics.captures.push({ databaseId, metadata }); } };
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  return QueryEditorPanel.show(
    context,
    deps.manager as never,
    deps.configs as never,
    deps.secrets as never,
    'db-A',
    deps.tracker,
    deps.inspector as never,
    history as never,
    favorites as never,
    metrics as never,
    deps.logs.logger,
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

function reset(): void {
  QueryEditorPanel.dispose();
  fakeHttp.__resetFakeHttp();
  stub.__resetStub();
}

function firstPanel(): (typeof stub.createdWebviewPanels)[number] {
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel, 'panel was created');
  return panel;
}

function postedOfType<T>(posted: unknown[], type: string): T[] {
  return posted.filter(
    (m): m is T => typeof m === 'object' && m !== null && (m as { type?: string }).type === type,
  );
}

interface ResultPost {
  type: string;
  rows: Record<string, unknown>[];
  columns: string[];
  durationMs: number;
  metadata: QueryResultMetadata;
  advice: unknown;
}

/** Run a query end-to-end so lastMetadata is set and the result is posted. */
async function runQuery(
  panel: { fireMessage(msg: unknown): void },
  query: string,
  mode: 'local' | 'http' = 'local',
): Promise<void> {
  panel.fireMessage({ type: 'query.run', query, mode });
  await settle();
}

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), tag));
}

// ─── Local runs ────────────────────────────────────────────────

test('QueryEditorPanel: a local run posts the result and feeds every integration point', async () => {
  reset();
  const rows = [{ _id: 'a', zebra: 1, apple: 2 }];
  const deps = makeDeps({ rows });
  showPanel(deps);
  const panel = firstPanel();
  await settle();

  await runQuery(panel, 'SELECT * FROM tasks');

  const results = postedOfType<ResultPost>(panel.webview.posted, 'query.result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.rows, rows);
  assert.deepEqual(results[0]!.columns, ['_id', 'apple', 'zebra'], '_id first, the rest sorted');
  assert.equal(results[0]!.durationMs, 1);
  assert.equal(results[0]!.metadata.location, 'local', 'the panel stamps the run location');
  assert.equal(results[0]!.advice, null, 'non-ADVISE rows carry a null advice');

  // The run went through the manager with both collection flags read fresh.
  assert.deepEqual(deps.executeQueryCalls.map(c => c.opts), [
    { collectProfiling: true, collectMetrics: true },
  ]);

  // Inspector, history, and the metrics ring buffer all saw the run.
  assert.deepEqual(deps.inspector.metadata, [results[0]!.metadata]);
  assert.deepEqual(deps.inspector.selectedJson, [null], 'a fresh run clears the row selection');
  assert.deepEqual(deps.history.adds, [{ databaseId: 'db-A', query: 'SELECT * FROM tasks' }]);
  assert.equal(deps.metrics.captures.length, 1);
  assert.equal(deps.metrics.captures[0]!.databaseId, 'db-A');
  assert.equal(deps.metrics.captures[0]!.metadata.dql, 'SELECT * FROM tasks');
});

test('QueryEditorPanel: rows without _id produce sorted columns with no _id pin', async () => {
  reset();
  const deps = makeDeps({ rows: [{ b: 1, a: 2 }] });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT 1');

  const results = postedOfType<ResultPost>(firstPanel().webview.posted, 'query.result');
  assert.deepEqual(results[0]!.columns, ['a', 'b']);
});

test('QueryEditorPanel: a run on an inactive connection surfaces the error and records nothing', async () => {
  reset();
  const deps = makeDeps({ activeId: 'db-B' });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks');

  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'query.error');
  assert.deepEqual(errors.map(e => e.message), ['No active database. Connect first.']);
  assert.equal(deps.executeQueryCalls.length, 0, 'the manager was never asked');
  assert.deepEqual(deps.history.adds, [], 'a refused run is not history');
  assert.deepEqual(deps.inspector.metadata, [], 'and does not touch the Inspector');
});

test('QueryEditorPanel: a failing run posts the DQL error and skips history/metrics', async () => {
  reset();
  const deps = makeDeps({
    executeQueryImpl: () => Promise.reject(new Error('dql syntax error at line 1')),
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks');

  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'query.error');
  assert.deepEqual(errors.map(e => e.message), ['dql syntax error at line 1']);
  assert.equal(postedOfType(firstPanel().webview.posted, 'query.result').length, 0);
  assert.deepEqual(deps.history.adds, []);
  assert.deepEqual(deps.metrics.captures, []);
});

// ─── HTTP runs ─────────────────────────────────────────────────

const HTTP_CONFIG = {
  id: 'db-A', name: 'DB', httpApiUrl: 'example.ditto.live:443', allowUntrustedCerts: true,
};

function httpDeps(
  impl: (req: HttpQueryRequest) => Promise<HttpQueryResponse>,
  opts: Parameters<typeof makeDeps>[0] = {},
): Deps {
  fakeHttp.__setExecuteRemoteQuery(impl);
  return makeDeps({
    ...opts,
    config: HTTP_CONFIG,
    secretsImpl: () => Promise.resolve({ httpApiKey: 'key-1' }),
  });
}

test('QueryEditorPanel: an HTTP run filters non-object rows and follows with an EXPLAIN side-trip', async () => {
  reset();
  const requests: { query: string; httpApiUrl: string; httpApiKey: string; allowUntrustedCerts: boolean }[] = [];
  const deps = httpDeps(async (req) => {
    requests.push(req);
    if (req.query.startsWith('EXPLAIN')) {
      return { items: [{ plan: { index: 'ix1' } }] };
    }
    return { items: [{ _id: 'a', x: 1 }, null, 'a string', [1, 2], { _id: 'b' }] };
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks', 'http');

  assert.equal(requests.length, 2, 'data run + EXPLAIN side-trip');
  assert.equal(requests[0]!.query, 'SELECT * FROM tasks');
  assert.equal(requests[1]!.query, 'EXPLAIN SELECT * FROM tasks');
  assert.equal(requests[0]!.httpApiUrl, 'example.ditto.live:443');
  assert.equal(requests[0]!.httpApiKey, 'key-1');
  assert.equal(requests[0]!.allowUntrustedCerts, true);

  const results = postedOfType<ResultPost>(firstPanel().webview.posted, 'query.result');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.rows, [{ _id: 'a', x: 1 }, { _id: 'b' }],
    'nulls, primitives, and arrays are not rows');
  assert.equal(results[0]!.metadata.location, 'http');
  assert.equal(results[0]!.metadata.resultCount, 2);
  assert.equal(results[0]!.metadata.dql, 'SELECT * FROM tasks');
  assert.match(results[0]!.metadata.explain ?? '', /"plan"/, 'the pretty-printed plan landed');
  assert.deepEqual(deps.history.adds, [{ databaseId: 'db-A', query: 'SELECT * FROM tasks' }]);
});

test('QueryEditorPanel: a failed HTTP EXPLAIN degrades the plan, not the query', async () => {
  reset();
  const deps = httpDeps(async (req) => {
    if (req.query.startsWith('EXPLAIN')) { throw new Error('server has no plan'); }
    return { items: [{ _id: 'a' }] };
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks', 'http');

  const results = postedOfType<ResultPost>(firstPanel().webview.posted, 'query.result');
  assert.equal(results.length, 1, 'the data run still lands');
  assert.equal(results[0]!.metadata.explain, '', 'plan degrades to empty');
  assert.ok(deps.logs.warns.some(w => /HTTP EXPLAIN failed/.test(w)), 'the degradation is logged');
});

test('QueryEditorPanel: an EXPLAIN-prefixed HTTP query skips the side-trip', async () => {
  reset();
  const requests: string[] = [];
  const deps = httpDeps(async (req) => {
    requests.push(req.query);
    return { items: [{ plan: {} }] };
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), '  explain select * from tasks', 'http');

  assert.deepEqual(requests, ['  explain select * from tasks'],
    'EXPLAIN EXPLAIN … would be a syntax error — one request only');
});

test('QueryEditorPanel: an ADVISE HTTP query skips the side-trip too', async () => {
  reset();
  const requests: string[] = [];
  const deps = httpDeps(async (req) => {
    requests.push(req.query);
    return { items: [{ _id: 'a' }] };
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'ADVISE SELECT * FROM tasks WHERE e = 1', 'http');

  assert.deepEqual(requests, ['ADVISE SELECT * FROM tasks WHERE e = 1'],
    'EXPLAIN ADVISE … is not valid syntax — one request only');
});

test('QueryEditorPanel: HTTP mode without an httpApiUrl/key refuses before any request', async () => {
  reset();
  let requests = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { requests += 1; return { items: [] }; });
  const deps = makeDeps({ config: { id: 'db-A', name: 'DB' }, secretsImpl: async () => ({}) });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks', 'http');

  assert.equal(requests, 0);
  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'query.error');
  assert.deepEqual(errors.map(e => e.message), [
    'HTTP mode requires httpApiUrl and httpApiKey on this connection.',
  ]);
});

test('QueryEditorPanel: HTTP results are capped at MAX_QUERY_ROWS and marked truncated', async () => {
  reset();
  const items = Array.from({ length: MAX_QUERY_ROWS + 1 }, (_, i) => ({ _id: `r${i}` }));
  const deps = httpDeps(async (req) => {
    if (req.query.startsWith('EXPLAIN')) { return { items: [] }; }
    return { items };
  });
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM big', 'http');

  const results = postedOfType<ResultPost>(firstPanel().webview.posted, 'query.result');
  assert.equal(results[0]!.rows.length, MAX_QUERY_ROWS);
  assert.equal(results[0]!.metadata.resultCount, MAX_QUERY_ROWS);
  assert.equal(results[0]!.metadata.truncated, true);
  assert.equal(results[0]!.metadata.totalResultCount, MAX_QUERY_ROWS + 1);
});

// ─── Export ────────────────────────────────────────────────────

test('QueryEditorPanel: export writes the rows and suggests a filename from the query', async () => {
  reset();
  const dir = tmpDir('qep-export-');
  try {
    const deps = makeDeps();
    showPanel(deps);
    await settle();
    await runQuery(firstPanel(), 'SELECT * FROM tasks');

    const target = path.join(dir, 'out.json');
    stub.window.saveDialogResult = stub.Uri.file(target);
    firstPanel().fireMessage({ type: 'query.exportRows', json: '[{"_id":"a"}]', rowCount: 1 });
    await settle();

    assert.equal(fs.readFileSync(target, 'utf8'), '[{"_id":"a"}]', 'the bytes are verbatim');
    const done = postedOfType<{ rowCount: number; path: string }>(
      firstPanel().webview.posted, 'query.exportDone',
    );
    assert.deepEqual(done.map(d => [d.rowCount, d.path]), [[1, target]]);
    assert.deepEqual(stub.window.shownInfos, ['Exported 1 row to out.json'], 'singular inflection');
    const suggested = stub.window.lastSaveDialogOptions?.defaultUri?.fsPath ?? '';
    assert.ok(suggested.endsWith('tasks.json'), `collection-derived suggestion; got ${suggested}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QueryEditorPanel: a cancelled export posts exportCancelled and writes nothing', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM tasks');

  stub.window.saveDialogResult = undefined; // user hit Escape
  firstPanel().fireMessage({ type: 'query.exportRows', json: '[]', rowCount: 0 });
  await settle();

  assert.equal(postedOfType(firstPanel().webview.posted, 'query.exportCancelled').length, 1);
  assert.equal(postedOfType(firstPanel().webview.posted, 'query.exportDone').length, 0);
});

test('QueryEditorPanel: a failed export write surfaces exportError', async () => {
  reset();
  const dir = tmpDir('qep-export-fail-');
  try {
    const deps = makeDeps();
    showPanel(deps);
    await settle();
    await runQuery(firstPanel(), 'SELECT * FROM tasks');

    // A path inside a directory that does not exist → writeFile rejects.
    stub.window.saveDialogResult = stub.Uri.file(path.join(dir, 'nope', 'out.json'));
    firstPanel().fireMessage({ type: 'query.exportRows', json: '[]', rowCount: 0 });
    await settle();

    const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'query.exportError');
    assert.equal(errors.length, 1);
    assert.ok(errors[0]!.message.length > 0, 'the OS error message is passed through');
    assert.ok(deps.logs.errors.some(e => /Query export failed/.test(e)), 'and the failure is logged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QueryEditorPanel: export falls back to query_results.json when no collection parses out', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT 1'); // no FROM clause

  stub.window.saveDialogResult = undefined;
  firstPanel().fireMessage({ type: 'query.exportRows', json: '[]', rowCount: 0 });
  await settle();

  const suggested = stub.window.lastSaveDialogOptions?.defaultUri?.fsPath ?? '';
  assert.ok(suggested.endsWith('query_results.json'), `got ${suggested}`);
});

test('QueryEditorPanel: export sanitises an unportable collection name in the suggestion', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM `my coll`'); // parses, but not filename-safe

  stub.window.saveDialogResult = undefined;
  firstPanel().fireMessage({ type: 'query.exportRows', json: '[]', rowCount: 0 });
  await settle();

  const suggested = stub.window.lastSaveDialogOptions?.defaultUri?.fsPath ?? '';
  assert.ok(suggested.endsWith('query_results.json'),
    `a spaced collection must not leak into a filename; got ${suggested}`);
});

// ─── Attachment add: size gates and failure paths ──────────────

/** Shared setup for attachment tests: a panel that has run SELECT * FROM tasks. */
async function panelWithRun(deps: Deps): Promise<(typeof stub.createdWebviewPanels)[number]> {
  showPanel(deps);
  const panel = firstPanel();
  await settle();
  await runQuery(panel, 'SELECT * FROM tasks');
  stub.window.shownErrors.length = 0;
  stub.window.shownWarnings.length = 0;
  stub.window.shownInfos.length = 0;
  return panel;
}

const MB = 1024 * 1024;

test('QueryEditorPanel: an attachment over the 20 MB hard limit is refused before upload', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/big.png')];
  stub.workspace.fsStatSize = 21 * MB;
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownErrors, [
    'big.png is 21.0 MB — over the 20.0 MB limit. Cannot upload.',
  ]);
  assert.equal(deps.attachments.length, 0, 'newAttachment never ran');
  assert.equal(deps.rawCalls.length, 0, 'and no UPDATE was issued');
});

test('QueryEditorPanel: the hard-limit message formats gigabyte sizes', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/huge.zip')];
  stub.workspace.fsStatSize = Math.floor(1.5 * 1024 * 1024 * 1024);
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.match(stub.window.shownErrors[0] ?? '', /huge\.zip is 1\.5 GB — over the 20\.0 MB limit/);
  assert.equal(deps.attachments.length, 0);
});

test('QueryEditorPanel: the 10 MB soft limit warns and a dismissal aborts the upload', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/medium.png')];
  stub.workspace.fsStatSize = 11 * MB;
  // warningResponse left undefined = the user dismissed the modal.
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownWarnings, [
    'medium.png is 11.0 MB. Files over 10.0 MB can be slow to sync over peer-to-peer. Continue?',
  ]);
  assert.equal(deps.attachments.length, 0, 'dismissed modal = no upload');
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: accepting the soft-limit warning uploads, links, and re-runs the query', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/medium.png')];
  stub.workspace.fsStatSize = 11 * MB;
  stub.window.warningResponse = 'Upload';
  stub.window.inputBoxResult = 'photo';
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(deps.attachments, [{
    filePath: '/tmp/medium.png',
    metadata: { filename: 'medium.png', contentType: 'image/png', length: String(11 * MB) },
  }]);
  assert.equal(deps.rawCalls.length, 1);
  assert.equal(deps.rawCalls[0]!.query, 'UPDATE `tasks` SET `photo` = :att WHERE _id = :docId');
  assert.equal(deps.rawCalls[0]!.args?.docId, 'a');
  assert.equal((deps.rawCalls[0]!.args?.att as { id: string }).id, 'att-new');
  assert.deepEqual(stub.window.shownInfos, ['Attached medium.png to tasks/a.photo.']);
  const results = postedOfType(panel.webview.posted, 'query.result');
  assert.equal(results.length, 2, 'the query re-ran so the new field shows up');
});

test('QueryEditorPanel: a disallowed file type is refused before any size check', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/evil.exe')];
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownWarnings, [
    'File type ".exe" is not on the attachment allowlist. Pick an image, audio, video, PDF, text, or zip file.',
  ]);
  assert.equal(deps.attachments.length, 0);
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: dismissing the field-name box aborts before the upload', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/pic.png')];
  stub.workspace.fsStatSize = 100;
  stub.window.inputBoxResult = undefined; // dismissed
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.equal(deps.attachments.length, 0, 'no attachment was created');
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: a failing upload surfaces as a toast, not a lost rejection', async () => {
  reset();
  const deps = makeDeps({
    newAttachmentImpl: () => Promise.reject(new Error('camera gone')),
  });
  const panel = await panelWithRun(deps);

  stub.window.openDialogResult = [stub.Uri.file('/tmp/pic.png')];
  stub.workspace.fsStatSize = 100;
  stub.window.inputBoxResult = 'photo';
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownErrors, ['Add attachment failed: camera gone']);
  assert.ok(deps.logs.errors.some(e => /Attachment add failed/.test(e)));
});

// ─── Attachment delete ─────────────────────────────────────────

const ATTACH_ROW = JSON.stringify({
  _id: 'a',
  photo: { id: 'att-1', len: 2048, metadata: { filename: 'f.png', contentType: 'image/png' } },
});

test('QueryEditorPanel: deleting from a row with no attachments says so', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: '{"_id":"a","plain":1}' });
  await settle();

  assert.deepEqual(stub.window.shownInfos, ['This document has no attachments to delete.']);
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: dismissing the field picker aborts the delete before the confirm', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.quickPickResult = undefined; // dismissed
  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: ATTACH_ROW });
  await settle();

  assert.deepEqual(stub.window.shownWarnings, [], 'the destructive confirm never showed');
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: declining the delete confirm writes nothing', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.quickPickResult = [{ label: 'photo', fieldName: 'photo' }];
  // warningResponse left undefined = dismissed modal.
  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: ATTACH_ROW });
  await settle();

  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: a failed delete UPDATE surfaces as a toast', async () => {
  reset();
  const deps = makeDeps();
  (deps.manager as { executeRaw: unknown }).executeRaw = async () => { throw new Error('boom'); };
  const panel = await panelWithRun(deps);

  stub.window.quickPickResult = [{ label: 'photo', fieldName: 'photo' }];
  stub.window.warningResponse = 'Delete';
  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: ATTACH_ROW });
  await settle();

  assert.deepEqual(stub.window.shownErrors, ['Delete attachment failed: boom']);
});

test('QueryEditorPanel: a multi-field delete dedupes picks into one UPDATE and re-runs', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  stub.window.quickPickResult = [
    { label: 'photo', fieldName: 'photo' },
    { label: 'scan', fieldName: 'scan' },
    { label: 'photo', fieldName: 'photo' }, // a double-pick must not emit a second SET
  ];
  stub.window.warningResponse = 'Delete';
  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: ATTACH_ROW });
  await settle();

  assert.equal(deps.rawCalls.length, 1, 'one UPDATE for the whole selection');
  assert.equal(
    deps.rawCalls[0]!.query,
    'UPDATE `tasks` SET `photo` = NULL, `scan` = NULL WHERE _id = :docId',
  );
  assert.deepEqual(stub.window.shownInfos, ['Cleared 2 attachment fields on tasks/a.']);
  const results = postedOfType(panel.webview.posted, 'query.result');
  assert.equal(results.length, 2, 'the query re-ran so cleared fields disappear');
});

// ─── Attachment guards ─────────────────────────────────────────

test('QueryEditorPanel: attachment actions on an inactive connection warn instead of writing', async () => {
  reset();
  const deps = makeDeps({ activeId: 'db-B' });
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownWarnings, ['Connect to this database first.']);
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: attachment actions before any run explain what is missing', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.deleteAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(stub.window.shownWarnings, [
    'Run a query first so we know which collection to target.',
  ]);
});

test('QueryEditorPanel: attachment actions on a system collection are refused', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT * FROM __presence');

  firstPanel().fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.equal(stub.window.shownWarnings.length, 1);
  assert.match(stub.window.shownWarnings[0]!, /single user collection/);
  assert.match(stub.window.shownWarnings[0]!, /__presence/);
  assert.equal(deps.rawCalls.length, 0);
});

test('QueryEditorPanel: attachment actions on a FROM-less query are refused', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  await runQuery(firstPanel(), 'SELECT 1');

  firstPanel().fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.match(stub.window.shownWarnings[0] ?? '', /no FROM clause/);
});

test('QueryEditorPanel: an unparseable row is an error toast, arrays and id-less rows are warnings', async () => {
  reset();
  const deps = makeDeps();
  const panel = await panelWithRun(deps);

  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{not json' });
  await settle();
  assert.deepEqual(stub.window.shownErrors, ['Could not parse the selected row.']);

  panel.fireMessage({ type: 'query.addAttachment', rowJson: '[1,2]' });
  await settle();
  assert.ok(stub.window.shownWarnings.some(w => w.includes('not a document object')));

  stub.window.shownWarnings.length = 0;
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":42}' });
  await settle();
  assert.deepEqual(stub.window.shownWarnings, [
    'The selected row has no string `_id` — cannot target it.',
  ]);
  assert.equal(deps.rawCalls.length, 0, 'none of the malformed rows reached the database');
});

// ─── Inspector / stores integration ────────────────────────────

test('QueryEditorPanel: rowSelected forwards the row JSON to the Inspector', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.rowSelected', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(deps.inspector.selectedJson, ['{"_id":"a"}']);
});

test('QueryEditorPanel: rowActivated flips the Inspector to the JSON tab', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.rowActivated', rowJson: '{"_id":"a"}' });
  await settle();

  assert.deepEqual(deps.inspector.selectedJson, ['{"_id":"a"}']);
  assert.deepEqual(deps.inspector.queryTabs, ['json']);
});

test('QueryEditorPanel: starCurrent adds the query to favorites for this database', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.starCurrent', query: 'SELECT * FROM tasks' });
  await settle();

  assert.deepEqual(deps.favorites.adds, [{ databaseId: 'db-A', query: 'SELECT * FROM tasks' }]);
});

test('QueryEditorPanel: textChanged persists the tab text and retitles the tab', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.textChanged', text: 'SELECT * FROM users' });
  await settle();

  const tabs = deps.tracker.get('db-A').query;
  assert.equal(tabs.length, 1, 'the tab keeps a single slot — no per-keystroke entries');
  assert.equal(tabs[0]!.text, 'SELECT * FROM users');
  assert.equal(firstPanel().title, 'SELECT * FROM users');
});

test('QueryEditorPanel: long query text collapses whitespace and truncates the tab title', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  const long = `SELECT *\nFROM   ${'x'.repeat(80)}`;
  firstPanel().fireMessage({ type: 'query.textChanged', text: long });
  await settle();

  const title = firstPanel().title;
  assert.equal(title.length, 60, 'truncated to the 60-char cap');
  assert.ok(title.endsWith('…'));
  assert.ok(!title.includes('\n'), 'newlines collapsed');
});

test('QueryEditorPanel: an empty query text falls back to the Query title', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'query.textChanged', text: '   ' });
  await settle();

  assert.equal(firstPanel().title, 'Query');
});

test('QueryEditorPanel: loadQuery pushes the text to the webview and retitles', async () => {
  reset();
  const deps = makeDeps();
  const instance = showPanel(deps);
  assert.ok(instance);
  await settle();

  instance.loadQuery('SELECT * FROM loaded');
  await settle();

  const sets = postedOfType<{ text: string }>(firstPanel().webview.posted, 'query.setText');
  assert.deepEqual(sets.map(s => s.text), ['SELECT * FROM loaded']);
  assert.equal(firstPanel().title, 'SELECT * FROM loaded');
});

test('QueryEditorPanel: refocusing a tab re-pushes its last run to the Inspector', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  const panel = firstPanel();
  await settle();
  await runQuery(panel, 'SELECT * FROM tasks');
  panel.fireMessage({ type: 'query.rowSelected', rowJson: '{"_id":"a"}' });
  await settle();

  const metadataBefore = deps.inspector.metadata.length;
  const selectedBefore = deps.inspector.selectedJson.length;

  panel.fireViewState(true);
  await settle();

  assert.deepEqual(deps.inspector.features.at(-1), { kind: 'query', databaseId: 'db-A' });
  assert.equal(deps.inspector.metadata.length, metadataBefore + 1,
    'the last result metadata is re-pushed on focus');
  assert.equal(deps.inspector.selectedJson.length, selectedBefore + 1);
  assert.equal(deps.inspector.selectedJson.at(-1), '{"_id":"a"}',
    'and the row selection survives the tab switch');
});

// ─── Init pushes ───────────────────────────────────────────────

test('QueryEditorPanel: modeInit offers local only without an HTTP API config', async () => {
  reset();
  const deps = makeDeps({ config: undefined });
  showPanel(deps);
  await settle();

  const modes = postedOfType<{ availableModes: string[] }>(firstPanel().webview.posted, 'query.modeInit');
  assert.deepEqual(modes.map(m => m.availableModes), [['local']]);
});

test('QueryEditorPanel: modeInit offers http when url and key are both present', async () => {
  reset();
  const deps = makeDeps({
    config: HTTP_CONFIG,
    secretsImpl: () => Promise.resolve({ httpApiKey: 'key-1' }),
  });
  showPanel(deps);
  await settle();

  const modes = postedOfType<{ availableModes: string[] }>(firstPanel().webview.posted, 'query.modeInit');
  assert.deepEqual(modes.map(m => m.availableModes), [['local', 'http']]);
});

test('QueryEditorPanel: a secrets-read failure during modeInit degrades to local with a log line', async () => {
  reset();
  const deps = makeDeps({
    config: HTTP_CONFIG,
    secretsImpl: () => Promise.reject(new Error('keychain locked')),
  });
  showPanel(deps);
  await settle();

  const modes = postedOfType<{ availableModes: string[] }>(firstPanel().webview.posted, 'query.modeInit');
  assert.deepEqual(modes.map(m => m.availableModes), [['local']]);
  assert.ok(deps.logs.warns.some(w => /Could not read secrets for mode init/.test(w)));
});

test('QueryEditorPanel: settings are pushed on init with their defaults', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  const settings = postedOfType<{ collectProfiling: boolean; collectMetrics: boolean }>(
    firstPanel().webview.posted, 'query.settings',
  );
  assert.deepEqual(settings.map(s => [s.collectProfiling, s.collectMetrics]), [[true, true]]);
});
