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

await import('../../../webview-ui/inspector/inspector-element.js');

/**
 * The Inspector router's HostMessages wiring: consume content pushes while
 * attached, ignore them while detached (VS Code re-parents the secondary
 * sidebar view too), resume on re-attach.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-inspector></ditto-inspector>`, host);
  const el = host.querySelector('ditto-inspector') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function pushContent(content: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'inspector.contentChanged', content },
  }));
}

test('Inspector: switches body when the host pushes contentChanged', async t => {
  const { el } = await mount(t);
  assert.match(el.shadowRoot!.textContent ?? '', /No active database/);
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  assert.doesNotMatch(el.shadowRoot!.textContent ?? '', /No active database/);
  assert.ok(el.shadowRoot!.querySelector('.tabs'), 'query content renders the tab row');
});

test('Inspector: ignores host pushes while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);

  host.remove();
  await el.updateComplete;
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await new Promise(r => setTimeout(r, 0));
  assert.match(el.shadowRoot!.textContent ?? '', /No active database/,
    'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  pushContent({ kind: 'peers', databaseId: 'db1' });
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('help-content-element'),
    'peers content renders the help element after re-attach');
});
