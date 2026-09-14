import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as vscode from 'vscode';
import type { Logger, LogLevel } from '../logging/types.js';
import type { ImportableSubscription } from '../ditto/import-subscription-parser.js';
import type { StoredSubscription } from '../models/DittoConfig.js';

/**
 * ImportSubscriptionsPanel behaviour: the __small_peer_info fetch (through a
 * scripted HttpQueryService), row filtering, per-row import outcomes, and the
 * singleton lifecycle.
 *
 * The panel imports `executeRemoteQuery` as a module binding, so there is no
 * constructor seam to inject through — the `registerHooks` resolve hook below
 * rewrites the panel's `../ditto/HttpQueryService.js` import to the scripted
 * fake in `fixtures/`. node:test runs each test FILE in its own process, so
 * the hook is invisible to every other suite.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/HttpQueryService.js')
        && context.parentURL?.endsWith('/src/panels/ImportSubscriptionsPanel.ts')) {
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
const { ImportSubscriptionsPanel } = await import('../panels/ImportSubscriptionsPanel.js');

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    title: string;
    revealCount: number;
    webview: { posted: unknown[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
  }[];
  window: { shownInfos: string[]; shownErrors: string[] };
  __resetStub(): void;
};

function recordingLogger(): { logger: Logger; errors: string[]; warns: string[] } {
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

interface Deps {
  configStore: unknown;
  secretStore: unknown;
  subs: unknown;
  manager: unknown;
  logger: Logger;
  errors: string[];
  warns: string[];
  saved: { databaseId: string; sub: StoredSubscription }[];
  registered: { id: string; query: string }[];
  existing: StoredSubscription[];
  state: { activeId: string | null };
}

const DEFAULT_CONFIG = {
  id: 'db-A',
  name: 'DB',
  httpApiUrl: 'example.ditto.live:443',
  allowUntrustedCerts: false,
};

function makeDeps(opts: {
  config?: unknown;
  secrets?: unknown;
  secretsImpl?: () => Promise<unknown>;
  existing?: StoredSubscription[];
  failSaveOn?: (query: string) => boolean;
  failRegisterOn?: (query: string) => boolean;
} = {}): Deps {
  const saved: Deps['saved'] = [];
  const registered: Deps['registered'] = [];
  const state = { activeId: 'db-A' as string | null };
  const { logger, errors, warns } = recordingLogger();
  // `config: undefined` is a meaningful value (the connection is gone) —
  // distinguish "not passed" from "passed undefined" with hasOwn.
  const config = Object.hasOwn(opts, 'config') ? opts.config : DEFAULT_CONFIG;
  return {
    saved, registered, state, errors, warns, logger,
    existing: opts.existing ?? [],
    configStore: { get: () => config },
    secretStore: {
      read: opts.secretsImpl ?? (() => Promise.resolve(opts.secrets ?? { httpApiKey: 'key-1' })),
    },
    subs: {
      list: () => opts.existing ?? [],
      save: async (databaseId: string, sub: StoredSubscription) => {
        if (opts.failSaveOn?.(sub.query)) { throw new Error('disk full'); }
        saved.push({ databaseId, sub });
      },
    },
    manager: {
      getActiveConfigId: () => state.activeId,
      registerSubscription: (id: string, query: string) => {
        if (opts.failRegisterOn?.(query)) { throw new Error('query/invalid: expected an expression'); }
        registered.push({ id, query });
      },
    },
  };
}

function showPanel(deps: Deps, databaseId = 'db-A'): void {
  ImportSubscriptionsPanel.show(
    { extensionUri: vscode.Uri.file('/ext') } as never,
    deps.configStore as never,
    deps.secretStore as never,
    deps.subs as never,
    deps.manager as never,
    databaseId,
    deps.logger,
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

function postedOfType<T>(posted: unknown[], type: string): T[] {
  return posted.filter(
    (m): m is T => typeof m === 'object' && m !== null && (m as { type?: string }).type === type,
  );
}

function firstPanel(): (typeof stub.createdWebviewPanels)[number] {
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel, 'panel was created');
  return panel;
}

/** The singleton registry, the stub recorders, and the scripted HTTP layer
 *  are all module-global — reset all three between tests. */
