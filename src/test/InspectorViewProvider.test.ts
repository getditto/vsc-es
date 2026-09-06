import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  InspectorViewProvider,
  ATTACHMENT_PREVIEW_LIMIT,
} from '../inspector/InspectorViewProvider.js';
import { AttachmentCache } from '../inspector/AttachmentCache.js';
import type { InspectorContent, QueryInspectorTab } from '../inspector/inspector-state.js';
import type { Logger, LogLevel } from '../logging/types.js';

/**
 * The inline preview path base64s the whole attachment into a `data:` URI
 * (~1.33× on top of the fetched buffer, straight into the shared extension
 * host's heap), while upload is hard-capped at 20 MB. These tests pin the
 * 20 MB gate on the PREVIEW path: by declared token size before any fetch,
 * and by actual byte count before the base64 step.
 */

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return self;
};

// Test-only seams on the vscode stub (`scripts/vscode-stub.mjs`): the save
// dialog's scripted result.
const stubWindow = (vscode as unknown as {
  window: { saveDialogResult: unknown };
}).window;

interface FakeView {
  posted: { type: string; [k: string]: unknown }[];
  messageListeners: ((msg: unknown) => void)[];
}

function resolveProvider(manager: {
  fetchAttachmentCalls: number;
  fetchAttachment(token: unknown, cb: (ev: unknown) => void): Promise<{ data(): Promise<Buffer>; metadata?: unknown }> | undefined;
  saveAttachmentToPath?(att: unknown, destPath: string): Promise<void>;
}): { posted: FakeView['posted'] } & { fire(msg: unknown): void } {
  const view: FakeView = { posted: [], messageListeners: [] };
  // Real cache — it's plain in-memory and participates in the byte-count
  // gate being tested (the lying-token cache-hit path).
  const attachmentCache = new AttachmentCache();
  const provider = new InspectorViewProvider(
    { extensionUri: vscode.Uri.file('/host') } as unknown as vscode.ExtensionContext,
    { onContentChange: () => ({ dispose: () => {} }), getContent: () => ({ kind: 'none' }) } as never,
    { list: () => [], onChange: () => ({ dispose: () => {} }) } as never,
    { list: () => [], onChange: () => ({ dispose: () => {} }) } as never,
    { getActiveConfigId: () => 'db-A',
      fetchAttachment: manager.fetchAttachment.bind(manager),
      saveAttachmentToPath: manager.saveAttachmentToPath?.bind(manager),
    } as never,
    noopLogger(),
    { get: () => ({ hideLimitHint: false }), dismissLimitHint: async () => {} } as never,
    { get: (dbId: string, attId: string) => attachmentCache.get(dbId, attId),
      set: (dbId: string, attId: string, v: Omit<import('../inspector/AttachmentCache.js').CachedAttachment, 'lastAccess'>) =>
        attachmentCache.set(dbId, attId, v) } as never,
  );
  provider.resolveWebviewView({
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-webview://stub',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (msg: unknown) => void) => {
        view.messageListeners.push(listener);
        return { dispose: () => {} };
      },
      postMessage: (msg: { type: string }) => { view.posted.push(msg); return Promise.resolve(true); },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  } as never);
  return {
    posted: view.posted,
    fire(msg: unknown) { for (const l of [...view.messageListeners]) { l(msg); } },
  };
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 40));

test('inspector: an over-cap token is refused by DECLARED length, before any fetch', async () => {
  const manager = {
    fetchAttachmentCalls: 0,
    fetchAttachment(_token: unknown, _cb: (ev: unknown) => void) {
      manager.fetchAttachmentCalls += 1;
      return Promise.resolve({ data: async () => Buffer.from('') });
    },
  };
  const p = resolveProvider(manager);

  p.fire({
    type: 'inspector.fetchAttachment',
    tokenId: 't1',
    token: { id: 'big-att', len: ATTACHMENT_PREVIEW_LIMIT + 1, metadata: { filename: 'big.zip' } },
  });
  await settle();

  assert.equal(manager.fetchAttachmentCalls, 0, 'never fetched a byte');
  const errs = p.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.equal(errs.length, 1, `saw ${JSON.stringify(p.posted.map(m => m.type))}`);
  assert.match(String(errs[0]?.message), /too large to preview/);
  assert.match(String(errs[0]?.message), /20 MB/, 'the cap is stated');
  assert.match(String(errs[0]?.message), /Download/, 'the save path is pointed at');
});

