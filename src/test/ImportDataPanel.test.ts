import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ImportDataPanel, MAX_IMPORT_BYTES } from '../panels/ImportDataPanel.js';
import type { Logger, LogLevel } from '../logging/types.js';

/**
 * ImportDataPanel behaviour that needs the real panel: file-size gate and
 * the chooseFile happy path. The open dialog is faked through the stub's
 * `window.openDialogResult` seam; the file itself is real (a sparse file via
 * truncate gives a >100 MB stat without writing >100 MB).
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
    shownErrors: string[];
  };
  workspace: { fsStatSize: number };
  Uri: { file(p: string): unknown };
  __resetStub(): void;
};

function noopLogger(): Logger {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return self;
}

function fakeContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('/ext'),
    globalState: {
      keys: () => [...store.keys()],
      get: <T>(k: string, d?: T) => (store.has(k) ? store.get(k) : d) as T,
      update: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
    },
  } as unknown as vscode.ExtensionContext;
}

function showPanel(): void {
  ImportDataPanel.show(
    fakeContext(),
    { get: () => ({ name: 'DB' }) } as never,                        // configStore
    { getActiveConfigId: () => 'db-A', executeRaw: async () => [] } as never, // manager
    { current: () => [] } as never,                                   // collectionsRepo
    'db-A',
    noopLogger(),
  );
}

function postedOfType<T>(posted: unknown[], type: string): T[] {
  return posted.filter(
    (m): m is T => typeof m === 'object' && m !== null && (m as { type?: string }).type === type,
  );
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

/** The singleton registry and the stub's recorders are module-global —
 *  reset both so one test's panel can't leak into the next. */
function reset(): void {
  ImportDataPanel.dispose();
  stub.__resetStub();
}

/** Richer fakes for the import flow tests below — the two tests above only
 *  need the chooseFile half of the panel, these need the import half. */
interface ImportDeps {
  manager: unknown;
  collectionsRepo: unknown;
  configStore: unknown;
  calls: { query: string; args?: Record<string, unknown> | undefined }[];
  state: { activeId: string | null };
  loads: number;
}

type ExecuteImpl = (
  query: string,
  args: Record<string, unknown> | undefined,
  callIndex: number,
) => Promise<unknown>;

function makeDeps(opts: {
  executeImpl?: ExecuteImpl;
  collections?: string[];
  config?: { name: string } | undefined;
} = {}): ImportDeps {
  const calls: ImportDeps['calls'] = [];
  const state = { activeId: 'db-A' as string | null };
  const deps: ImportDeps = {
    calls,
    state,
    loads: 0,
    manager: {
      getActiveConfigId: () => state.activeId,
      executeRaw: async (query: string, args?: Record<string, unknown>) => {
        calls.push({ query, args });
        return opts.executeImpl?.(query, args, calls.length - 1) ?? [];
      },
    },
    collectionsRepo: {
      current: () => (opts.collections ?? []).map(name => ({ name })),
      load: async () => { deps.loads += 1; },
    },
    configStore: { get: () => opts.config ?? { name: 'DB' } },
  };
  return deps;
}

function showPanelWith(deps: ImportDeps, preselected?: string): void {
  ImportDataPanel.show(
    fakeContext(),
    deps.configStore as never,
    deps.manager as never,
    deps.collectionsRepo as never,
    'db-A',
    noopLogger(),
    preselected,
  );
}

/** Write a JSON array file of `docs` into a fresh temp dir. */
function writeJsonFile(dir: string, docs: Record<string, unknown>[]): string {
  const file = path.join(dir, 'docs.json');
  fs.writeFileSync(file, JSON.stringify(docs));
  return file;
}

const docs = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ _id: `id-${i}`, n: i }));

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), tag));
}

