import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmSwitch, performSwitch, type SwitchDeps, type FromActive } from '../ditto/switch-orchestrator.js';
import type { OpenPanelsTracker, PerDbPanelState, QueryTabState } from '../ditto/OpenPanelsTracker.js';
import type { Logger, LogLevel, LogContext } from '../logging/types.js';
import type { StoredDittoConfig, SecretSet, StoredSubscription } from '../models/DittoConfig.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeConfig(id: string, name: string): StoredDittoConfig {
  return {
    id,
    name,
    databaseId: id,
    mode: 'server',
    authUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false,
  };
}

function noopLogger(): Logger {
  const noop = (_msg: string, _ctx?: LogContext) => {};
  const evt = (_l: (lvl: LogLevel) => void) => ({ dispose() {} });
  const self: Logger = {
    error: noop, warn: noop, info: noop, debug: noop, trace: noop,
    setChannelLevel() {}, getChannelLevel: () => 'info',
    onDidChangeChannelLevel: evt as any,
    setSdkLevel() {}, getSdkLevel: () => 'info',
    onDidChangeSdkLevel: evt as any,
    withTag: () => self,
    readAllLogs: async () => '',
    dispose: async () => {},
  };
  return self;
}

interface Recorded {
  calls: string[];
  modalArgs: Array<{ message: string; buttons: string[] }>;
  errors: string[];
  infos: string[];
  reports: string[];
  // tracker state per-DB (rich form, multi-tab)
  trackerMap: Map<string, PerDbPanelState>;
}

interface DepsOptions {
  open?: Map<string, PerDbPanelState>;            // panels currently open per DB
  configs?: Map<string, StoredDittoConfig>;        // available configs (for rollback lookup)
  modalAnswer?: string | undefined;                // default: 'Switch' for warn modal
  modalAnswerSequence?: Array<string | undefined>; // ordered answers per modal
  connectImpl?: (cfg: StoredDittoConfig) => Promise<void>;
  disconnectImpl?: () => Promise<void>;
}

const EMPTY_STATE: PerDbPanelState = { query: [], peers: false };

function buildDeps(opts: DepsOptions = {}): { deps: SwitchDeps; rec: Recorded } {
  const calls: string[] = [];
  const modalArgs: Array<{ message: string; buttons: string[] }> = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const reports: string[] = [];
  const trackerMap = opts.open ?? new Map<string, PerDbPanelState>();
  const configs = opts.configs ?? new Map<string, StoredDittoConfig>();

  let modalIdx = 0;
  const tracker = {
    get: (id: string) => trackerMap.get(id) ?? EMPTY_STATE,
    hasAny: (id: string) => {
      const s = trackerMap.get(id) ?? EMPTY_STATE;
      return s.query.length > 0 || s.peers;
    },
    count: (id: string) => {
      const s = trackerMap.get(id) ?? EMPTY_STATE;
      return s.query.length + (s.peers ? 1 : 0);
    },
    upsertQueryTab: async (id: string, tab: QueryTabState) => {
      const cur = trackerMap.get(id) ?? EMPTY_STATE;
      const idx = cur.query.findIndex(t => t.id === tab.id);
      const nextQuery = idx >= 0
        ? cur.query.map(t => t.id === tab.id ? tab : t)
        : [...cur.query, tab];
      trackerMap.set(id, { ...cur, query: nextQuery });
    },
    removeQueryTab: async (id: string, tabId: string) => {
      const cur = trackerMap.get(id) ?? EMPTY_STATE;
      trackerMap.set(id, { ...cur, query: cur.query.filter(t => t.id !== tabId) });
    },
    clearQueryTabs: async (id: string) => {
      const cur = trackerMap.get(id) ?? EMPTY_STATE;
      trackerMap.set(id, { ...cur, query: [] });
    },
    setPeers: async (id: string, open: boolean) => {
      const cur = trackerMap.get(id) ?? EMPTY_STATE;
      trackerMap.set(id, { ...cur, peers: open });
    },
    deleteAll: async (id: string) => { trackerMap.delete(id); },
  } as unknown as OpenPanelsTracker;

  const deps: SwitchDeps = {
    manager: {
      connect: async (cfg: StoredDittoConfig, _s: SecretSet, _subs?: StoredSubscription[]) => {
        calls.push(`manager.connect(${cfg.id})`);
        if (opts.connectImpl) await opts.connectImpl(cfg);
      },
      disconnect: async () => {
        calls.push('manager.disconnect');
        if (opts.disconnectImpl) await opts.disconnectImpl();
      },
      isSwitchInProgress: () => false,
      getCurrentLifecycleState: () => ({ kind: 'idle' }),
    },
    configStore: { get: (id: string) => configs.get(id) },
    secretStore: {
      read: async (id: string) => {
        calls.push(`secretStore.read(${id})`);
        return { token: 'tok-' + id };
      },
    },
    subStore: {
      list: (id: string) => {
        calls.push(`subStore.list(${id})`);
        return [];
      },
    },
    tracker,
    logger: noopLogger(),
    ui: {
      showModalWarn: async ({ message, buttons }) => {
        calls.push(`ui.showModalWarn`);
        modalArgs.push({ message, buttons });
        if (opts.modalAnswerSequence) {
          const ans = opts.modalAnswerSequence[modalIdx++];
          return ans;
        }
        return opts.modalAnswer === undefined && !('modalAnswer' in opts)
          ? 'Switch'
          : opts.modalAnswer;
      },
      showError: (msg: string) => { calls.push('ui.showError'); errors.push(msg); },
      showInfo: (msg: string) => { calls.push('ui.showInfo'); infos.push(msg); },
      withProgress: async (_title, work) => {
        calls.push('ui.withProgress');
        await work({ report: (o) => { reports.push(o.message); } });
      },
      statusBarItem: () => ({
        setText: (_t: string) => {},
        show: () => { calls.push('statusBar.show'); },
        dispose: () => { calls.push('statusBar.dispose'); },
      }),
    },
    panels: {
      closeQuery: () => { calls.push('panels.closeQuery'); },
      closePeers: () => { calls.push('panels.closePeers'); },
      closeSubscription: () => { calls.push('panels.closeSubscription'); },
      closeQueryMetrics: () => { calls.push('panels.closeQueryMetrics'); },
      closeDatabaseMetrics: () => { calls.push('panels.closeDatabaseMetrics'); },
      closeImportData: () => { calls.push('panels.closeImportData'); },
      closeObserver: () => { calls.push('panels.closeObserver'); },
      closeObserverEditor: () => { calls.push('panels.closeObserverEditor'); },
      closeAddIndex: () => { calls.push('panels.closeAddIndex'); },
      closeImportSubscriptions: () => { calls.push('panels.closeImportSubscriptions'); },
      showQuery: (id: string, queryText?: string) => {
        calls.push(queryText !== undefined && queryText.length > 0
          ? `panels.showQuery(${id}, "${queryText}")`
          : `panels.showQuery(${id})`);
      },
      showPeers: (id: string) => { calls.push(`panels.showPeers(${id})`); },
    },
  };

  return { deps, rec: { calls, modalArgs, errors, infos, reports, trackerMap } };
}