test('inspector: the over-cap gate does NOT block the Download/save flow', async () => {
  const manager = {
    fetchAttachmentCalls: 0,
    fetchAttachment(_token: unknown, _cb: (ev: unknown) => void) {
      manager.fetchAttachmentCalls += 1;
      return Promise.resolve({ data: async () => Buffer.from('') });
    },
  };
  const p = resolveProvider(manager);

  p.fire({
    type: 'inspector.saveAttachment',
    tokenId: 't1',
    token: { id: 'big-att', len: ATTACHMENT_PREVIEW_LIMIT + 1, metadata: {} },
  });
  await settle();

  assert.equal(manager.fetchAttachmentCalls, 1, 'the save flow starts fetching');
});

test('inspector: Download saves through the native copy — data() never runs, no byte cache', async () => {
  // The whole point of the streaming save path: for an uncapped Download,
  // the blob must never become a JS-side Uint8Array in the extension host.
  // Pin it by making data() observable — any call fails the test — and by
  // asserting the save goes through manager.saveAttachmentToPath
  // (Attachment.copyToPath under the hood) with the dialog-picked path.
  let dataCalls = 0;
  const saves: { dest: string }[] = [];
  const manager = {
    fetchAttachmentCalls: 0,
    fetchAttachment(_token: unknown, _cb: (ev: unknown) => void) {
      manager.fetchAttachmentCalls += 1;
      return Promise.resolve({
        data: async () => { dataCalls += 1; return Buffer.from('blob'); },
        metadata: { filename: 'photo.png' },
      });
    },
    async saveAttachmentToPath(_att: unknown, destPath: string) {
      saves.push({ dest: destPath });
    },
  };
  const p = resolveProvider(manager);

  stubWindow.saveDialogResult = vscode.Uri.file('/tmp/out.png');
  try {
    p.fire({
      type: 'inspector.saveAttachment',
      tokenId: 't1',
      token: { id: 'att-1', len: 4, metadata: { filename: 'photo.png' } },
    });
    await settle();

    assert.equal(dataCalls, 0, 'att.data() must never run on the save path');
    assert.deepEqual(saves, [{ dest: '/tmp/out.png' }]);
    const savedMsgs = p.posted.filter(m => m.type === 'inspector.attachmentSaved');
    assert.equal(savedMsgs.length, 1, `saw ${JSON.stringify(p.posted.map(m => m.type))}`);
    assert.equal(savedMsgs[0]?.path, '/tmp/out.png');
    const errors = p.posted.filter(m => m.type === 'inspector.attachmentError');
    assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors)}`);
  } finally {
    stubWindow.saveDialogResult = undefined;
  }
});

test('inspector: Download with a cancelled save dialog is a silent no-op', async () => {
  let dataCalls = 0;
  const manager = {
    fetchAttachmentCalls: 0,
    fetchAttachment(_token: unknown, _cb: (ev: unknown) => void) {
      manager.fetchAttachmentCalls += 1;
      return Promise.resolve({
        data: async () => { dataCalls += 1; return Buffer.from('blob'); },
        metadata: {},
      });
    },
    async saveAttachmentToPath() {
      assert.fail('saveAttachmentToPath must not run when the dialog is cancelled');
    },
  };
  const p = resolveProvider(manager);

  // No saveDialogResult set → the stub resolves undefined (user cancelled).
  p.fire({
    type: 'inspector.saveAttachment',
    tokenId: 't1',
    token: { id: 'att-2', len: 4, metadata: {} },
  });
  await settle();

  assert.equal(dataCalls, 0);
  assert.equal(p.posted.filter(m => m.type === 'inspector.attachmentSaved').length, 0);
  assert.equal(p.posted.filter(m => m.type === 'inspector.attachmentError').length, 0,
    'cancelling the save dialog must not surface as an error');
});

test('inspector: a cache hit with a lying token is refused by ACTUAL byte count, pre-base64', async () => {
  // The token claims 10 bytes (passes the pre-fetch gate) but the cached
  // payload is over the cap — the deliver step must refuse before building
  // a ~1.33 MB+ string out of it. In a fresh provider the cache is populated
  // through fetchAttachment, so we reach in through the cache seam instead:
  // hit the same cache instance the provider holds by pre-seeding it via
  // its constructor dep is not exposed, so this test exercises the public
  // surface: fetch a small-claimed token whose data() lies big.
  const bigBuffer = Buffer.alloc(ATTACHMENT_PREVIEW_LIMIT + 1); // sparse test bytes, no compression tricks
  const manager = {
    fetchAttachmentCalls: 0,
    fetchAttachment(_token: unknown, _cb: (ev: unknown) => void) {
      manager.fetchAttachmentCalls += 1;
      return Promise.resolve({ data: async () => bigBuffer });
    },
  };
  const p = resolveProvider(manager);

  p.fire({
    type: 'inspector.fetchAttachment',
    tokenId: 't1',
    token: { id: 'sneaky', len: 10, metadata: {} },
  });
  await settle();

  assert.equal(manager.fetchAttachmentCalls, 1, 'the fetch ran — the lie is undetectable pre-fetch');
  const loaded = p.posted.filter(m => m.type === 'inspector.attachmentLoaded');
  assert.equal(loaded.length, 0, 'no base64 payload was posted');
  const errs = p.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.equal(errs.length, 1);
  assert.match(String(errs[0]?.message), /too large to preview/);
});

// ─── resolveWebviewView + non-attachment message handling ──────
//
// The harness above pins the attachment size gates; this one drives the
// provider's full wiring: the resolve-time pushes (help URIs, preferences,
// settings, content, DB-scoped lists), the change listeners, and every
// InspectorIn branch that is not an attachment fetch.

const stubAll = vscode as unknown as {
  commands: { executed: { command: string; args: unknown[] }[]; executeCommandError: Error | undefined };
  workspace: { configValues: Record<string, Record<string, unknown>> };
  window: { saveDialogResult: unknown; lastSaveDialogOptions: { defaultUri?: { fsPath?: string } } | undefined };
  __resetStub(): void;
};

function recordingLogger(): { logger: Logger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  const self = {
    error: (m: string) => { errors.push(m); },
    warn: (m: string) => { warns.push(m); },
    info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;
  return { logger: self, warns, errors };
}

interface FullView {
  posted: { type: string; [k: string]: unknown }[];
  messageListeners: ((msg: unknown) => void)[];
  disposeListeners: (() => void)[];
}

interface BuiltProvider {
  provider: InspectorViewProvider;
  posted: FullView['posted'];
  fire(msg: unknown): void;
  disposeView(): void;
  controller: {
    content: InspectorContent;
    queryTabs: QueryInspectorTab[];
    observerTabs: ('json' | 'help')[];
    listeners: ((c: InspectorContent) => void)[];
    fireContent(c: InspectorContent): void;
  };
  history: {
    deleted: { databaseId: string; id: string }[];
    listeners: ((e: { databaseId: string }) => void)[];
    fireChange(databaseId: string): void;
  };
  favorites: {
    added: { databaseId: string; query: string }[];
    deleted: { databaseId: string; id: string }[];
    listeners: ((e: { databaseId: string }) => void)[];
    fireChange(databaseId: string): void;
  };
  prefs: { value: { hideLimitHint: boolean }; dismissCalls: number };
  manager: {
    fetchAttachmentCalls: number;
    eventCb: ((ev: unknown) => void) | null;
    activeDbId: string | null;
  };
  log: ReturnType<typeof recordingLogger>;
}

function buildProvider(opts: {
  content?: InspectorContent;
  historyEntries?: Record<string, unknown[]>;
  favoriteEntries?: Record<string, unknown[]>;
  hideLimitHint?: boolean;
  activeDbId?: string | null;
  fetchResult?: { data(): Promise<Buffer>; metadata?: unknown } | null | undefined;
} = {}): BuiltProvider {
  const view: FullView = { posted: [], messageListeners: [], disposeListeners: [] };

  const controller = {
    content: opts.content ?? { kind: 'none' },
    queryTabs: [] as QueryInspectorTab[],
    observerTabs: [] as ('json' | 'help')[],
    listeners: [] as ((c: InspectorContent) => void)[],
    fireContent(c: InspectorContent): void {
      this.content = c;
      for (const l of [...this.listeners]) { l(c); }
    },
  };
  const history = {
    deleted: [] as { databaseId: string; id: string }[],
    listeners: [] as ((e: { databaseId: string }) => void)[],
    fireChange(databaseId: string): void {
      for (const l of [...this.listeners]) { l({ databaseId }); }
    },
  };
  const favorites = {
    added: [] as { databaseId: string; query: string }[],
    deleted: [] as { databaseId: string; id: string }[],
    listeners: [] as ((e: { databaseId: string }) => void)[],
    fireChange(databaseId: string): void {
      for (const l of [...this.listeners]) { l({ databaseId }); }
    },
  };
  const prefs = { value: { hideLimitHint: opts.hideLimitHint ?? false }, dismissCalls: 0 };
  const manager = {
    fetchAttachmentCalls: 0,
    eventCb: null as ((ev: unknown) => void) | null,
    activeDbId: opts.activeDbId === undefined ? 'db-A' as string | null : opts.activeDbId,
  };
  const log = recordingLogger();

  const provider = new InspectorViewProvider(
    { extensionUri: vscode.Uri.file('/host') } as unknown as vscode.ExtensionContext,
    {
      onContentChange: (l: (c: InspectorContent) => void) => {
        controller.listeners.push(l);
        return { dispose: () => {
          controller.listeners = controller.listeners.filter(x => x !== l);
        } };
      },
      getContent: () => controller.content,
      setQueryTab: (t: QueryInspectorTab) => { controller.queryTabs.push(t); },
      setObserverTab: (t: 'json' | 'help') => { controller.observerTabs.push(t); },
    } as never,
    {
      list: (dbId: string) => opts.historyEntries?.[dbId] ?? [],
      delete: (databaseId: string, id: string) => { history.deleted.push({ databaseId, id }); },
      onChange: (l: (e: { databaseId: string }) => void) => {
        history.listeners.push(l);
        return { dispose: () => {
          history.listeners = history.listeners.filter(x => x !== l);
        } };
      },
    } as never,
    {
      list: (dbId: string) => opts.favoriteEntries?.[dbId] ?? [],
      add: (databaseId: string, query: string) => { favorites.added.push({ databaseId, query }); },
      delete: (databaseId: string, id: string) => { favorites.deleted.push({ databaseId, id }); },
      onChange: (l: (e: { databaseId: string }) => void) => {
        favorites.listeners.push(l);
        return { dispose: () => {
          favorites.listeners = favorites.listeners.filter(x => x !== l);
        } };
      },
    } as never,
    {
      getActiveConfigId: () => manager.activeDbId,
      fetchAttachment: (_token: unknown, cb: (ev: unknown) => void) => {
        manager.fetchAttachmentCalls += 1;
        manager.eventCb = cb;
        if (!('fetchResult' in opts)) {
          return Promise.resolve({ data: async () => Buffer.from('blob'), metadata: {} });
        }
        return opts.fetchResult === null
          ? Promise.resolve(null)
          : opts.fetchResult === undefined
            ? undefined
            : Promise.resolve(opts.fetchResult);
      },
      saveAttachmentToPath: async () => {},
    } as never,
    log.logger,
    {
      get: () => prefs.value,
      dismissLimitHint: async () => { prefs.dismissCalls += 1; prefs.value = { hideLimitHint: true }; },
    } as never,
    new AttachmentCache(),
  );

  provider.resolveWebviewView({
    webview: {
      options: undefined,
      html: '',
      cspSource: 'vscode-webview://stub',
      asWebviewUri: (uri: { path?: string }) => ({
        toString: () => `https://stub${uri?.path ?? ''}`,
      }),
      onDidReceiveMessage: (listener: (msg: unknown) => void) => {
        view.messageListeners.push(listener);
        return { dispose: () => {
          view.messageListeners = view.messageListeners.filter(x => x !== listener);
        } };
      },
      postMessage: (msg: { type: string }) => { view.posted.push(msg); return Promise.resolve(true); },
    },
    onDidDispose: (listener: () => void) => {
      view.disposeListeners.push(listener);
      return { dispose: () => {} };
    },
  } as never);

  return {
    provider,
    posted: view.posted,
    fire(msg: unknown) { for (const l of [...view.messageListeners]) { l(msg); } },
    disposeView() { for (const l of [...view.disposeListeners]) { l(); } },
    controller,
    history,
    favorites,
    prefs,
    manager,
    log,
  };
}