function reset(): void {
  ImportSubscriptionsPanel.dispose();
  fakeHttp.__resetFakeHttp();
  stub.__resetStub();
}

test('ImportSubscriptionsPanel: loads and filters __small_peer_info rows into importable subscriptions', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async (req) => {
    fetches += 1;
    assert.equal(req.query, 'SELECT * FROM __small_peer_info');
    assert.equal(req.httpApiUrl, 'example.ditto.live:443');
    assert.equal(req.httpApiKey, 'key-1');
    return {
      items: [
        {
          _id: 'peer-1',
          device_name: 'iPhone 15',
          ditto_sdk_platform: 'iOS',
          ditto_sdk_version: '4.7.0',
          local_subscriptions: {
            queries: [
              { query: 'SELECT * FROM tasks' },
              { query: 'SELECT * FROM __presence' },   // system collection → dropped
              { query: 'SELECT * FROM existing' },     // already stored → dropped
              { query: 'SELECT 1' },                   // no FROM → dropped
            ],
          },
        },
        { device_name: 'no id at all' },               // missing _id → not SmallPeerInfo
        null,                                          // malformed wire row
        'just a string',                               // malformed wire row
        {
          _id: 'peer-2',
          // no device_name → the peer id is the label; no platform → 'Unknown'
          local_subscriptions: {
            queries: [
              { query: 'SELECT * FROM tasks' },        // dup of peer-1's → collapsed
              { query: 'SELECT * FROM users' },
            ],
          },
        },
        { _id: 'peer-3' },                             // no local_subscriptions → skipped
      ],
    };
  });
  const deps = makeDeps({
    existing: [{ id: 's1', name: 'old', query: 'SELECT * FROM existing' }],
  });
  showPanel(deps);
  await settle();

  assert.equal(fetches, 1);
  const types = firstPanel().webview.posted.map(m => (m as { type: string }).type);
  assert.deepEqual(types, ['importSubs.loading', 'importSubs.loaded'],
    'loading is posted before the result so the webview can show a spinner');

  const loaded = postedOfType<{ subscriptions: ImportableSubscription[] }>(
    firstPanel().webview.posted, 'importSubs.loaded',
  );
  assert.deepEqual(loaded[0]?.subscriptions, [
    {
      id: 'import:SELECT * FROM tasks',
      deviceName: 'iPhone 15',
      deviceInfo: 'iOS 4.7.0',
      collectionName: 'tasks',
      query: 'SELECT * FROM tasks',
    },
    {
      id: 'import:SELECT * FROM users',
      deviceName: 'peer-2',
      deviceInfo: 'Unknown',
      collectionName: 'users',
      query: 'SELECT * FROM users',
    },
  ]);
});

test('ImportSubscriptionsPanel: a missing connection reports instead of fetching', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { fetches += 1; return { items: [] }; });
  const deps = makeDeps({ config: undefined });
  showPanel(deps);
  await settle();

  assert.equal(fetches, 0, 'no config → no HTTP call');
  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'importSubs.error');
  assert.deepEqual(errors.map(e => e.message), ['Connection no longer exists.']);
});

test('ImportSubscriptionsPanel: a secrets-store failure names the cause', async () => {
  reset();
  const deps = makeDeps({ secretsImpl: () => Promise.reject(new Error('keychain locked')) });
  showPanel(deps);
  await settle();

  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'importSubs.error');
  assert.deepEqual(errors.map(e => e.message), ['Could not read secrets: keychain locked']);
});

test('ImportSubscriptionsPanel: a connection without an HTTP API URL is refused', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { fetches += 1; return { items: [] }; });
  const deps = makeDeps({ config: { id: 'db-A', name: 'DB' } });
  showPanel(deps);
  await settle();

  assert.equal(fetches, 0);
  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'importSubs.error');
  assert.deepEqual(errors.map(e => e.message), [
    'This connection does not have an HTTP API URL and key configured.',
  ]);
});

