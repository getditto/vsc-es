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

await import('../../../webview-ui/queryMetrics/query-metrics-panel-element.js');

/**
 * The Query Metrics element's HostMessages wiring: it must consume host
 * messages while attached, ignore them while detached (VS Code re-parents
 * webview panels between editor groups), and resume on re-attach without
 * a handler multiplier.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  records: unknown[];
  selectedId: string | null;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-query-metrics></ditto-query-metrics>`, host);
  const el = host.querySelector('ditto-query-metrics') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function sendRecords(records: { id: string; dql: string }[]): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'metrics.state', records },
  }));
}

test('QueryMetrics: consumes metrics.state and selects the newest record', async t => {
  const { el } = await mount(t);
  sendRecords([
    { id: 'r1', dql: 'SELECT * FROM a' },
    { id: 'r2', dql: 'SELECT * FROM b' },
  ]);
  await el.updateComplete;
  assert.equal(el.records.length, 2);
  assert.equal(el.selectedId, 'r1', 'defaults to the newest record');
});

test('QueryMetrics: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  sendRecords([{ id: 'r1', dql: 'SELECT 1' }]);
  await el.updateComplete;
  assert.equal(el.records.length, 1);

  // VS Code re-parents the panel between editor groups: the element must
  // not process host messages while detached.
  host.remove();
  await el.updateComplete;
  sendRecords([{ id: 'x1', dql: 'stale' }, { id: 'x2', dql: 'stale2' }]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.records.length, 1, 'detached element must not process host messages');

  // Re-attach: exactly one handler must come back live.
  document.body.appendChild(host);
  await el.updateComplete;
  sendRecords([{ id: 'r1', dql: 'SELECT 1' }, { id: 'r3', dql: 'SELECT 3' }]);
  await el.updateComplete;
  assert.equal(el.records.length, 2);
  assert.equal(el.records.map(r => (r as { id: string }).id).join(','), 'r1,r3',
    'a doubled handler would be invisible to state assertions — but a dropped re-subscribe would freeze at r1 only');
});