const settle2 = (): Promise<void> => new Promise(r => setTimeout(r, 40));

test('resolve posts help URIs, preferences, settings, and the current content', () => {
  stubAll.__resetStub();
  const p = buildProvider({ content: { kind: 'none' } });

  const helpKinds = p.posted.filter(m => m.type === 'inspector.helpHtml').map(m => m.kind);
  assert.deepEqual(helpKinds, [
    'subscription', 'query', 'presence', 'metrics',
    'databaseMetrics', 'systemMetrics', 'observers', 'logAnalyzer', 'patternEditor',
  ], 'every help tab got a URI at resolve');
  const help = p.posted.find(m => m.type === 'inspector.helpHtml' && m.kind === 'query');
  assert.match(String(help?.uri), /^https:\/\/stub\//, 'a webview-safe URI');

  assert.deepEqual(
    p.posted.filter(m => m.type === 'inspector.preferences').map(m => m.hideLimitHint),
    [false],
  );
  assert.deepEqual(
    p.posted.filter(m => m.type === 'inspector.settings').map(m => m.collectMetrics),
    [true], 'collectMetrics defaults to true',
  );
  const contents = p.posted.filter(m => m.type === 'inspector.contentChanged');
  assert.deepEqual(contents[0]?.content, { kind: 'none' });
});

test('pushSettings reflects the collectMetrics workspace setting reactively', () => {
  stubAll.__resetStub();
  stubAll.workspace.configValues = { dittoVsce: { collectMetrics: false } };
  try {
    const p = buildProvider();
    assert.deepEqual(
      p.posted.filter(m => m.type === 'inspector.settings').map(m => m.collectMetrics),
      [false], 'a disabled setting hides the Metrics tab on first paint',
    );

    stubAll.workspace.configValues = { dittoVsce: { collectMetrics: true } };
    p.provider.pushSettings();
    assert.deepEqual(
      p.posted.filter(m => m.type === 'inspector.settings').map(m => m.collectMetrics),
      [false, true], 'the settings listener re-push lands in the webview',
    );
  } finally {
    stubAll.workspace.configValues = {};
  }
});

test('resolve with a DB-bound content kind pre-loads that DBs history and favorites', () => {
  stubAll.__resetStub();
  const p = buildProvider({
    content: { kind: 'query', databaseId: 'db-A', tab: 'json' },
    historyEntries: { 'db-A': [{ id: 'h1' }] },
    favoriteEntries: { 'db-A': [{ id: 'f1' }] },
  });

  const hist = p.posted.filter(m => m.type === 'inspector.historyChanged');
  assert.deepEqual(hist.map(m => m.databaseId), ['db-A']);
  assert.deepEqual(hist[0]?.entries, [{ id: 'h1' }]);
  const favs = p.posted.filter(m => m.type === 'inspector.favoritesChanged');
  assert.deepEqual(favs.map(m => m.databaseId), ['db-A']);
  assert.deepEqual(favs[0]?.entries, [{ id: 'f1' }]);
});

test('a content change re-pushes help URIs and, for DB-bound kinds, the lists', () => {
  stubAll.__resetStub();
  const p = buildProvider({
    historyEntries: { 'db-B': [{ id: 'hB' }] },
    favoriteEntries: { 'db-B': [{ id: 'fB' }] },
  });
  const helpAtResolve = p.posted.filter(m => m.type === 'inspector.helpHtml').length;

  p.controller.fireContent({ kind: 'subscriptions', databaseId: 'db-B' });

  const helpAfter = p.posted.filter(m => m.type === 'inspector.helpHtml').length;
  assert.equal(helpAfter, helpAtResolve * 2, 'help URIs re-pushed ahead of the content switch');
  const hist = p.posted.filter(m => m.type === 'inspector.historyChanged');
  assert.deepEqual(hist[0]?.entries, [{ id: 'hB' }]);
  const favs = p.posted.filter(m => m.type === 'inspector.favoritesChanged');
  assert.deepEqual(favs[0]?.entries, [{ id: 'fB' }]);
});

test('a content change to a non-DB kind skips the history and favorites lists', () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.controller.fireContent({ kind: 'none' });
  p.controller.fireContent({ kind: 'patternEditor' });

  assert.equal(p.posted.filter(m => m.type === 'inspector.contentChanged').length, 3,
    'initial + two switches');
  assert.equal(p.posted.filter(m => m.type === 'inspector.historyChanged').length, 0);
  assert.equal(p.posted.filter(m => m.type === 'inspector.favoritesChanged').length, 0);
});

