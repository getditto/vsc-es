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

await import('../../../webview-ui/importData/import-data-element.js');

/**
 * Import Data panel: file picking, existing/new collection targeting, the
 * insert-type switch, and the import status state machine
 * (idle → importing → done/error), all driven by host messages.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  databaseName: string;
  existingCollections: string[];
  useExistingCollection: boolean;
  selectedExistingCollection: string;
  newCollectionName: string;
  insertType: string;
  fileName: string | undefined;
  documentCount: number | undefined;
  isImporting: boolean;
  errorMessage: string | undefined;
  done: { successCount: number; failureCount: number; errors: string[]; collection: string } | undefined;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-import-data></ditto-import-data>`, host);
  const el = host.querySelector('ditto-import-data') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function init(collections: string[], preselected?: string): void {
  send({
    type: 'importData.init',
    databaseName: 'mydb',
    existingCollections: collections,
    ...(preselected === undefined ? {} : { preselectedCollection: preselected }),
  });
}

function chooseFileButton(el: Element): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>('.file-row button')!;
}

function importButton(el: Element): HTMLButtonElement {
  return el.shadowRoot!.querySelector<HTMLButtonElement>('.footer button.primary')!;
}

/** Indexing under noUncheckedIndexedAccess, with a built-in existence check. */
function at<T>(list: ArrayLike<T>, i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `expected index ${i} to exist`);
  return v;
}

test('ImportData: idle state shows no file and a disabled Import; Choose File posts to the host', async t => {
  const { el } = await mount(t);
  assert.match(el.shadowRoot!.textContent ?? '', /No file selected/);
  assert.equal(importButton(el).disabled, true, 'cannot import without a file');
  assert.equal((importButton(el).textContent ?? '').trim(), 'Import');

  postedToHost.length = 0;
  chooseFileButton(el).click();
  assert.deepEqual(postedToHost, [{ type: 'importData.chooseFile' }]);
});

test('ImportData: init applies the database name and honours the preselected collection', async t => {
  const { el } = await mount(t);
  init(['alpha', 'beta'], 'beta');
  await el.updateComplete;

  assert.equal(el.databaseName, 'mydb');
  assert.match(el.shadowRoot!.textContent ?? '', /mydb/);
  assert.equal(el.useExistingCollection, true);
  assert.equal(el.selectedExistingCollection, 'beta',
    'the preselect lands in state — targetCollection is what startImport posts');
  const select = el.shadowRoot!.querySelector('select')!;
  assert.equal(select.querySelectorAll('option').length, 2);
});

test('ImportData: init falls back to the first collection when the preselect is unknown or absent', async t => {
  const { el } = await mount(t);
  init(['x', 'y'], 'not-a-collection');
  await el.updateComplete;
  assert.equal(el.selectedExistingCollection, 'x');
  assert.equal(el.shadowRoot!.querySelector('select')!.value, 'x');
});

test('ImportData: empty collection list renders a placeholder; collectionsRefreshed populates it', async t => {
  const { el } = await mount(t);
  init([]);
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.empty-collections'), 'placeholder shown');
  assert.equal(el.selectedExistingCollection, '');

  send({ type: 'importData.collectionsRefreshed', existingCollections: ['a', 'b'] });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.empty-collections'), null);
  assert.equal(el.selectedExistingCollection, 'a', 'first refreshed collection becomes the default');
  assert.equal(el.shadowRoot!.querySelector('select')!.value, 'a');
});

test('ImportData: changing the dropdown updates the selected collection', async t => {
  const { el } = await mount(t);
  init(['a', 'b'], 'a');
  await el.updateComplete;

  const select = el.shadowRoot!.querySelector('select')!;
  select.value = 'b';
  select.dispatchEvent(new Event('change'));
  await el.updateComplete;
  assert.equal(el.selectedExistingCollection, 'b');
});

