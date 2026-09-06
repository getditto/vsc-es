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

await import('../../../webview-ui/databaseMetrics/database-metrics-element.js');

/**
 * HostMessages wiring for the Database Metrics panel: consume while
 * attached, stay silent while detached (panel re-parenting between editor
 * groups), resume on re-attach. The system:metrics dashboard that used to
 * share this panel now lives in webview-ui/systemMetrics/ and is covered
 * by system-metrics-element.test.ts.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  view: { kind: string };
}

const SNAPSHOT = {
  storeBytes: 1024,
  replicationBytes: 0,
  attachmentsBytes: 0,
  authBytes: 0,
  walShmBytes: 0,
  logsBytes: 0,
  otherBytes: 0,
  collectionBreakdown: [],
  collectionPayloadBytes: 512,
  totalDiskBytes: 1536,
  computedAt: Date.now(),
};

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-database-metrics></ditto-database-metrics>`, host);
  const el = host.querySelector('ditto-database-metrics') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

test('DatabaseMetrics: renders a snapshot pushed by the host', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.snapshot', snapshot: SNAPSHOT },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'loaded');
  assert.match(el.shadowRoot!.textContent ?? '', /1\.5 KB/, 'header shows total on disk');
});

test('DatabaseMetrics: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.snapshot', snapshot: SNAPSHOT },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'loaded');

  host.remove();
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.error', message: 'stale failure' },
  }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.view.kind, 'loaded', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.error', message: 'disk unreadable' },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'error');
});
