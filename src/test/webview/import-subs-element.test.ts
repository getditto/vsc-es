import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
const postedToHost: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { postedToHost.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/import-subscriptions/import-subs-element.js');

/**
 * Import Subscriptions panel: a four-state view (loading → loaded/error →
 * importing) with checkbox selection and an Import action that posts the
 * selected queries to the host.
 */

interface Subscription {
  id: string;
  deviceName: string;
  deviceInfo: string;
  collectionName: string;
  query: string;
}

type View =
  | { kind: 'loading' }
  | { kind: 'loaded'; rows: Subscription[]; selected: Set<string> }
  | { kind: 'error'; message: string }
  | { kind: 'importing'; status: string };

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  view: View;
}

const ROWS: Subscription[] = [
  { id: 's1', deviceName: 'Phone', deviceInfo: 'iOS 18', collectionName: 'tasks', query: 'SELECT * FROM tasks' },
  { id: 's2', deviceName: 'Laptop', deviceInfo: 'macOS 15', collectionName: 'notes', query: 'SELECT * FROM notes WHERE done = false' },
];

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-import-subscriptions></ditto-import-subscriptions>`, host);
  const el = host.querySelector('ditto-import-subscriptions') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function load(rows: Subscription[]): void {
  send({ type: 'importSubs.loaded', subscriptions: rows });
}

function checkboxes(el: Element): NodeListOf<HTMLInputElement> {
  return el.shadowRoot!.querySelectorAll<HTMLInputElement>('.row input[type="checkbox"]');
}

function importButton(el: Element): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>('.footer .save')!;
}

/** Indexing under noUncheckedIndexedAccess, with a built-in existence check. */
function at<T>(list: ArrayLike<T>, i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `expected index ${i} to exist`);
  return v;
}

test('ImportSubs: starts loading, and importSubs.loading returns it there', async t => {
  const { el } = await mount(t);
  assert.match(el.shadowRoot!.textContent ?? '', /Loading device subscriptions…/);

  load(ROWS);
  await el.updateComplete;
  send({ type: 'importSubs.loading' });
  await el.updateComplete;
  assert.equal(el.view.kind, 'loading');
  assert.match(el.shadowRoot!.textContent ?? '', /Loading device subscriptions…/);
});

test('ImportSubs: loaded renders one row per subscription with device details', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;

  const rows = el.shadowRoot!.querySelectorAll('.list .row');
  assert.equal(rows.length, 2);
  assert.match(at(rows, 0).textContent ?? '', /tasks/);
  assert.match(at(rows, 0).textContent ?? '', /SELECT \* FROM tasks/);
  assert.match(at(rows, 0).textContent ?? '', /Phone · iOS 18/);
  assert.match(at(rows, 1).textContent ?? '', /Laptop · macOS 15/);

  assert.match(el.shadowRoot!.textContent ?? '', /0 of 2 selected/);
  assert.equal(importButton(el).disabled, true, 'nothing selected → Import disabled');
  assert.equal((importButton(el).textContent ?? '').trim(), 'Import', 'no count suffix at zero');
});

test('ImportSubs: checking a row selects it and arms Import with the count', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;

  const cb = at(checkboxes(el), 0);
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  await el.updateComplete;

  assert.match(el.shadowRoot!.textContent ?? '', /1 of 2 selected/);
  assert.equal(importButton(el).disabled, false);
  assert.match(importButton(el).textContent ?? '', /Import \(1\)/);
  assert.equal(at(checkboxes(el), 0).checked, true);

  at(checkboxes(el), 0).dispatchEvent(new Event('change'));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /0 of 2 selected/);
  assert.equal(importButton(el).disabled, true);
});

test('ImportSubs: Select all / Select none drive the whole selection', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;

  const links = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toolbar button.linklike');
  at(links, 0).click();
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /2 of 2 selected/);
  assert.match(importButton(el).textContent ?? '', /Import \(2\)/);

  at(links, 1).click();
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /0 of 2 selected/);
  assert.equal(importButton(el).disabled, true);
});

test('ImportSubs: Import posts exactly the selected queries, in row order', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;

  // Select s2 only, via its checkbox.
  const cb = at(checkboxes(el), 1);
  cb.checked = true;
  cb.dispatchEvent(new Event('change'));
  await el.updateComplete;

  postedToHost.length = 0;
  importButton(el).click();
  assert.deepEqual(postedToHost, [{
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM notes WHERE done = false'],
  }]);

  // Select all → both queries, in row order.
  at(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toolbar button.linklike'), 0).click();
  await el.updateComplete;
  postedToHost.length = 0;
  importButton(el).click();
  assert.deepEqual(postedToHost, [{
    type: 'importSubs.importSelected',
    queries: ['SELECT * FROM tasks', 'SELECT * FROM notes WHERE done = false'],
  }]);
});

test('ImportSubs: importing replaces the body and footer with the status line', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;

  send({ type: 'importSubs.importing', status: 'Importing 2 of 5…' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Importing 2 of 5…/);
  assert.equal(el.shadowRoot!.querySelector('.list'), null, 'list replaced');
  assert.equal(el.shadowRoot!.querySelector('.footer .save'), null, 'no Import button mid-import');
  assert.ok(el.shadowRoot!.querySelector('.footer .progress'), 'footer carries the status');

  // importSubs.imported is a host-side no-op (the panel closes right after).
  send({ type: 'importSubs.imported', count: 2 });
  await el.updateComplete;
  assert.equal(el.view.kind, 'importing', 'imported leaves the view untouched');
});

test('ImportSubs: error state renders the host message', async t => {
  const { el } = await mount(t);
  send({ type: 'importSubs.error', message: 'server unreachable' });
  await el.updateComplete;
  const err = el.shadowRoot!.querySelector('.center.error')!;
  assert.match(err.textContent ?? '', /server unreachable/);
});

test('ImportSubs: loaded with zero rows explains everything is already imported', async t => {
  const { el } = await mount(t);
  load([]);
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No new subscriptions found\./);
  assert.match(el.shadowRoot!.textContent ?? '', /already imported/);
  assert.equal(importButton(el).disabled, true);
});

test('ImportSubs: Cancel posts importSubs.cancel', async t => {
  const { el } = await mount(t);
  load(ROWS);
  await el.updateComplete;
  postedToHost.length = 0;
  el.shadowRoot!.querySelector<HTMLButtonElement>('.footer .cancel')!.click();
  assert.deepEqual(postedToHost, [{ type: 'importSubs.cancel' }]);
});

test('ImportSubs: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  load(ROWS);
  await el.updateComplete;
  assert.equal(el.view.kind, 'loaded');

  // VS Code re-parents panels between editor groups: no host-message
  // processing while detached.
  host.remove();
  await el.updateComplete;
  send({ type: 'importSubs.error', message: 'stale' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.view.kind, 'loaded', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  send({ type: 'importSubs.error', message: 'live failure' });
  await el.updateComplete;
  assert.equal(el.view.kind, 'error', 'exactly one handler comes back live on re-attach');
  assert.match(el.shadowRoot!.textContent ?? '', /live failure/);
});