test('history and favorites store changes are forwarded with the entries', () => {
  stubAll.__resetStub();
  const p = buildProvider({
    historyEntries: { 'db-A': [{ id: 'h1' }] },
    favoriteEntries: { 'db-A': [{ id: 'f1' }] },
  });

  p.history.fireChange('db-A');
  p.favorites.fireChange('db-A');

  const hist = p.posted.filter(m => m.type === 'inspector.historyChanged');
  assert.deepEqual(hist.map(m => m.databaseId), ['db-A']);
  assert.deepEqual(hist[0]?.entries, [{ id: 'h1' }]);
  const favs = p.posted.filter(m => m.type === 'inspector.favoritesChanged');
  assert.deepEqual(favs[0]?.entries, [{ id: 'f1' }]);
});

test('tab selection routes to the controller only for matching content kinds', async () => {
  stubAll.__resetStub();
  const p = buildProvider({ content: { kind: 'query', databaseId: 'db-A', tab: 'json' } });

  p.fire({ type: 'inspector.tabSelected', tab: 'metrics' });
  assert.deepEqual(p.controller.queryTabs, ['metrics']);

  p.controller.fireContent({ kind: 'observers', databaseId: 'db-A', observerId: 'o1', tab: 'json' });
  p.fire({ type: 'inspector.tabSelected', tab: 'help' });
  assert.deepEqual(p.controller.observerTabs, ['help'], 'observers accepts json/help');
  p.fire({ type: 'inspector.tabSelected', tab: 'metrics' });
  assert.deepEqual(p.controller.observerTabs, ['help'], 'an observers-only filter rejects other tabs');

  p.controller.fireContent({ kind: 'none' });
  p.fire({ type: 'inspector.tabSelected', tab: 'json' });
  assert.deepEqual(p.controller.queryTabs, ['metrics'], 'no routing without a tabbed kind');
  await settle2();
});