test('ImportData: fileSelected shows the file and document count, and clears error/done state', async t => {
  const { el } = await mount(t);
  send({ type: 'importData.error', message: 'boom' });
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.status-card.error'));

  send({ type: 'importData.fileSelected', fileName: 'data.json', documentCount: 1 });
  await el.updateComplete;
  assert.equal(el.fileName, 'data.json');
  assert.match(el.shadowRoot!.textContent ?? '', /data\.json/);
  assert.match(el.shadowRoot!.textContent ?? '', /1 document(?!s)/, 'singular');
  assert.equal(el.shadowRoot!.querySelector('.status-card.error'), null, 'error cleared by the new file');

  send({ type: 'importData.done', successCount: 1, failureCount: 0, errors: [], collection: 'c' });
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.status-card.success'));
  send({ type: 'importData.fileSelected', fileName: 'more.json', documentCount: 3 });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.status-card.success'), null, 'done cleared by the new file');
  assert.match(el.shadowRoot!.textContent ?? '', /3 documents/, 'plural');
});

test('ImportData: progress renders the bar, percentage and current document id', async t => {
  const { el } = await mount(t);
  init(['col']);
  send({ type: 'importData.progress', current: 3, total: 10, currentDocumentId: 'doc-9' });
  await el.updateComplete;

  assert.equal(el.isImporting, true);
  const card = el.shadowRoot!.querySelector('.status-card.progress')!;
  assert.match(card.textContent ?? '', /Importing: 3 of 10 documents \(30%\)/);
  assert.match(card.textContent ?? '', /Processing: doc-9/);
  const fill = card.querySelector<HTMLElement>('.progress-fill')!;
  assert.equal(fill.style.width, '30%');

  assert.equal(importButton(el).disabled, true);
  assert.match(importButton(el).textContent ?? '', /Importing…/);
  assert.equal(chooseFileButton(el).disabled, true, 'file picker locked mid-import');

  // Zero-total guard: percentage falls back to 0, and no doc id line without one.
  send({ type: 'importData.progress', current: 0, total: 0 });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /\(0%\)/);
  assert.equal(el.shadowRoot!.querySelector('.doc-id'), null);
});

test('ImportData: Import posts importData.start with the target collection and insert type', async t => {
  const { el } = await mount(t);
  init(['alpha', 'beta'], 'beta');
  send({ type: 'importData.fileSelected', fileName: 'd.json', documentCount: 2 });
  await el.updateComplete;

  postedToHost.length = 0;
  importButton(el).click();
  await el.updateComplete;

  assert.deepEqual(postedToHost, [{ type: 'importData.start', collection: 'beta', insertType: 'regular' }]);
  assert.equal(el.isImporting, true);
  assert.match(el.shadowRoot!.textContent ?? '', /Importing: 0 of 2 documents/,
    'progress state seeded from the known document count');
});

test('ImportData: new-collection flow trims the name; switching back refreshes collections', async t => {
  const { el } = await mount(t);
  init(['alpha']);
  await el.updateComplete;

  const segs = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.segmented button');
  const existingBtn = at(segs, 0);
  const newBtn = at(segs, 1);
  newBtn.click();
  await el.updateComplete;
  assert.equal(el.useExistingCollection, false);
  const input = el.shadowRoot!.querySelector<HTMLInputElement>('#new-collection-input')!;
  input.value = '  newcol  ';
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;

  send({ type: 'importData.fileSelected', fileName: 'd.json', documentCount: 1 });
  await el.updateComplete;
  postedToHost.length = 0;
  importButton(el).click();
  assert.deepEqual(postedToHost, [{ type: 'importData.start', collection: 'newcol', insertType: 'regular' }],
    'the name is trimmed before it goes to the host');

  send({ type: 'importData.done', successCount: 1, failureCount: 0, errors: [], collection: 'newcol' });
  await el.updateComplete;

  postedToHost.length = 0;
  existingBtn.click();
  await el.updateComplete;
  assert.equal(el.useExistingCollection, true);
  assert.deepEqual(postedToHost, [{ type: 'importData.refreshCollections' }],
    'switching back to Existing refreshes the list');
});

test('ImportData: insert-type switch toggles via click and keyboard', async t => {
  const { el } = await mount(t);
  const switchEl = () => el.shadowRoot!.querySelector<HTMLElement>('.switch')!;
  assert.match(el.shadowRoot!.textContent ?? '', /Regular Insert/);
  assert.equal(el.shadowRoot!.querySelector('.initial-info'), null);

  switchEl().click();
  await el.updateComplete;
  assert.equal(el.insertType, 'initial');
  assert.match(el.shadowRoot!.textContent ?? '', /Initial Documents Insert/);
  assert.ok(el.shadowRoot!.querySelector('.initial-info'), 'initial-insert explainer shown');
  assert.equal(switchEl().getAttribute('aria-checked'), 'true');

  switchEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.insertType, 'regular');

  switchEl().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.insertType, 'initial');

  switchEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.insertType, 'initial', 'unrelated keys do not toggle');

  // The chosen insert type is what startImport reports.
  init(['col']);
  send({ type: 'importData.fileSelected', fileName: 'd.json', documentCount: 1 });
  await el.updateComplete;
  postedToHost.length = 0;
  importButton(el).click();
  assert.deepEqual(postedToHost, [{ type: 'importData.start', collection: 'col', insertType: 'initial' }]);
});

