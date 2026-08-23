import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';
import type { IndexField } from '../../models/DittoCollection.js';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(message: unknown) { posted.push(message); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/addIndex/add-index-element.js');

/**
 * The composite-index editor.
 *
 * Key order is significant to the query optimizer, so the reorder controls and
 * the order of the emitted `fields` array are correctness properties, not
 * cosmetics. jsdom performs no layout, so nothing here asserts appearance.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<Element> {
  posted.length = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-add-index></ditto-add-index>`, host);
  const el = host.querySelector('ditto-add-index') as unknown as Element;
  await el.updateComplete;
  // Seed the collection list the host would send on open.
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'addIndex.init', collections: ['tasks'], preselected: 'tasks' },
  }));
  await el.updateComplete;
  return el;
}

const rows = (el: Element): HTMLElement[] =>
  [...el.shadowRoot!.querySelectorAll('.key-row')] as HTMLElement[];
const inputs = (el: Element): HTMLInputElement[] =>
  [...el.shadowRoot!.querySelectorAll('.key-row input')] as HTMLInputElement[];
const selects = (el: Element): HTMLSelectElement[] =>
  [...el.shadowRoot!.querySelectorAll('.key-row select')] as HTMLSelectElement[];
const rowButtons = (el: Element, i: number): HTMLButtonElement[] =>
  [...rows(el)[i].querySelectorAll('button')] as HTMLButtonElement[];
const addFieldButton = (el: Element): HTMLButtonElement =>
  el.shadowRoot!.querySelector('.add-field') as HTMLButtonElement;
const createButton = (el: Element): HTMLButtonElement =>
  el.shadowRoot!.querySelector('.footer .save') as HTMLButtonElement;

async function type(el: Element, i: number, value: string): Promise<void> {
  const input = inputs(el)[i];
  input.value = value;
  input.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
  await el.updateComplete;
}

async function setDirection(el: Element, i: number, dir: 'ASC' | 'DESC'): Promise<void> {
  const sel = selects(el)[i];
  sel.value = dir;
  sel.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
  await el.updateComplete;
}

async function click(el: Element, btn: HTMLButtonElement): Promise<void> {
  btn.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('click', { bubbles: true }));
  await el.updateComplete;
}

test('AddIndex: starts with one empty field row', async t => {
  const el = await mount(t);
  assert.equal(rows(el).length, 1);
  assert.equal(inputs(el)[0].value, '');
});

test('AddIndex: Add field appends a row', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await click(el, addFieldButton(el));
  assert.equal(rows(el).length, 3);
});

test('AddIndex: removing a row leaves the others, and never leaves zero rows', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await type(el, 0, 'first');
  await type(el, 1, 'second');

  // Remove is the third button in a row (up, down, remove).
  await click(el, rowButtons(el, 0)[2]);
  assert.equal(rows(el).length, 1);
  assert.equal(inputs(el)[0].value, 'second', 'removed the right row');

  await click(el, rowButtons(el, 0)[2]);
  assert.equal(rows(el).length, 1, 'an empty editor has nothing to type into');
  assert.equal(inputs(el)[0].value, '');
});

test('AddIndex: reorder swaps adjacent keys', async t => {
  // Key order decides which queries the index serves, so it has to be editable
  // without retyping every row.
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await type(el, 0, 'status');
  await type(el, 1, 'createdAt');

  await click(el, rowButtons(el, 1)[0]); // move second row up
  assert.deepEqual(inputs(el).map(i => i.value), ['createdAt', 'status']);

  await click(el, rowButtons(el, 0)[1]); // move it back down
  assert.deepEqual(inputs(el).map(i => i.value), ['status', 'createdAt']);
});

test('AddIndex: the reorder buttons are disabled at the ends', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  assert.equal(rowButtons(el, 0)[0].disabled, true, 'first row cannot move up');
  assert.equal(rowButtons(el, 0)[1].disabled, false);
  assert.equal(rowButtons(el, 1)[0].disabled, false);
  assert.equal(rowButtons(el, 1)[1].disabled, true, 'last row cannot move down');
});

test('AddIndex: Create is disabled until a field has a name', async t => {
  const el = await mount(t);
  assert.equal(createButton(el).disabled, true);
  await type(el, 0, 'status');
  assert.equal(createButton(el).disabled, false);
});

test('AddIndex: a duplicate key is reported inline and blocks Create', async t => {
  // Ditto would accept it, but the key adds nothing and the generated name
  // becomes ambiguous. Reporting it inline beats a round-trip error.
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await type(el, 0, 'status');
  await type(el, 1, 'status');

  assert.equal(createButton(el).disabled, true);
  assert.match(el.shadowRoot!.textContent ?? '', /listed more than once/);

  await type(el, 1, 'createdAt');
  assert.equal(createButton(el).disabled, false);
});

test('AddIndex: whitespace-only rows do not count towards validity', async t => {
  const el = await mount(t);
  await type(el, 0, '   ');
  assert.equal(createButton(el).disabled, true);
});

test('AddIndex: the info text describes composite indexes, not a one-field limit', async t => {
  // The old copy asserted "DQL limits indexes to a single field", which SDK 5.1
  // made false — and it was the only place a user would learn otherwise.
  const el = await mount(t);
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /composite index/i);
  assert.doesNotMatch(text, /limits indexes to a single field/i);
  assert.match(text, /order matters/i, 'and explains why order matters');
});

test('AddIndex: each row exposes an accessible name', async t => {
  // Five controls per row with icon-only labels; without these the editor is
  // unusable with a screen reader.
  const el = await mount(t);
  assert.equal(inputs(el)[0].getAttribute('aria-label'), 'Index field 1');
  assert.equal(selects(el)[0].getAttribute('aria-label'), 'Sort direction for field 1');
  assert.equal(rowButtons(el, 0)[2].getAttribute('aria-label'), 'Remove field 1');
});

test('AddIndex: direction defaults to ASC and is settable per row', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  assert.deepEqual(selects(el).map(s => s.value), ['ASC', 'ASC']);
  await setDirection(el, 1, 'DESC');
  assert.deepEqual(selects(el).map(s => s.value), ['ASC', 'DESC']);
});

test('AddIndex: Create emits the keys in the order shown, with directions', async t => {
  // The payload the host turns into `CREATE INDEX … (a ASC, b DESC)`. Order and
  // direction are the whole contract.
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await type(el, 0, '  status  ');
  await type(el, 1, 'createdAt');
  await setDirection(el, 1, 'DESC');

  await click(el, createButton(el));

  const msg = posted.find(
    (m): m is { type: string; collection: string; fields: IndexField[] } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'addIndex.create',
  );
  assert.ok(msg, `expected an addIndex.create, saw ${JSON.stringify(posted)}`);
  assert.equal(msg.collection, 'tasks');
  assert.deepEqual(msg.fields, [
    { name: 'status', ascending: true },
    { name: 'createdAt', ascending: false },
  ], 'trimmed, ordered, with per-key direction');
});

test('AddIndex: Create drops blank rows from the payload', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await click(el, addFieldButton(el));
  await type(el, 0, 'a');
  await type(el, 2, 'b');

  await click(el, createButton(el));

  const msg = posted.find(
    (m): m is { fields: IndexField[] } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'addIndex.create',
  );
  assert.deepEqual(msg?.fields.map(f => f.name), ['a', 'b']);
});

test('AddIndex: reordering changes what Create emits', async t => {
  const el = await mount(t);
  await click(el, addFieldButton(el));
  await type(el, 0, 'first');
  await type(el, 1, 'second');
  await click(el, rowButtons(el, 1)[0]); // move up

  await click(el, createButton(el));

  const msg = posted.find(
    (m): m is { fields: IndexField[] } =>
      typeof m === 'object' && m !== null && (m as { type?: string }).type === 'addIndex.create',
  );
  assert.deepEqual(msg?.fields.map(f => f.name), ['second', 'first']);
});

test('AddIndex: a host error is shown and re-enables Create', async t => {
  const el = await mount(t);
  await type(el, 0, 'status');
  await click(el, createButton(el));
  assert.equal(createButton(el).disabled, true, 'disabled while in flight');

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'addIndex.error', message: 'An index named "idx_tasks_status" already exists' },
  }));
  await el.updateComplete;

  assert.match(el.shadowRoot!.textContent ?? '', /already exists/);
  assert.equal(createButton(el).disabled, false, 'the user can correct and retry');
});