// ─── Tests ────────────────────────────────────────────────────────────────

// Convenience builders for the new richer state shape.
const stateWith = (overrides: Partial<PerDbPanelState> = {}): PerDbPanelState => ({
  query: [], peers: false, ...overrides,
});

test('switch with empty open-panels set: skips warning modal', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([['A', stateWith()]]),         // no open panels for A
    configs: new Map([['A', A], ['B', B]]),
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  assert.equal(await confirmSwitch(deps, fromActive, B), true);
  await performSwitch(deps, fromActive, B);

  const modalCount = rec.calls.filter(c => c === 'ui.showModalWarn').length;
  assert.equal(modalCount, 0, 'warning modal should not be shown when no panels are open');
  // Sanity: target connect must have run.
  assert.ok(rec.calls.includes('manager.connect(B)'));
});

test('performSwitch never shows the pre-switch modal itself', async () => {
  // The modal must run BEFORE the persistence lock (confirmSwitch) —
  // a modal inside the lock can deadlock deactivate() against a dialog
  // the user may never see.
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([['A', stateWith({ query: [{ id: 't1', text: 'SELECT 1' }] })]]),
    configs: new Map([['A', A], ['B', B]]),
  });
  await performSwitch(deps, { id: 'A', name: 'db-A' }, B);

  assert.equal(rec.calls.filter(c => c === 'ui.showModalWarn').length, 0,
    'the panel-warning modal belongs to confirmSwitch, called before the lock');
  assert.ok(rec.calls.includes('manager.connect(B)'));
});

test('switch with open panels: cancel aborts entire flow', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([['A', stateWith({
      query: [{ id: 't1', text: 'SELECT 1' }],
      peers: true,
    })]]),
    configs: new Map([['A', A], ['B', B]]),
    modalAnswer: undefined,                       // user dismissed without choosing 'Switch'
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  // Production flow: confirmSwitch runs before the lock; a cancel there
  // means performSwitch is never invoked.
  const proceed = await confirmSwitch(deps, fromActive, B);
  assert.equal(proceed, false, 'cancel answers no');

  // Modal was shown.
  const modalCount = rec.calls.filter(c => c === 'ui.showModalWarn').length;
  assert.equal(modalCount, 1, 'warning modal should be shown once');
  // No connect/disconnect or panel operations should have run.
  for (const call of rec.calls) {
    assert.ok(!call.startsWith('manager.connect'), `unexpected manager.connect: ${call}`);
    assert.ok(call !== 'manager.disconnect', 'manager.disconnect should not have been called');
    assert.ok(!call.startsWith('panels.show'), `unexpected ${call}`);
    assert.ok(!call.startsWith('panels.close'), `unexpected ${call}`);
  }
  assert.ok(!rec.calls.includes('ui.withProgress'), 'progress should not have been started');
});

