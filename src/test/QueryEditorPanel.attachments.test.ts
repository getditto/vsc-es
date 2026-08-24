import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { QueryEditorPanel } from '../panels/QueryEditorPanel.js';
import { OpenPanelsTracker } from '../ditto/OpenPanelsTracker.js';
import type { Logger, LogLevel } from '../logging/types.js';

/**
 * Attachment add/delete behaviour of the Query Editor panel. These cover the
 * DQL the panel emits from a right-click action — the one builder in the
 * extension that had bypassed quoteIdentifier and crashed on backticked
 * collection names or exotic field names.
 */

const stub = vscode as unknown as {
  createdWebviewPanels: {
    disposed: boolean;
    webview: { posted: unknown[] };
    dispose(): void;
    fireMessage(msg: unknown): void;
  }[];
  window: {
    openDialogResult: unknown;
    quickPickResult: unknown;
    inputBoxResult: unknown;
    warningResponse: unknown;
    lastInputBoxValidate: ((v: string) => string | null) | undefined;
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

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return self;
};

interface RecordedExecute {
  query: string;
  args?: Record<string, unknown> | undefined;
}

/** Minimal manager fake: runs stay local, executeRaw is recorded. */
function makeManager() {
  const recorded: RecordedExecute[] = [];
  const manager = {
    getActiveConfigId: () => 'db-A',
    executeQuery: async (query: string) => ({
      rows: [{ _id: 'a' }],
      durationMs: 1,
      metadata: {
        dql: query, durationMs: 1, resultCount: 1, explain: '', timestamp: 0,
      },
    }),
    executeRaw: async (query: string, args?: Record<string, unknown>) => {
      recorded.push({ query, args });
      return [];
    },
    newAttachment: async (_path: string, metadata: Record<string, string>) => ({
      id: 'att-new', len: Number(metadata.length ?? 0), metadata,
    }),
  };
  return { manager, recorded };
}

function showPanel(manager: ReturnType<typeof makeManager>['manager']): void {
  const context = {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: memento(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  QueryEditorPanel.show(
    context,
    manager as never,
    { get: () => undefined } as never,              // configs
    { read: async () => ({}) } as never,            // secrets
    'db-A',
    new OpenPanelsTracker(memento()),
    {
      setActiveFeature: () => {},
      setLastResultMetadata: () => {},
      setSelectedRowJson: () => {},
      setQueryTab: async () => {},
    } as never,
    { add: async () => {} } as never,               // history
    { add: async () => {} } as never,               // favorites
    { capture: () => {} } as never,                 // metrics
    noopLogger(),
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

/** Run a query so lastMetadata is set — the attachment actions target the
 *  collection of the last executed query. */
async function runQuery(panel: { fireMessage(msg: unknown): void }, dql: string): Promise<void> {
  panel.fireMessage({ type: 'query.run', query: dql, mode: 'local' });
  await settle();
}

function reset(): void {
  QueryEditorPanel.dispose();
  stub.__resetStub();
}

test('QueryEditorPanel: add attachment backtick-quotes the backticked collection and exotic field', async () => {
  reset();
  const { manager, recorded } = makeManager();
  showPanel(manager);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  await runQuery(panel, 'SELECT * FROM `my coll`');

  stub.window.openDialogResult = [stub.Uri.file('/tmp/pic.png')];
  stub.workspace.fsStatSize = 1234;
  stub.window.inputBoxResult = 'order-items';
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  assert.equal(recorded.length, 1, `one UPDATE executed; saw ${JSON.stringify(recorded.map(r => r.query))}`);
  assert.equal(
    recorded[0]?.query,
    'UPDATE `my coll` SET `order-items` = :att WHERE _id = :docId',
  );
  assert.equal(recorded[0]?.args?.docId, 'a');
  assert.deepEqual(
    stub.window.shownErrors, [],
    `no error toast expected; saw ${JSON.stringify(stub.window.shownErrors)}`,
  );
});

test('QueryEditorPanel: delete attachment quotes an exotic field and the collection', async () => {
  reset();
  const { manager, recorded } = makeManager();
  showPanel(manager);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  await runQuery(panel, 'SELECT * FROM `my coll`');

  const row = JSON.stringify({
    _id: 'a',
    Bestellungen: { id: 'att-1', len: 10, metadata: { filename: 'f.png' } },
  });
  stub.window.quickPickResult = [{ label: 'Bestellungen', fieldName: 'Bestellungen' }];
  stub.window.warningResponse = 'Delete';
  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: row });
  await settle();

  assert.equal(recorded.length, 1, `one UPDATE executed; saw ${JSON.stringify(recorded.map(r => r.query))}`);
  assert.equal(
    recorded[0]?.query,
    'UPDATE `my coll` SET `Bestellungen` = NULL WHERE _id = :docId',
  );
  assert.equal(recorded[0]?.args?.docId, 'a');
});

test('QueryEditorPanel: a JSON null row is rejected with a readable warning, not a TypeError', async () => {
  // 'null' parses cleanly, so the old rowJson handler crashed reading
  // `_id` off null — the user saw a raw TypeError instead of "wrong row".
  reset();
  const { manager, recorded } = makeManager();
  showPanel(manager);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  await runQuery(panel, 'SELECT * FROM tasks');

  panel.fireMessage({ type: 'query.deleteAttachment', rowJson: 'null' });
  await settle();

  assert.equal(recorded.length, 0, 'no UPDATE executed');
  assert.deepEqual(stub.window.shownErrors, [], 'no raw error toast');
  assert.ok(
    stub.window.shownWarnings.some(w => w.includes('not a document object')),
    `expected a readable warning; saw ${JSON.stringify(stub.window.shownWarnings)}`,
  );
});

test('QueryEditorPanel: the field-name input validator allows quoting-safe names only', async () => {
  reset();
  const { manager } = makeManager();
  showPanel(manager);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  await runQuery(panel, 'SELECT * FROM tasks');
  stub.window.openDialogResult = [stub.Uri.file('/tmp/pic.png')];
  stub.workspace.fsStatSize = 100;
  stub.window.inputBoxResult = undefined; // dismissed — we only want the validator
  panel.fireMessage({ type: 'query.addAttachment', rowJson: '{"_id":"a"}' });
  await settle();

  const validate = stub.window.lastInputBoxValidate;
  assert.ok(validate, 'validateInput reached the stub');
  assert.equal(validate('order-items'), null);
  assert.equal(validate('Bestellungen'), null);
  assert.equal(validate('two words'), null);
  assert.notEqual(validate(''), null, 'empty name has a message');
  assert.notEqual(validate('a\nb'), null, 'control characters are refused');
});