test('loadQueryInEditor fans out to the openQueryEditorWithText command', async () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.fire({ type: 'inspector.loadQueryInEditor', query: 'SELECT * FROM t' });
  await settle2();

  assert.deepEqual(stubAll.commands.executed, [
    { command: 'dittoVsce.openQueryEditorWithText', args: ['SELECT * FROM t'] },
  ]);
});

test('a failing loadQueryInEditor command is logged, not raised at the user', async () => {
  stubAll.__resetStub();
  stubAll.commands.executeCommandError = new Error('command not found');
  const p = buildProvider();
  try {
    p.fire({ type: 'inspector.loadQueryInEditor', query: 'SELECT 1' });
    await settle2();

    assert.equal(stubAll.commands.executed.length, 1, 'the command was attempted');
    assert.deepEqual(p.log.warns, ['openQueryEditorWithText command failed']);
  } finally {
    stubAll.commands.executeCommandError = undefined;
  }
});

test('history/favorites edits apply only to query content', async () => {
  stubAll.__resetStub();
  const p = buildProvider({ content: { kind: 'query', databaseId: 'db-A', tab: 'history' } });

  p.fire({ type: 'inspector.deleteHistoryEntry', id: 'h1' });
  p.fire({ type: 'inspector.addFavorite', query: 'SELECT 1' });
  p.fire({ type: 'inspector.removeFavorite', id: 'f1' });
  await settle2();

  assert.deepEqual(p.history.deleted, [{ databaseId: 'db-A', id: 'h1' }]);
  assert.deepEqual(p.favorites.added, [{ databaseId: 'db-A', query: 'SELECT 1' }]);
  assert.deepEqual(p.favorites.deleted, [{ databaseId: 'db-A', id: 'f1' }]);

  p.controller.fireContent({ kind: 'none' });
  p.fire({ type: 'inspector.deleteHistoryEntry', id: 'h2' });
  p.fire({ type: 'inspector.addFavorite', query: 'SELECT 2' });
  p.fire({ type: 'inspector.removeFavorite', id: 'f2' });
  await settle2();

  assert.equal(p.history.deleted.length, 1, 'no deletes without a query context');
  assert.equal(p.favorites.added.length, 1);
  assert.equal(p.favorites.deleted.length, 1);
});

