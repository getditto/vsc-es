import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. postMessage is
 *  recorded so Fetch/Save clicks can be asserted against the exact payload. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/inspector/attachment-viewer-element.js');

/**
 * Attachment viewer's HostMessages wiring: attachment lifecycle pushes must
 * land while attached, be ignored while detached, and resume on re-attach.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  json: string | undefined;
  loaded: Record<string, { uri: string; mime: string }>;
}

const ROW = JSON.stringify({
  doc: { id: 'att-1', len: 2048, metadata: { mimeType: 'image/png', name: 'photo.png' } },
});

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<attachment-viewer-element></attachment-viewer-element>`, host);
  const el = host.querySelector('attachment-viewer-element') as unknown as Element;
  el.json = ROW;
  await el.updateComplete;
  return { host, el };
}

test('AttachmentViewer: detects tokens and renders the Fetch control', async t => {
  const { el } = await mount(t);
  assert.ok(el.shadowRoot!.querySelector('.att'), 'one attachment card');
  assert.match(el.shadowRoot!.textContent ?? '', /photo\.png/);
  assert.match(el.shadowRoot!.textContent ?? '', /2\.0 KB/);
});

test('AttachmentViewer: attachmentLoaded switches an image token to inline <img>', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentLoaded', tokenId: 'att-1_0', mimeType: 'image/png', webviewUri: 'vscode-webview://x/photo.png' },
  }));
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('img.att-img'), 'loaded image renders inline');
});

test('AttachmentViewer: ignores host pushes while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);

  host.remove();
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentLoaded', tokenId: 'att-1_0', mimeType: 'image/png', webviewUri: 'vscode-webview://x/photo.png' },
  }));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(el.loaded, {}, 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentError', tokenId: 'att-1_0', message: 'fetch failed' },
  }));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /fetch failed/);
});

// ─── Detection, rendering, and control behaviour ───────────────
// The tests above cover the HostMessages lifecycle and the image happy
// path. These cover the token-shape rejection branches, the walker
// (arrays, scalars, nesting), the metadata fallback chains, byte
// formatting, progress/error rendering, the Fetch/Save IPC payloads,
// and the per-row state reset.

interface FullElement extends Element {
  progress: Record<string, number>;
  errors: Record<string, string>;
}

/** Mount without pre-setting json so empty-input branches are visible. */
function mountBare(t: { after(fn: () => void): void }): FullElement {
  const el = document.createElement('attachment-viewer-element') as unknown as FullElement;
  document.body.appendChild(el);
  t.after(() => el.remove());
  return el;
}

async function setJson(el: FullElement, value: unknown): Promise<void> {
  el.json = typeof value === 'string' ? value : JSON.stringify(value);
  await el.updateComplete;
}

function cards(el: FullElement): HTMLElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.att')];
}

test('AttachmentViewer: renders nothing when json is unset, unparseable, scalar, or attachment-free', async t => {
  const el = mountBare(t);
  await el.updateComplete;
  assert.equal(cards(el).length, 0, 'no json → no cards');

  await setJson(el, 'not json {');
  assert.equal(cards(el).length, 0, 'invalid JSON is swallowed by the catch');

  await setJson(el, '"just a string"');
  assert.equal(cards(el).length, 0, 'scalars do not walk');

  await setJson(el, { a: 1, b: [null, true, 'x'], c: { d: [] } });
  assert.equal(cards(el).length, 0, 'plain data without tokens renders nothing');

  await setJson(el, JSON.parse(ROW));
  assert.equal(cards(el).length, 1, 'a real token still renders after all the misses');
});

test('AttachmentViewer: objects missing any token field are not attachments', async t => {
  const el = mountBare(t);
  await setJson(el, {
    badId: { id: 7, len: 10, metadata: {} },
    badLen: { id: 'x', len: '10', metadata: {} },
    noMeta: { id: 'y', len: 10 },
    arrayMeta: { id: 'z', len: 10, metadata: [] },
  });
  assert.equal(cards(el).length, 0, 'every isAttachmentToken rejection branch holds');
});

test('AttachmentViewer: arrays and nested objects are both walked', async t => {
  const el = mountBare(t);
  await setJson(el, {
    photos: [
      { id: 'a1', len: 10, metadata: { name: 'one.png', mimeType: 'image/png' } },
      { id: 'a2', len: 20, metadata: { name: 'two.png', mimeType: 'image/png' } },
    ],
    nested: { deep: { id: 'a3', len: 30, metadata: { name: 'three.png', mimeType: 'image/png' } } },
  });
  const names = cards(el).map(c => c.querySelector('.att-name')!.textContent);
  assert.deepEqual(names, ['one.png', 'two.png', 'three.png'],
    'array elements and deeply nested tokens are all detected');
});

