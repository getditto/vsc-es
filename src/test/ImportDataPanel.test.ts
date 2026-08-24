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

function postedOfType<T extends { type: string }>(posted: unknown[], type: T['type']): T[] {
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