test('dismissLimitHint persists the preference and re-pushes it', async () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.fire({ type: 'inspector.dismissLimitHint' });
  await settle2();

  assert.equal(p.prefs.dismissCalls, 1);
  const prefs = p.posted.filter(m => m.type === 'inspector.preferences').map(m => m.hideLimitHint);
  assert.deepEqual(prefs, [false, true], 'resolve-time false, then the flipped true');
});

test('disposing the view detaches every listener and silences posting', () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.disposeView();
  p.controller.fireContent({ kind: 'query', databaseId: 'db-A', tab: 'json' });
  p.history.fireChange('db-A');
  p.favorites.fireChange('db-A');
  p.provider.pushPreferences();
  p.provider.pushSettings();

  assert.equal(p.posted.filter(m => m.type === 'inspector.contentChanged').length, 1,
    'only the resolve-time content push');
  assert.equal(p.posted.filter(m => m.type === 'inspector.historyChanged').length, 0);
  assert.deepEqual(p.controller.listeners, [], 'controller subscription disposed');
  assert.deepEqual(p.history.listeners, [], 'history subscription disposed');
  assert.deepEqual(p.favorites.listeners, [], 'favorites subscription disposed');
});

// ─── fetchAttachment: non-cap paths ────────────────────────────

test('fetch progress events are posted as clamped percentages', async () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-p', len: 4, metadata: {} },
  });
  await settle2();

  const cb = p.manager.eventCb;
  assert.ok(cb, 'the provider subscribed to fetch events');
  cb({ type: 'Progress', totalBytes: 200, downloadedBytes: 50 });
  cb({ type: 'Progress', totalBytes: 0, downloadedBytes: 0 });
  cb({ type: 'Progress', totalBytes: 100, downloadedBytes: 250 });
  await settle2();

  const pcts = p.posted.filter(m => m.type === 'inspector.attachmentProgress').map(m => m.pct);
  assert.deepEqual(pcts, [25, 0, 100], 'rounded, zero-total-safe, clamped to 100');
});