test('ImportSubscriptionsPanel: a missing httpApiKey secret is refused the same way', async () => {
  reset();
  const deps = makeDeps({ secrets: {} });
  showPanel(deps);
  await settle();

  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'importSubs.error');
  assert.deepEqual(errors.map(e => e.message), [
    'This connection does not have an HTTP API URL and key configured.',
  ]);
});

test('ImportSubscriptionsPanel: a failed fetch posts the server error and logs it', async () => {
  reset();
  fakeHttp.__setExecuteRemoteQuery(async () => {
    throw new Error('Ditto Server returned 401');
  });
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  const types = firstPanel().webview.posted.map(m => (m as { type: string }).type);
  assert.deepEqual(types, ['importSubs.loading', 'importSubs.error']);
  const errors = postedOfType<{ message: string }>(firstPanel().webview.posted, 'importSubs.error');
  assert.deepEqual(errors.map(e => e.message), ['Ditto Server returned 401']);
  assert.equal(deps.errors.length, 1, 'the failure is logged, not just posted');
});

test('ImportSubscriptionsPanel: importSelected saves and registers each query, then closes', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM tasks', 'SELECT * FROM `my coll`'],
  });
  await settle();

  const statuses = postedOfType<{ status: string }>(firstPanel().webview.posted, 'importSubs.importing');
  assert.deepEqual(statuses.map(s => s.status), [
    'Importing 1 of 2: tasks…',
    'Importing 2 of 2: `my coll`…',
  ]);

  assert.equal(deps.saved.length, 2);
  assert.equal(deps.saved[0]!.databaseId, 'db-A');
  assert.equal(deps.saved[0]!.sub.name, 'Imported: tasks');
  assert.equal(deps.saved[0]!.sub.query, 'SELECT * FROM tasks');
  assert.match(deps.saved[0]!.sub.id, /^[0-9a-f]{32}$/, 'randomId(16) = 32 hex chars');
  assert.equal(deps.saved[1]!.sub.name, 'Imported: `my coll`');

  assert.deepEqual(
    deps.registered,
    deps.saved.map(s => ({ id: s.sub.id, query: s.sub.query })),
    'every imported subscription registers live on the active connection',
  );

  const done = postedOfType<{ count: number }>(firstPanel().webview.posted, 'importSubs.imported');
  assert.deepEqual(done.map(d => d.count), [2]);
  assert.deepEqual(stub.window.shownInfos, ['Imported 2 subscriptions.']);
  assert.equal(firstPanel().disposed, true, 'the flow ends by closing the panel');
});

test('ImportSubscriptionsPanel: importSelected skips SDK registration when the connection is inactive', async () => {
  reset();
  const deps = makeDeps();
  deps.state.activeId = 'db-B'; // switched away after the panel opened
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM tasks'],
  });
  await settle();

  assert.equal(deps.saved.length, 1, 'the subscription is still stored');
  assert.equal(deps.registered.length, 0, 'but nothing registers against the NEW database');
  assert.deepEqual(stub.window.shownInfos, ['Imported 1 subscription.'], 'singular inflection');
});

test('ImportSubscriptionsPanel: a per-row save failure does not sink the rest of the selection', async () => {
  reset();
  const deps = makeDeps({ failSaveOn: (query) => query.includes('doomed') });
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM tasks', 'SELECT * FROM doomed', 'SELECT * FROM users'],
  });
  await settle();

  assert.deepEqual(
    deps.saved.map(s => s.sub.query),
    ['SELECT * FROM tasks', 'SELECT * FROM users'],
    'the failed row is skipped, the rest land',
  );
  assert.equal(deps.registered.length, 2);
  const done = postedOfType<{ count: number }>(firstPanel().webview.posted, 'importSubs.imported');
  assert.deepEqual(done.map(d => d.count), [2], 'the count reflects actual successes');
  assert.equal(deps.warns.length, 1, 'the failed row is logged');
  assert.deepEqual(stub.window.shownInfos, ['Imported 2 subscriptions.']);
});