test('switch happy path: closes panels → disconnect → connect → restorePanels in order', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([
      ['A', stateWith()],
      ['B', stateWith({ query: [{ id: 't-B', text: 'SELECT * FROM tasks' }], peers: true })],
    ]),
    configs: new Map([['A', A], ['B', B]]),
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  await performSwitch(deps, fromActive, B);

  // Filter to the call-order signal we care about.
  const sig = rec.calls.filter(c =>
    c === 'panels.closeQuery' || c === 'panels.closePeers' || c === 'panels.closeSubscription' ||
    c === 'panels.closeQueryMetrics' || c === 'panels.closeDatabaseMetrics' ||
    c === 'manager.disconnect' || c.startsWith('manager.connect') ||
    c.startsWith('panels.showQuery') || c.startsWith('panels.showPeers'),
  );
  assert.deepEqual(sig, [
    'panels.closeQuery',
    'panels.closePeers',
    'panels.closeSubscription',
    'panels.closeQueryMetrics',
    'panels.closeDatabaseMetrics',
    'manager.disconnect',
    'manager.connect(B)',
    'panels.showQuery(B, "SELECT * FROM tasks")',
    'panels.showPeers(B)',
  ]);
});

test('restorePanels reopens multiple Query Editor tabs in order with their saved text', async () => {
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([
      ['B', stateWith({
        query: [
          { id: 't1', text: 'SELECT 1' },
          { id: 't2', text: 'SELECT 2' },
          { id: 't3', text: 'SELECT 3' },
        ],
        peers: false,
      }),
    ]]),
    configs: new Map([['B', B]]),
  });
  // Initial connect (no fromActive) hits the same restorePanels at the end.
  await performSwitch(deps, null, B);

  const showCalls = rec.calls.filter(c => c.startsWith('panels.showQuery'));
  assert.deepEqual(showCalls, [
    'panels.showQuery(B, "SELECT 1")',
    'panels.showQuery(B, "SELECT 2")',
    'panels.showQuery(B, "SELECT 3")',
  ]);
});

test('switch failure with rollback: target connect rejects, user picks Reconnect → from-connect runs and panels restore', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');

  // First connect (to B) rejects; second connect (rollback to A) resolves.
  let connectCount = 0;
  const connectImpl = async (cfg: StoredDittoConfig) => {
    connectCount++;
    if (cfg.id === 'B') throw new Error('boom-B');
    // A connect succeeds.
  };

  const { deps, rec } = buildDeps({
    open: new Map([
      ['A', stateWith({ query: [{ id: 't-A', text: 'A-text' }] })],   // A had a query panel
    ]),
    configs: new Map([['A', A], ['B', B]]),
    modalAnswerSequence: ['Switch', 'Reconnect to db-A'], // panel-warn then rollback
    connectImpl,
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  assert.equal(await confirmSwitch(deps, fromActive, B), true, 'panel warning consumed');
  await performSwitch(deps, fromActive, B);

  // Second connect was for fromActive.
  assert.equal(connectCount, 2);
  assert.ok(rec.calls.includes('manager.connect(B)'));
  assert.ok(rec.calls.includes('manager.connect(A)'));

  // Two modals fired (warning + rollback).
  const modalCount = rec.calls.filter(c => c === 'ui.showModalWarn').length;
  assert.equal(modalCount, 2);

  // Restore for A (its query tab text comes back).
  assert.ok(rec.calls.includes('panels.showQuery(A, "A-text")'));
  assert.ok(!rec.calls.includes('panels.showPeers(A)'));

  // Did NOT restore for B (which is the failed target).
  assert.ok(!rec.calls.some(c => c.startsWith('panels.showQuery(B')));
  assert.ok(!rec.calls.includes('panels.showPeers(B)'));

  // No error toast should have fired.
  assert.equal(rec.errors.length, 0);
});

test('rollback failure: target connect rejects, from-connect also rejects, secondary error fires; no restore', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');

  const connectImpl = async (cfg: StoredDittoConfig) => {
    if (cfg.id === 'B') throw new Error('boom-B');
    if (cfg.id === 'A') throw new Error('boom-A');
  };

  const { deps, rec } = buildDeps({
    open: new Map([['A', stateWith({ query: [{ id: 't-A', text: 'A' }] })]]),
    configs: new Map([['A', A], ['B', B]]),
    modalAnswerSequence: ['Switch', 'Reconnect to db-A'],
    connectImpl,
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  assert.equal(await confirmSwitch(deps, fromActive, B), true, 'panel warning consumed');
  await performSwitch(deps, fromActive, B);

  // Both connects attempted.
  assert.ok(rec.calls.includes('manager.connect(B)'));
  assert.ok(rec.calls.includes('manager.connect(A)'));

  // showError fired with the secondary message naming both.
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0], /also failed/);
  assert.match(rec.errors[0], /db-A/);

  // No panel restore.
  assert.ok(!rec.calls.some(c => c.startsWith('panels.showQuery')));
  assert.ok(!rec.calls.some(c => c.startsWith('panels.showPeers')));
});