test('AttachmentViewer: metadata fallback chains pick contentType/filename variants, then defaults', async t => {
  const el = mountBare(t);
  await setJson(el, [
    { id: 'm1', len: 1, metadata: { contentType: 'text/plain', filename: 'a.txt' } },
    { id: 'm2', len: 1, metadata: { mime_type: 'application/pdf', fileName: 'b.pdf' } },
    { id: 'm3', len: 1, metadata: { type: 'image/webp', file_name: 'c.webp' } },
    { id: 'm4', len: 1, metadata: {} },
  ]);
  const rendered = cards(el).map(c => ({
    name: c.querySelector('.att-name')!.textContent,
    metas: [...c.querySelectorAll('.att-meta')].map(m => m.textContent),
  }));
  assert.deepEqual(rendered, [
    { name: 'a.txt', metas: ['1 B', 'text/plain'] },
    { name: 'b.pdf', metas: ['1 B', 'application/pdf'] },
    { name: 'c.webp', metas: ['1 B', 'image/webp'] },
    { name: 'attachment', metas: ['1 B', 'unknown type'] },
  ]);
});

test('AttachmentViewer: byte formatting spans B, KB, MB, and GB', async t => {
  const el = mountBare(t);
  const cases: Array<[number, string]> = [
    [512, '512 B'],
    [2048, '2.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [3 * 1024 * 1024 * 1024, '3.0 GB'],
  ];
  for (const [len, expected] of cases) {
    await setJson(el, { id: `len-${len}`, len, metadata: {} });
    const meta = el.shadowRoot!.querySelector('.att .att-meta');
    assert.equal(meta!.textContent, expected, `len ${len}`);
  }
});

test('AttachmentViewer: Fetch posts fetchAttachment with the raw SDK token', async t => {
  const { el } = await mount(t);
  posted.length = 0;
  const button = el.shadowRoot!.querySelector('button')!;
  assert.equal(button.textContent, 'Fetch');
  button.click();
  assert.deepEqual(posted, [{
    type: 'inspector.fetchAttachment',
    token: { id: 'att-1', len: 2048, metadata: { mimeType: 'image/png', name: 'photo.png' } },
    tokenId: 'att-1_0',
  }]);
});

test('AttachmentViewer: progress renders, then a non-image load swaps to a working Save… button', async t => {
  const el = mountBare(t);
  await setJson(el, { id: 'doc-1', len: 10, metadata: { mimeType: 'application/pdf', name: 'spec.pdf' } });

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentProgress', tokenId: 'doc-1_0', pct: 42 },
  }));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Loading… 42%/, 'progress line while loading');

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentLoaded', tokenId: 'doc-1_0', mimeType: 'application/pdf', webviewUri: 'vscode-webview://x/spec.pdf' },
  }));
  await el.updateComplete;
  assert.doesNotMatch(el.shadowRoot!.textContent ?? '', /Loading…/,
    'progress hides once the attachment is loaded');
  assert.equal(el.shadowRoot!.querySelector('img.att-img'), null, 'non-image loads do not render inline');

  posted.length = 0;
  const save = el.shadowRoot!.querySelector('button')!;
  assert.equal(save.textContent, 'Save…');
  save.click();
  assert.deepEqual(posted, [{
    type: 'inspector.saveAttachment',
    token: { id: 'doc-1', len: 10, metadata: { mimeType: 'application/pdf', name: 'spec.pdf' } },
    tokenId: 'doc-1_0',
  }]);
});

test('AttachmentViewer: selecting a different row clears loaded/progress/errors', async t => {
  const el = mountBare(t);
  await setJson(el, { id: 'row-1', len: 10, metadata: { mimeType: 'application/pdf', name: 'a.pdf' } });
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentProgress', tokenId: 'row-1_0', pct: 10 },
  }));
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentError', tokenId: 'row-1_0', message: 'boom' },
  }));
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.attachmentLoaded', tokenId: 'row-1_0', mimeType: 'application/pdf', webviewUri: 'u' },
  }));
  await el.updateComplete;
  assert.ok(Object.keys(el.loaded).length > 0 && Object.keys(el.progress).length > 0 && Object.keys(el.errors).length > 0,
    'all three state maps populated before the row change');

  await setJson(el, { id: 'row-2', len: 10, metadata: { mimeType: 'application/pdf', name: 'b.pdf' } });
  assert.deepEqual(el.loaded, {}, 'loaded cleared');
  assert.deepEqual(el.progress, {}, 'progress cleared');
  assert.deepEqual(el.errors, {}, 'errors cleared');
  const text = el.shadowRoot!.textContent ?? '';
  assert.doesNotMatch(text, /boom/, 'stale error text gone');
  assert.doesNotMatch(text, /Loading…/, 'stale progress text gone');
  assert.equal(el.shadowRoot!.querySelector('button')!.textContent, 'Fetch',
    'the new row starts back at Fetch, not Save…');
});