test('a Deleted fetch event surfaces as an attachment error', async () => {
  stubAll.__resetStub();
  const p = buildProvider();

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-d', len: 4, metadata: {} },
  });
  await settle2();
  p.manager.eventCb?.({ type: 'Deleted' });
  await settle2();

  const errs = p.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.equal(errs.length, 1);
  assert.match(String(errs[0]?.message), /deleted on remote/);
});

test('a session-less manager reports No active database', async () => {
  stubAll.__resetStub();
  const p = buildProvider({ fetchResult: undefined });

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-x', len: 4, metadata: {} },
  });
  await settle2();

  const errs = p.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.deepEqual(errs.map(m => m.message), ['No active database']);
});

test('a null fetch result is reported rather than crashing', async () => {
  stubAll.__resetStub();
  const p = buildProvider({ fetchResult: null });

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-n', len: 4, metadata: {} },
  });
  await settle2();

  const errs = p.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.deepEqual(errs.map(m => m.message), ['Fetch returned null']);
});

test('a rejecting fetch posts the error message and logs the stack', async () => {
  stubAll.__resetStub();
  const view: FullView = { posted: [], messageListeners: [], disposeListeners: [] };
  const log = recordingLogger();
  const provider = new InspectorViewProvider(
    { extensionUri: vscode.Uri.file('/host') } as unknown as vscode.ExtensionContext,
    { onContentChange: () => ({ dispose: () => {} }), getContent: () => ({ kind: 'none' }) } as never,
    { list: () => [], onChange: () => ({ dispose: () => {} }) } as never,
    { list: () => [], onChange: () => ({ dispose: () => {} }) } as never,
    {
      getActiveConfigId: () => 'db-A',
      fetchAttachment: () => Promise.reject(new Error('network blew up')),
    } as never,
    log.logger,
    { get: () => ({ hideLimitHint: false }), dismissLimitHint: async () => {} } as never,
    new AttachmentCache(),
  );
  provider.resolveWebviewView({
    webview: {
      options: undefined, html: '', cspSource: 'vscode-webview://stub',
      asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: (listener: (msg: unknown) => void) => {
        view.messageListeners.push(listener);
        return { dispose: () => {} };
      },
      postMessage: (msg: { type: string }) => { view.posted.push(msg); return Promise.resolve(true); },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  } as never);

  for (const l of [...view.messageListeners]) {
    l({ type: 'inspector.fetchAttachment', tokenId: 't1', token: { id: 'att-e', len: 4, metadata: {} } });
  }
  await settle2();

  const errs = view.posted.filter(m => m.type === 'inspector.attachmentError');
  assert.deepEqual(errs.map(m => m.message), ['network blew up']);
  assert.deepEqual(log.errors, ['Attachment fetch failed']);
});

test('a preview fetch accepts contentType/filename metadata and caches the bytes', async () => {
  stubAll.__resetStub();
  // Node-SDK-style metadata keys (no mimeType/name) must still produce the
  // right MIME, and a second fetch of the same token must hit the cache.
  const p = buildProvider({
    fetchResult: {
      data: async () => Buffer.from('png-bytes'),
      metadata: { contentType: 'image/png', filename: 'photo.png' },
    },
  });

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-c', len: 9, metadata: { contentType: 'image/png', filename: 'photo.png' } },
  });
  await settle2();

  const loaded = p.posted.filter(m => m.type === 'inspector.attachmentLoaded');
  assert.equal(loaded.length, 1, `saw ${JSON.stringify(p.posted.map(m => m.type))}`);
  assert.equal(loaded[0]?.mimeType, 'image/png');
  assert.equal(loaded[0]?.webviewUri, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
  assert.equal(p.manager.fetchAttachmentCalls, 1);

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't2',
    token: { id: 'att-c', len: 9, metadata: {} },
  });
  await settle2();

  assert.equal(p.manager.fetchAttachmentCalls, 1, 'second fetch served from the byte cache');
  const loaded2 = p.posted.filter(m => m.type === 'inspector.attachmentLoaded');
  assert.equal(loaded2.length, 2);
  assert.equal(loaded2[1]?.tokenId, 't2');
  assert.equal(loaded2[1]?.mimeType, 'image/png', 'the cached MIME survives');
});

