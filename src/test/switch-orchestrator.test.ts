import test from 'node:test';
import assert from 'node:assert/strict';
import { performSwitch, type SwitchDeps, type FromActive } from '../ditto/switch-orchestrator.js';
import type { OpenPanelsTracker, OpenPanelKind } from '../ditto/OpenPanelsTracker.js';
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
    websocketUrl: '',
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
    setChannelLevel() {}, getChannelLevel: () => 'info' as LogLevel,
    onDidChangeChannelLevel: evt as any,
    setSdkLevel() {}, getSdkLevel: () => 'info' as LogLevel,
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
  // tracker state per-DB
  trackerMap: Map<string, OpenPanelKind[]>;
}

interface DepsOptions {
  open?: Map<string, OpenPanelKind[]>;          // panels currently open per DB
  configs?: Map<string, StoredDittoConfig>;      // available configs (for rollback lookup)
  modalAnswer?: string | undefined;              // default: 'Switch' for warn modal
  modalAnswerSequence?: Array<string | undefined>; // ordered answers per modal
  connectImpl?: (cfg: StoredDittoConfig) => Promise<void>;
  disconnectImpl?: () => Promise<void>;
}

function buildDeps(opts: DepsOptions = {}): { deps: SwitchDeps; rec: Recorded } {
  const calls: string[] = [];
  const modalArgs: Array<{ message: string; buttons: string[] }> = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const reports: string[] = [];
  const trackerMap = opts.open ?? new Map<string, OpenPanelKind[]>();
  const configs = opts.configs ?? new Map<string, StoredDittoConfig>();

  let modalIdx = 0;
  const tracker = {
    list: (id: string) => trackerMap.get(id) ?? [],
    add: async (id: string, kind: OpenPanelKind) => {
      const cur = trackerMap.get(id) ?? [];
      if (!cur.includes(kind)) trackerMap.set(id, [...cur, kind]);
    },
    remove: async (id: string, kind: OpenPanelKind) => {
      const cur = trackerMap.get(id) ?? [];
      trackerMap.set(id, cur.filter(k => k !== kind));
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
        return { token: 'tok-' + id } as SecretSet;
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
      showQuery: (id: string) => { calls.push(`panels.showQuery(${id})`); },
      showPeers: (id: string) => { calls.push(`panels.showPeers(${id})`); },
    },
  };

  return { deps, rec: { calls, modalArgs, errors, infos, reports, trackerMap } };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test('switch with empty open-panels set: skips warning modal', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([['A', []]]),                  // no open panels for A
    configs: new Map([['A', A], ['B', B]]),
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  await performSwitch(deps, fromActive, B);

  const modalCount = rec.calls.filter(c => c === 'ui.showModalWarn').length;
  assert.equal(modalCount, 0, 'warning modal should not be shown when no panels are open');
  // Sanity: target connect must have run.
  assert.ok(rec.calls.includes('manager.connect(B)'));
});

test('switch with open panels: cancel aborts entire flow', async () => {
  const A = makeConfig('A', 'db-A');
  const B = makeConfig('B', 'db-B');
  const { deps, rec } = buildDeps({
    open: new Map([['A', ['query', 'peers']]]),
    configs: new Map([['A', A], ['B', B]]),
    modalAnswer: undefined,                       // user dismissed without choosing 'Switch'
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  await performSwitch(deps, fromActive, B);

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
    open: new Map([['A', []], ['B', ['query', 'peers']]]),  // target has tracked panels
    configs: new Map([['A', A], ['B', B]]),
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  await performSwitch(deps, fromActive, B);

  // Filter to the call-order signal we care about.
  const sig = rec.calls.filter(c =>
    c === 'panels.closeQuery' || c === 'panels.closePeers' || c === 'panels.closeSubscription' ||
    c === 'manager.disconnect' || c.startsWith('manager.connect') ||
    c.startsWith('panels.showQuery') || c.startsWith('panels.showPeers'),
  );
  assert.deepEqual(sig, [
    'panels.closeQuery',
    'panels.closePeers',
    'panels.closeSubscription',
    'manager.disconnect',
    'manager.connect(B)',
    'panels.showQuery(B)',
    'panels.showPeers(B)',
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
    open: new Map([['A', ['query']]]),                    // A had a query panel
    configs: new Map([['A', A], ['B', B]]),
    modalAnswerSequence: ['Switch', 'Reconnect to db-A'], // panel-warn then rollback
    connectImpl,
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
  await performSwitch(deps, fromActive, B);

  // Second connect was for fromActive.
  assert.equal(connectCount, 2);
  assert.ok(rec.calls.includes('manager.connect(B)'));
  assert.ok(rec.calls.includes('manager.connect(A)'));

  // Two modals fired (warning + rollback).
  const modalCount = rec.calls.filter(c => c === 'ui.showModalWarn').length;
  assert.equal(modalCount, 2);

  // Restore for A (its panel set was {query}).
  assert.ok(rec.calls.includes('panels.showQuery(A)'));
  assert.ok(!rec.calls.includes('panels.showPeers(A)'));

  // Did NOT restore for B (which is the failed target).
  assert.ok(!rec.calls.includes('panels.showQuery(B)'));
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
    open: new Map([['A', ['query']]]),
    configs: new Map([['A', A], ['B', B]]),
    modalAnswerSequence: ['Switch', 'Reconnect to db-A'],
    connectImpl,
  });
  const fromActive: FromActive = { id: 'A', name: 'db-A' };
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
