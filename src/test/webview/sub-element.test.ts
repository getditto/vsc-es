import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/subscription/sub-element.js');

/**
 * The subscription name/query editor. `sub.init` seeds the form — the
 * presence of `id` is the only difference between editing an existing
 * subscription and creating a new one, and it is what `sub.save` echoes
 * back. The Save button's disabled state is the validity contract: both
 * fields must have non-whitespace text.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  posted.length = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-subscription-editor></ditto-subscription-editor>`, host);
  const el = host.querySelector('ditto-subscription-editor') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

const nameInput = (el: Element): HTMLInputElement =>
  el.shadowRoot!.querySelector('input') as HTMLInputElement;
const queryInput = (el: Element): HTMLTextAreaElement =>
  el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
const saveButton = (el: Element): HTMLButtonElement =>
  el.shadowRoot!.querySelector('.save') as HTMLButtonElement;
const cancelButton = (el: Element): HTMLButtonElement =>
  el.shadowRoot!.querySelector('.cancel') as HTMLButtonElement;

async function type(
  el: Element,
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await el.updateComplete;
}

function initSub(id: string | undefined, name: string, query: string): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'sub.init', id, name, query },
  }));
}

function lastPosted(): Record<string, unknown> {
  const msg = posted.at(-1) as Record<string, unknown> | undefined;
  assert.ok(msg, 'expected a posted message');
  return msg;
}

test('Sub: Save starts disabled and enables only when both fields have text', async t => {
  const { el } = await mount(t);
  assert.equal(saveButton(el).disabled, true);
  await type(el, nameInput(el), 'My subscription');
  assert.equal(saveButton(el).disabled, true, 'query still empty');
  await type(el, queryInput(el), 'SELECT * FROM tasks');
  assert.equal(saveButton(el).disabled, false);
});

test('Sub: sub.init populates the form for an existing subscription', async t => {
  const { el } = await mount(t);
  initSub('sub-1', 'Tasks sync', 'SELECT * FROM tasks');
  await el.updateComplete;
  assert.equal(nameInput(el).value, 'Tasks sync');
  assert.equal(queryInput(el).value, 'SELECT * FROM tasks');
  assert.equal(saveButton(el).disabled, false);
});

test('Sub: Save echoes the id and the current field values', async t => {
  const { el } = await mount(t);
  initSub('sub-1', 'Tasks sync', 'SELECT * FROM tasks');
  await el.updateComplete;
  await type(el, nameInput(el), 'Renamed');

  saveButton(el).click();
  await el.updateComplete;
  assert.deepEqual(lastPosted(), {
    type: 'sub.save', id: 'sub-1', name: 'Renamed', query: 'SELECT * FROM tasks',
  });
});

test('Sub: Save for a new subscription posts an undefined id', async t => {
  const { el } = await mount(t);
  await type(el, nameInput(el), 'New sub');
  await type(el, queryInput(el), 'SELECT * FROM c');

  saveButton(el).click();
  await el.updateComplete;
  assert.deepEqual(lastPosted(), {
    type: 'sub.save', id: undefined, name: 'New sub', query: 'SELECT * FROM c',
  });
});

test('Sub: Cancel posts sub.cancel', async t => {
  const { el } = await mount(t);
  cancelButton(el).click();
  await el.updateComplete;
  assert.deepEqual(lastPosted(), { type: 'sub.cancel' });
});

test('Sub: whitespace-only fields do not count towards validity', async t => {
  const { el } = await mount(t);
  await type(el, nameInput(el), '   ');
  await type(el, queryInput(el), 'SELECT 1');
  assert.equal(saveButton(el).disabled, true, 'whitespace name is not a name');

  await type(el, nameInput(el), 'x');
  assert.equal(saveButton(el).disabled, false);

  await type(el, queryInput(el), '  ');
  assert.equal(saveButton(el).disabled, true, 'whitespace query is not a query');
});

test('Sub: ignores sub.init while detached and applies it on re-attach', async t => {
  const { host, el } = await mount(t);

  host.remove();
  await el.updateComplete;
  initSub('ghost', 'ghost', 'ghost');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(nameInput(el).value, '', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  initSub('s9', 'Back again', 'SELECT * FROM back');
  await el.updateComplete;
  assert.equal(nameInput(el).value, 'Back again');
  assert.equal(queryInput(el).value, 'SELECT * FROM back');
});
