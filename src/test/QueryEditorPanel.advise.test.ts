import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QueryEditorPanel } from '../panels/QueryEditorPanel.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { Logger, LogLevel } from '../logging/types.js';
import type { QueryAdvice } from '../ipc/messages.js';

/**
 * ADVISE in the Query Editor: advice extraction onto `query.result`, and
 * the "Create index" action — modal confirm, mid-switch guard, tree refresh
 * via the refreshCollections command seam.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    webview: { posted: unknown[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
  }[];
  window: {
    warningResponse: unknown;
    shownWarnings: string[];
    shownInfos: string[];
  };
  commands: { executed: { command: string; args: unknown[] }[] };
  __resetStub(): void;
};

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return self;
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

const SUGGESTION = {
  collection: 'atest',
  reason: 'equality predicates on `e`',
  statement: 'CREATE INDEX IF NOT EXISTS adv_atest_e ON default:`atest` (`e` ASC)',
};

const ADVICE_ROWS = [{
  advice: {
    statement: 'SELECT * FROM atest WHERE e = 1\n',
    suggestedIndexes: [SUGGESTION],
  },
}];

function makeManager(opts: {
  /** First call returns 'db-A', subsequent calls 'db-B' (mid-switch simulation). */
  switchAfterFirstRead?: boolean;
  /** Every call reports a different connection (disconnected tab). */
  neverActive?: boolean;
} = {}) {
  const executed: string[] = [];
  let activeReads = 0;
  const manager = {
    getActiveConfigId: () => {
      if (opts.neverActive) { return 'other-db'; }
      activeReads += 1;
      return opts.switchAfterFirstRead && activeReads > 1 ? 'db-B' : 'db-A';
    },
    executeQuery: async (query: string) => ({
      rows: query.trimStart().toUpperCase().startsWith('ADVISE') ? ADVICE_ROWS : [{ _id: 'a' }],
      durationMs: 1,
      metadata: { dql: query, durationMs: 1, resultCount: 1, explain: '', timestamp: 0 },
    }),
    executeRaw: async (query: string) => { executed.push(query); return []; },
  };
  return { manager, executed };
}

function showPanel(manager: unknown): void {
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  QueryEditorPanel.show(
    context,
    manager as never,
    { get: () => ({}) } as never,           // configs
    { read: async () => ({}) } as never,    // secrets
    'db-A',
    new OpenPanelsTracker(memento()),
    {
      setActiveFeature: () => {},
      setLastResultMetadata: () => {},
      setSelectedRowJson: () => {},
      setQueryTab: async () => {},
    } as never,
    { add: async () => {} } as never,
    { add: async () => {} } as never,
    { capture: () => {} } as never,
    noopLogger(),
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

test.beforeEach(() => {
  stub.__resetStub();
  QueryEditorPanel.dispose();
});
test.afterEach(() => {
  QueryEditorPanel.dispose();
  stub.__resetStub();
});

function firstPanel(): (typeof stub.createdWebviewPanels)[number] {
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel, 'panel was created');
  return panel;
}

function postedOf<T>(type: string): T[] {
  return firstPanel().webview.posted.filter(m => (m as { type: string }).type === type) as T[];
}

test('Query Editor: ADVISE results carry the extracted advice on query.result', async () => {
  showPanel(makeManager().manager);
  firstPanel().fireMessage({ type: 'query.run', query: 'ADVISE SELECT * FROM atest WHERE e = 1', mode: 'local' });
  await settle();

  const results = postedOf<{ advice?: QueryAdvice | null }>('query.result');
  assert.equal(results.length, 1, 'one result posted');
  assert.deepEqual(results[0]?.advice, {
    statement: 'SELECT * FROM atest WHERE e = 1\n',
    suggestions: [SUGGESTION],
  });
});

test('Query Editor: non-ADVISE results carry a null advice field', async () => {
  showPanel(makeManager().manager);
  firstPanel().fireMessage({ type: 'query.run', query: 'SELECT * FROM t', mode: 'local' });
  await settle();
  const results = postedOf<{ advice?: QueryAdvice | null }>('query.result');
  assert.equal(results[0]?.advice, null);
});

test('Query Editor: "Create index" confirms, executes the suggestion verbatim, refreshes the tree', async () => {
  const { manager, executed } = makeManager();
  showPanel(manager);
  stub.window.warningResponse = 'Create Index';
  firstPanel().fireMessage({ type: 'query.createSuggestedIndex', statement: SUGGESTION.statement, collection: 'atest' });
  await settle();

  assert.deepEqual(executed, [SUGGESTION.statement], 'the exact suggested statement ran through executeRaw');
  assert.ok(
    stub.commands.executed.some(c => c.command === 'dittoVsce.refreshCollections'),
    `tree refresh kicked: ${JSON.stringify(stub.commands.executed)}`,
  );
  const feedback = postedOf<{ outcome: string }>('query.adviseFeedback');
  assert.deepEqual(feedback.map(f => f.outcome), ['created']);
});

test('Query Editor: declining the confirm modal writes nothing and reports declined', async () => {
  const { manager, executed } = makeManager();
  showPanel(manager);
  // warningResponse left undefined = modal dismissed.
  firstPanel().fireMessage({ type: 'query.createSuggestedIndex', statement: SUGGESTION.statement, collection: 'atest' });
  await settle();
  assert.deepEqual(executed, []);
  const feedback = postedOf<{ outcome: string }>('query.adviseFeedback');
  assert.deepEqual(feedback.map(f => f.outcome), ['declined']);
});

test('Query Editor: a switch between click and confirm aborts the write (mid-switch guard)', async () => {
  const { manager, executed } = makeManager({ switchAfterFirstRead: true });
  showPanel(manager);
  stub.window.warningResponse = 'Create Index';
  firstPanel().fireMessage({ type: 'query.createSuggestedIndex', statement: SUGGESTION.statement, collection: 'atest' });
  await settle();

  assert.deepEqual(executed, [], 'the CREATE never ran against the NEW database');
  const feedback = postedOf<{ outcome: string; message?: string }>('query.adviseFeedback');
  assert.equal(feedback[0]?.outcome, 'failed');
  assert.match(feedback[0]?.message ?? '', /active connection changed/i);
});

test('Query Editor: disconnected tab refuses before showing the modal', async () => {
  const { manager, executed } = makeManager({ neverActive: true });
  showPanel(manager);
  stub.window.warningResponse = 'Create Index';
  firstPanel().fireMessage({ type: 'query.createSuggestedIndex', statement: SUGGESTION.statement, collection: 'atest' });
  await settle();

  assert.deepEqual(executed, []);
  assert.deepEqual(stub.window.shownWarnings, [], 'no confirm modal was shown');
  const feedback = postedOf<{ outcome: string; message?: string }>('query.adviseFeedback');
  assert.equal(feedback[0]?.outcome, 'failed');
  assert.match(feedback[0]?.message ?? '', /not the active connection/i);
});