test('a disconnect mid-fetch skips the cache write', async () => {
  stubAll.__resetStub();
  const p = buildProvider({
    fetchResult: { data: async () => Buffer.from('blob'), metadata: {} },
  });

  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't1',
    token: { id: 'att-dc', len: 4, metadata: {} },
  });
  // Disconnect before the fetch promise resolves.
  p.manager.activeDbId = null;
  await settle2();

  assert.equal(p.posted.filter(m => m.type === 'inspector.attachmentLoaded').length, 1,
    'delivery still happened');

  // A second fetch must go back to the SDK — nothing was cached.
  p.manager.activeDbId = 'db-A';
  p.fire({
    type: 'inspector.fetchAttachment', tokenId: 't2',
    token: { id: 'att-dc', len: 4, metadata: {} },
  });
  await settle2();
  assert.equal(p.manager.fetchAttachmentCalls, 2, 'no stale cache entry was written');
});

test('a save without a filename defaults the dialog to attachment.bin', async () => {
  stubAll.__resetStub();
  const p = buildProvider({
    fetchResult: { data: async () => Buffer.from('blob'), metadata: {} },
  });

  stubAll.window.saveDialogResult = vscode.Uri.file('/tmp/out.bin');
  try {
    p.fire({
      type: 'inspector.saveAttachment', tokenId: 't1',
      token: { id: 'att-s', len: 4, metadata: {} },
    });
    await settle2();

    const defaultUri = stubAll.window.lastSaveDialogOptions?.defaultUri?.fsPath;
    assert.ok(defaultUri?.endsWith('attachment.bin'), `saw ${defaultUri}`);
    const saved = p.posted.filter(m => m.type === 'inspector.attachmentSaved');
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.path, '/tmp/out.bin');
  } finally {
    stubAll.window.saveDialogResult = undefined;
  }
});