test('ImportData: done replaces Import with a Done button and clears the buffered file', async t => {
  const { el } = await mount(t);
  init(['col']);
  send({ type: 'importData.fileSelected', fileName: 'd.json', documentCount: 2 });
  await el.updateComplete;
  importButton(el).click();
  await el.updateComplete;

  send({ type: 'importData.done', successCount: 2, failureCount: 0, errors: [], collection: 'col' });
  await el.updateComplete;

  assert.equal(el.isImporting, false);
  const card = el.shadowRoot!.querySelector('.status-card.success')!;
  assert.match(card.textContent ?? '', /Successfully imported 2 documents to col/);
  assert.equal(el.fileName, undefined, 'file cleared so a re-import requires a new pick');
  assert.match(el.shadowRoot!.textContent ?? '', /No file selected/);

  postedToHost.length = 0;
  const doneBtn = importButton(el);
  assert.equal((doneBtn.textContent ?? '').trim(), 'Done');
  doneBtn.click();
  assert.deepEqual(postedToHost, [{ type: 'importData.cancel' }]);
});

test('ImportData: partial failure renders the error card with per-document errors', async t => {
  const { el } = await mount(t);
  send({ type: 'importData.done', successCount: 1, failureCount: 2, errors: ['doc-1: duplicate', 'doc-2: bad shape'], collection: 'c' });
  await el.updateComplete;

  const card = el.shadowRoot!.querySelector('.status-card.error')!;
  assert.match(card.textContent ?? '', /Imported 1 document to c with 2 failures/);
  assert.match(card.textContent ?? '', /doc-1: duplicate/);
  assert.match(card.textContent ?? '', /doc-2: bad shape/);
});

test('ImportData: importData.error surfaces the message; Choose File dismisses it', async t => {
  const { el } = await mount(t);
  send({ type: 'importData.progress', current: 1, total: 5 });
  await el.updateComplete;
  send({ type: 'importData.error', message: 'disk full' });
  await el.updateComplete;

  assert.equal(el.isImporting, false);
  const card = el.shadowRoot!.querySelector('.status-card.error')!;
  assert.match(card.textContent ?? '', /disk full/);

  postedToHost.length = 0;
  chooseFileButton(el).click();
  await el.updateComplete;
  assert.deepEqual(postedToHost, [{ type: 'importData.chooseFile' }]);
  assert.equal(el.errorMessage, undefined, 'picking a new file clears the error');
  assert.equal(el.shadowRoot!.querySelector('.status-card.error'), null);
});

test('ImportData: Import stays disabled until a file and a non-empty target collection exist', async t => {
  const { el } = await mount(t);
  init([]);
  send({ type: 'importData.fileSelected', fileName: 'd.json', documentCount: 4 });
  await el.updateComplete;

  // New-collection target is empty → cannot import even with a file.
  const segs = el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.segmented button');
  at(segs, 1).click();
  await el.updateComplete;
  postedToHost.length = 0;
  importButton(el).click();
  assert.deepEqual(postedToHost, [], 'disabled button never reaches the host');

  const input = el.shadowRoot!.querySelector<HTMLInputElement>('#new-collection-input')!;
  input.value = 'typed';
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
  assert.equal(importButton(el).disabled, false);
});

test('ImportData: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  init(['col']);
  await el.updateComplete;

  // VS Code re-parents panels between editor groups: no host-message
  // processing while detached.
  host.remove();
  await el.updateComplete;
  send({ type: 'importData.fileSelected', fileName: 'stale.json', documentCount: 9 });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.fileName, undefined, 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  send({ type: 'importData.fileSelected', fileName: 'live.json', documentCount: 2 });
  await el.updateComplete;
  assert.equal(el.fileName, 'live.json', 'exactly one handler comes back live on re-attach');
});