test('ImportSubscriptionsPanel: a registration failure still counts as imported and is logged distinctly from a save failure', async () => {
  // Regression: registerSubscription threw for a syntactically-invalid
  // imported query INSIDE the save try/catch, so the row was logged as
  // "Failed to save imported subscription" and under-counted even though
  // it HAD persisted.
  reset();
  const deps = makeDeps({ failRegisterOn: (query) => query.includes('oops') });
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM tasks', 'SELECT WHERE oops'],
  });
  await settle();

  assert.equal(deps.saved.length, 2, 'both rows persisted');
  assert.equal(deps.registered.length, 1, 'only the valid one registered live');
  const done = postedOfType<{ count: number }>(firstPanel().webview.posted, 'importSubs.imported');
  assert.deepEqual(done.map(d => d.count), [2], 'the count reflects saves, not registrations');
  assert.equal(deps.warns.length, 1);
  assert.ok(deps.warns[0]!.includes('could not start'), 'logged as a registration failure, not a save failure');
  assert.deepEqual(stub.window.shownInfos, ['Imported 2 subscriptions.']);
});

test('ImportSubscriptionsPanel: a query without a FROM clause imports under the unknown label', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({
    type: 'importSubs.importSelected',
    queries: ['UPDATE tasks SET done = true'],
  });
  await settle();

  const statuses = postedOfType<{ status: string }>(firstPanel().webview.posted, 'importSubs.importing');
  assert.deepEqual(statuses.map(s => s.status), ['Importing 1 of 1: unknown…']);
  assert.equal(deps.saved[0]?.sub.name, 'Imported: unknown');
});

test('ImportSubscriptionsPanel: cancel closes the panel without importing', async () => {
  reset();
  const deps = makeDeps();
  showPanel(deps);
  await settle();

  firstPanel().fireMessage({ type: 'importSubs.cancel' });
  await settle();

  assert.equal(firstPanel().disposed, true);
  assert.equal(deps.saved.length, 0);
});

test('ImportSubscriptionsPanel: re-show for the same database reveals instead of refetching', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { fetches += 1; return { items: [] }; });
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  assert.equal(fetches, 1);

  showPanel(deps);
  await settle();

  assert.equal(stub.createdWebviewPanels.length, 1, 'no second panel built');
  assert.equal(firstPanel().revealCount, 1, 'the existing one was revealed');
  assert.equal(fetches, 1, 'no refetch — the list on screen is still valid');
});

test('ImportSubscriptionsPanel: a fresh show after dispose refetches', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { fetches += 1; return { items: [] }; });
  const deps = makeDeps();
  showPanel(deps);
  await settle();
  ImportSubscriptionsPanel.dispose();
  assert.equal(firstPanel().disposed, true);

  showPanel(deps);
  await settle();

  assert.equal(stub.createdWebviewPanels.length, 2, 'a new panel was built');
  assert.equal(fetches, 2, 'and it pulled a fresh subscription list');
});

test('ImportSubscriptionsPanel: show for a different database tears the old panel down', async () => {
  reset();
  let fetches = 0;
  fakeHttp.__setExecuteRemoteQuery(async () => { fetches += 1; return { items: [] }; });
  const deps = makeDeps();
  showPanel(deps, 'db-A');
  await settle();

  showPanel(deps, 'db-B');
  await settle();

  assert.equal(firstPanel().disposed, true);
  assert.equal(stub.createdWebviewPanels.length, 2);
  assert.equal(fetches, 2, 'the new database fetches its own list');
});

test('ImportSubscriptionsPanel: a missing config titles the panel Unknown', async () => {
  reset();
  const deps = makeDeps({ config: undefined });
  showPanel(deps);
  assert.equal(firstPanel().title, 'Import Subscriptions — Unknown');
});