test('ImportDataPanel: a file over the 100 MB cap is refused by stat, before any read', async () => {
  reset();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'import-cap-'));
  try {
    const big = path.join(dir, 'big.json');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, MAX_IMPORT_BYTES + 1); // sparse: instant on-disk

    showPanel();
    stub.window.openDialogResult = [stub.Uri.file(big)];
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    const errors = postedOfType<{ type: string; message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1, `expected one error post; saw ${JSON.stringify(panel.webview.posted.map(m => (m as { type?: string }).type))}`);
    assert.match(errors[0]!.message, /100 MB/, 'the message states the cap');
    assert.match(errors[0]!.message, /limited to/, 'the message explains the refusal');
    assert.equal(
      postedOfType(panel.webview.posted, 'importData.fileSelected').length, 0,
      'an over-cap file never reaches the parsed state',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a valid small file is accepted and echoed back', async () => {
  reset();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'import-ok-'));
  try {
    const file = path.join(dir, 'docs.json');
    fs.writeFileSync(file, JSON.stringify([{ _id: 'a' }, { _id: 'b' }]));

    showPanel();
    stub.window.openDialogResult = [stub.Uri.file(file)];
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    const selected = postedOfType<{ type: string; documentCount: number; fileName: string }>(
      panel.webview.posted, 'importData.fileSelected',
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.documentCount, 2);
    assert.equal(selected[0]?.fileName, 'docs.json');
    assert.deepEqual(stub.window.shownErrors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: cancelling the picker posts nothing and keeps the prior buffer', async () => {
  // Cancel-and-pick-another is the normal flow when the user notices they
  // grabbed the wrong export; a cancel must not clobber the file that was
  // already validated.
  reset();
  const dir = tmpDir('import-cancel-');
  try {
    const file = writeJsonFile(dir, docs(2));
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    assert.equal(postedOfType(panel.webview.posted, 'importData.fileSelected').length, 1);

    stub.window.openDialogResult = undefined; // user hit Escape
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    assert.equal(
      postedOfType(panel.webview.posted, 'importData.error').length, 0,
      'a cancelled picker is not an error',
    );
    assert.equal(
      postedOfType(panel.webview.posted, 'importData.fileSelected').length, 1,
      'no new selection posted',
    );

    // The earlier buffer survived: the import still runs against it.
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();
    const done = postedOfType<{ successCount: number }>(panel.webview.posted, 'importData.done');
    assert.equal(done[0]?.successCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a file that vanishes between picker and stat surfaces the error', async () => {
  reset();
  const deps = makeDeps();
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  stub.window.openDialogResult = [stub.Uri.file('/definitely/not/on/disk.json')];
  panel.fireMessage({ type: 'importData.chooseFile' });
  await settle();

  const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /^Could not read file: /);
  assert.equal(postedOfType(panel.webview.posted, 'importData.fileSelected').length, 0);
});

test('ImportDataPanel: an unreadable file (a directory) surfaces the read failure', async () => {
  // stat succeeds on a directory; only the read trips EISDIR. This is the
  // branch a hand-typed path hits.
  reset();
  const dir = tmpDir('import-dir-');
  try {
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(dir)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /^Could not read file: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: malformed JSON posts the parse error and clears a prior buffer', async () => {
  reset();
  const dir = tmpDir('import-badjson-');
  try {
    const good = writeJsonFile(dir, docs(1));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'this is not json');

    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(good)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    assert.equal(postedOfType(panel.webview.posted, 'importData.fileSelected').length, 1);

    stub.window.openDialogResult = [stub.Uri.file(bad)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /array of JSON objects/);
    assert.match(errors[0]!.message, /parse error/, 'the underlying JSON error is included');

    // The stale "OK" buffer from the first pick must be gone — otherwise a
    // failed re-pick would still import the OLD file.
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();
    const startErrors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(startErrors.length, 2);
    assert.equal(startErrors[1]!.message, 'No file selected.');
    assert.equal(deps.calls.length, 0, 'nothing reached the database');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a document without _id is rejected with its index in the message', async () => {
  reset();
  const dir = tmpDir('import-noid-');
  try {
    const file = path.join(dir, 'noid.json');
    fs.writeFileSync(file, JSON.stringify([{ _id: 'a' }, { nope: true }]));

    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /index 1/);
    assert.match(errors[0]!.message, /'_id'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: refreshCollections echoes a sorted name snapshot', async () => {
  reset();
  const deps = makeDeps({ collections: ['zeta', 'alpha', 'mid'] });
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  panel.fireMessage({ type: 'importData.refreshCollections' });
  await settle();

  const refreshed = postedOfType<{ existingCollections: string[] }>(
    panel.webview.posted, 'importData.collectionsRefreshed',
  );
  assert.equal(refreshed.length, 1);
  assert.deepEqual(refreshed[0]!.existingCollections, ['alpha', 'mid', 'zeta']);
});

test('ImportDataPanel: start without a picked file refuses before touching the manager', async () => {
  reset();
  const deps = makeDeps();
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
  await settle();

  const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
  assert.deepEqual(errors.map(e => e.message), ['No file selected.']);
  assert.equal(deps.calls.length, 0);
});

test('ImportDataPanel: start on a now-inactive connection refuses before touching the manager', async () => {
  reset();
  const dir = tmpDir('import-inactive-');
  try {
    const file = writeJsonFile(dir, docs(1));
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    deps.state.activeId = 'db-B'; // the switch orchestrator flipped the active connection
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.deepEqual(errors.map(e => e.message), ['This connection is no longer active.']);
    assert.equal(deps.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a 120-document import runs in 50-doc batches with progress and clears the buffer', async () => {
  reset();
  const dir = tmpDir('import-batch-');
  try {
    const documents = docs(120);
    const file = writeJsonFile(dir, documents);
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();

    // 120 docs → batches of 50, 50, 20.
    assert.equal(deps.calls.length, 3, `expected 3 batch inserts; saw ${deps.calls.length}`);
    const [q0, q1, q2] = deps.calls;
    assert.ok(q0?.query.startsWith('INSERT INTO `tasks`\nDOCUMENTS (deserialize_json(:doc0))'));
    assert.ok(q0?.query.endsWith('ON ID CONFLICT DO UPDATE'), 'regular insert is an upsert');
    assert.ok(q0?.query.includes('(deserialize_json(:doc49))'));
    assert.equal(Object.keys(q0?.args ?? {}).length, 50);
    assert.equal(q0?.args?.doc0, JSON.stringify(documents[0]));
    assert.equal(q0?.args?.doc49, JSON.stringify(documents[49]));
    assert.equal(Object.keys(q1?.args ?? {}).length, 50);
    assert.equal(q1?.args?.doc0, JSON.stringify(documents[50]));
    assert.equal(Object.keys(q2?.args ?? {}).length, 20);
    assert.ok(!q2?.query.includes(':doc20'), 'the tail batch is exactly 20 placeholders');

    const progress = postedOfType<{ current: number; total: number; currentDocumentId?: string }>(
      panel.webview.posted, 'importData.progress',
    );
    assert.deepEqual(progress.map(p => p.current), [1, 50, 51, 100, 101, 120]);
    assert.deepEqual(progress.map(p => p.total), [120, 120, 120, 120, 120, 120]);
    assert.deepEqual(
      progress.filter(p => p.currentDocumentId).map(p => p.currentDocumentId),
      ['id-0', 'id-50', 'id-100'],
      'each batch announces the document it is starting on',
    );

    const done = postedOfType<{
      successCount: number; failureCount: number; errors: string[]; collection: string;
    }>(panel.webview.posted, 'importData.done');
    assert.equal(done.length, 1);
    assert.equal(done[0]!.successCount, 120);
    assert.equal(done[0]!.failureCount, 0);
    assert.deepEqual(done[0]!.errors, []);
    assert.equal(done[0]!.collection, 'tasks');
    assert.equal(deps.loads, 1, 'collections reload so a brand-new collection appears');

    // The buffer is dropped after a clean import — a second Start must not
    // silently re-insert 120 documents.
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();
    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.deepEqual(errors.map(e => e.message), ['No file selected.']);
    assert.equal(deps.calls.length, 3, 'no re-import happened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: insertType initial emits INITIAL DOCUMENTS without the conflict clause', async () => {
  reset();
  const dir = tmpDir('import-initial-');
  try {
    const file = writeJsonFile(dir, docs(2));
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'initial' });
    await settle();

    assert.equal(deps.calls.length, 1);
    assert.match(deps.calls[0]!.query, /^INSERT INTO `tasks`\nINITIAL DOCUMENTS /);
    assert.ok(!deps.calls[0]!.query.includes('ON ID CONFLICT'), 'initial import skips the upsert clause');
    const done = postedOfType<{ successCount: number }>(panel.webview.posted, 'importData.done');
    assert.equal(done[0]?.successCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a mid-import database switch cancels before the next batch', async () => {
  // The switch orchestrator closes this panel's siblings but cannot cancel
  // the in-flight import; the per-batch re-check is what keeps the tail of
  // the file out of the NEW database.
  reset();
  const dir = tmpDir('import-midswitch-');
  try {
    const file = writeJsonFile(dir, docs(60)); // two batches: 50 + 10
    const deps = makeDeps({
      executeImpl: (_q, _a, idx) => {
        if (idx === 0) { deps.state.activeId = 'db-B'; } // switch lands after batch 1
        return Promise.resolve([]);
      },
    });
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();

    assert.equal(deps.calls.length, 1, 'only the first batch executed');
    assert.equal(postedOfType(panel.webview.posted, 'importData.done').length, 0, 'no success report');
    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /Import cancelled — the database was switched mid-import/);
    assert.match(errors[0]!.message, /50 documents had already been written/,
      'the partial-write count is stated so the user knows the first batch landed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: batch failure falls back to single inserts and caps the reported errors at 5', async () => {
  reset();
  const dir = tmpDir('import-rowfail-');
  try {
    const file = writeJsonFile(dir, docs(7));
    const deps = makeDeps({
      executeImpl: (query) => {
        // The one batch call fails; every single-doc fallback fails too.
        return Promise.reject(new Error(query.includes('jsonDoc') ? 'row boom' : 'batch boom'));
      },
    });
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();

    assert.equal(deps.calls.length, 8, 'one failed batch + seven single-doc retries');
    const done = postedOfType<{ successCount: number; failureCount: number; errors: string[] }>(
      panel.webview.posted, 'importData.done',
    );
    assert.equal(done.length, 1, 'a failed import still reports done — with the failure counts');
    assert.equal(done[0]!.successCount, 0);
    assert.equal(done[0]!.failureCount, 7);
    assert.equal(done[0]!.errors.length, 5, 'the payload is bounded even when every row failed');
    assert.match(done[0]!.errors[0]!, /Document id-0 \(index 0\): row boom/);
    assert.equal(deps.loads, 0, 'a dirty import does not refresh collections');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: an unusable collection name surfaces as a panel error', async () => {
  reset();
  const dir = tmpDir('import-badname-');
  try {
    const file = writeJsonFile(dir, docs(1));
    const deps = makeDeps();
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();
    panel.fireMessage({ type: 'importData.start', collection: 'bad\nname', insertType: 'regular' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /control character/);
    assert.equal(deps.calls.length, 0);
    assert.equal(postedOfType(panel.webview.posted, 'importData.done').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: a second Start while one import is running is refused', async () => {
  reset();
  const dir = tmpDir('import-reentry-');
  try {
    const file = writeJsonFile(dir, docs(1));
    let release: (() => void) | undefined;
    const gate = new Promise<void>(r => { release = r; });
    const deps = makeDeps({ executeImpl: () => gate });
    showPanelWith(deps);
    const panel = stub.createdWebviewPanels[0];
    assert.ok(panel);
    await settle();

    stub.window.openDialogResult = [stub.Uri.file(file)];
    panel.fireMessage({ type: 'importData.chooseFile' });
    await settle();

    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle(); // the first import is now parked inside executeRaw
    panel.fireMessage({ type: 'importData.start', collection: 'tasks', insertType: 'regular' });
    await settle();

    const errors = postedOfType<{ message: string }>(panel.webview.posted, 'importData.error');
    assert.deepEqual(errors.map(e => e.message), ['Import already in progress.']);

    release!();
    await settle();
    const done = postedOfType<{ successCount: number }>(panel.webview.posted, 'importData.done');
    assert.equal(done.length, 1, 'the first import completes normally afterwards');
    assert.equal(done[0]?.successCount, 1);
    assert.equal(deps.calls.length, 1, 'the refused second start never reached the manager');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ImportDataPanel: cancel closes the panel', async () => {
  reset();
  const deps = makeDeps();
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  panel.fireMessage({ type: 'importData.cancel' });
  await settle();

  assert.equal(panel.disposed, true);
});

test('ImportDataPanel: re-show for the same database reveals and re-inits with the new preselect', async () => {
  reset();
  const deps = makeDeps({ collections: ['tasks'] });
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  ImportDataPanel.show(
    fakeContext(), deps.configStore as never, deps.manager as never,
    deps.collectionsRepo as never, 'db-A', noopLogger(), 'tasks',
  );
  await settle();

  assert.equal(stub.createdWebviewPanels.length, 1, 'no second panel was built');
  const inits = postedOfType<{ databaseName: string; preselectedCollection?: string; existingCollections: string[] }>(
    panel.webview.posted, 'importData.init',
  );
  assert.equal(inits.length, 2, 'constructor init + re-show init');
  assert.equal(inits[1]!.databaseName, 'DB');
  assert.equal(inits[1]!.preselectedCollection, 'tasks',
    'a right-click → Import on a collection updates the preselect without a rebuild');
  assert.deepEqual(inits[1]!.existingCollections, ['tasks']);
});

test('ImportDataPanel: show for a different database tears the old panel down', async () => {
  reset();
  const deps = makeDeps();
  showPanelWith(deps);
  const first = stub.createdWebviewPanels[0];
  assert.ok(first);
  await settle();

  ImportDataPanel.show(
    fakeContext(), deps.configStore as never, deps.manager as never,
    deps.collectionsRepo as never, 'db-B', noopLogger(),
  );

  assert.equal(first.disposed, true, 'the previous database\'s panel is gone');
  assert.equal(stub.createdWebviewPanels.length, 2, 'a fresh panel took its place');
  assert.equal(stub.createdWebviewPanels[1]?.disposed, false);
});

test('ImportDataPanel: a throwing collaborator reaches the error toast via the message wrapper', async () => {
  // onDidReceiveMessage drops the listener's return value; without
  // webviewMessageHandler this rejection would vanish and the refresh button
  // would look dead.
  reset();
  const deps = makeDeps();
  // The constructor's postInit also reads current() — let that first read
  // succeed and only the refresh-driven read explode.
  let currentCalls = 0;
  (deps.collectionsRepo as { current: () => unknown }).current = () => {
    currentCalls += 1;
    if (currentCalls > 1) { throw new Error('repo exploded'); }
    return [];
  };
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0];
  assert.ok(panel);
  await settle();

  panel.fireMessage({ type: 'importData.refreshCollections' });
  await settle();

  assert.deepEqual(stub.window.shownErrors, ['Import data failed: repo exploded']);
});

test('ImportDataPanel: a missing config titles the panel Unknown', async () => {
  reset();
  const deps = makeDeps({ config: undefined });
  (deps.configStore as { get: () => unknown }).get = () => undefined;
  showPanelWith(deps);
  const panel = stub.createdWebviewPanels[0] as unknown as { title: string };
  assert.ok(panel);

  assert.equal(panel.title, 'Import Data — Unknown');
});
