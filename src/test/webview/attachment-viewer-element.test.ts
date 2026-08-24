import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
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
