import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  InspectorViewProvider,
  ATTACHMENT_PREVIEW_LIMIT,
} from '../inspector/InspectorViewProvider.js';
import { AttachmentCache } from '../inspector/AttachmentCache.js';
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
