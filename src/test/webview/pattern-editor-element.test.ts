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

await import('../../../webview-ui/patternEditor/pattern-editor-element.js');

import type { KeyedRawPattern } from '../../logAnalyzer/PatternEngine.js';

interface Editor extends HTMLElement {
  updateComplete: Promise<unknown>;
  bundled: KeyedRawPattern[];
  user: KeyedRawPattern[];
  editing: KeyedRawPattern | null;
  showForm: boolean;
  errMessage: string | null;
}

interface Form extends HTMLElement {
  updateComplete: Promise<unknown>;
  editing: KeyedRawPattern | null;
  bundledKeys: string[];
}

const bundledFixture: KeyedRawPattern[] = [
  { key: 'sync-start', pattern: 'sync started', severity: 2, recommendation: 'Informational' },
];

const userFixture: KeyedRawPattern[] = [
  {
    key: 'crash-loop',
    pattern: 'boom (\\d+)',
    severity: 4,
    recommendation: 'Check the crash log',
    level_filter: 'error',
    tag_filter: '^sdk$',
    user_tag: 'crash',
  },
];

async function mount(t: { after(fn: () => void): void }): Promise<Editor> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-pattern-editor></ditto-pattern-editor>`, host);
  const el = host.querySelector('ditto-pattern-editor') as unknown as Editor;
  await el.updateComplete;
  return el;
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function sendSnapshot(bundled = bundledFixture, user = userFixture): void {
  send({ type: 'patternEditor.snapshot', bundled, user });
}

async function settled(el: Editor): Promise<void> {
  await el.updateComplete;
  const form = el.shadowRoot!.querySelector('pattern-form') as unknown as Form | null;
  if (form) { await form.updateComplete; }
  const list = el.shadowRoot!.querySelector('pattern-list') as unknown as Form | null;
  if (list) { await list.updateComplete; }
}

/** Form field accessors — the form lays its controls out in a fixed label
 *  order: key, pattern, severity, recommendation, level, tag, userTag, test. */
function formOf(el: Editor): Form {
  const form = el.shadowRoot!.querySelector('pattern-form') as unknown as Form | null;
  assert.ok(form, 'expected the form to be open');
  return form;
}

function field(form: Form, labelText: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  for (const label of form.shadowRoot!.querySelectorAll('label')) {
    if (label.textContent.trim().startsWith(labelText)) {
      return label.querySelector('input, textarea, select')!;
    }
  }
  throw new Error(`no field labelled ${labelText}`);
}

function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function saveButton(form: Form): HTMLButtonElement {
  const buttons = form.shadowRoot!.querySelectorAll('.row button');
  return buttons[buttons.length - 1] as HTMLButtonElement;
}

async function fillValidForm(el: Editor, key = 'my-key'): Promise<Form> {
  const form = formOf(el);
  typeInto(field(form, 'Key') as HTMLInputElement, key);
  typeInto(field(form, 'Pattern') as HTMLInputElement, 'boom \\d+');
  typeInto(field(form, 'Recommendation') as HTMLTextAreaElement, 'fix it');
  await settled(el);
  return form;
}

test('PatternEditor: snapshot renders bundled and user sections', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);

  const list = el.shadowRoot!.querySelector('pattern-list')!;
  const text = list.shadowRoot!.textContent;
  assert.match(text, /sync started/);
  assert.match(text, /boom \(\\d\+\)/);
  assert.match(text, /SEV 4/);
  assert.equal(list.shadowRoot!.querySelectorAll('.row').length, 2);
});

test('PatternEditor: empty snapshot renders both empty-state hints', async t => {
  const el = await mount(t);
  sendSnapshot([], []);
  await settled(el);

  const list = el.shadowRoot!.querySelector('pattern-list')!;
  const empties = [...list.shadowRoot!.querySelectorAll('.empty')].map(e => e.textContent);
  assert.match(empties[0]!, /No bundled patterns loaded/);
  assert.match(empties[1]!, /None yet/);
});

test('PatternEditor: Add Pattern opens an empty form; save posts patternEditor.save', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);

  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);
  assert.equal(el.showForm, true);
  assert.equal(el.editing, null, 'add flow starts from a blank pattern');

  const form = formOf(el);
  assert.equal(saveButton(form).disabled, true, 'empty form cannot save');

  await fillValidForm(el);
  assert.equal(saveButton(formOf(el)).disabled, false);

  const before = posted.length;
  saveButton(formOf(el)).click();
  assert.deepEqual(posted[before], {
    type: 'patternEditor.save',
    pattern: { key: 'my-key', pattern: 'boom \\d+', severity: 3, recommendation: 'fix it' },
  }, 'new patterns carry no replaceKey');
});

test('PatternEditor: invalid regex blocks save and shows the error', async t => {
  const el = await mount(t);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);

  const form = formOf(el);
  typeInto(field(form, 'Key') as HTMLInputElement, 'k');
  typeInto(field(form, 'Pattern') as HTMLInputElement, '[unterminated');
  typeInto(field(form, 'Recommendation') as HTMLTextAreaElement, 'r');
  await settled(el);

  assert.match(form.shadowRoot!.textContent, /Invalid regular expression|Unterminated/);
  assert.equal(saveButton(form).disabled, true);

  typeInto(field(form, 'Pattern') as HTMLInputElement, 'fine');
  await settled(el);
  assert.match(formOf(el).shadowRoot!.textContent, /✓ valid regex/);
});

test('PatternEditor: bundled-key collision blocks save with an inline error', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);

  const form = await fillValidForm(el, 'sync-start');
  assert.match(form.shadowRoot!.textContent, /Collides with bundled key/);
  assert.equal(saveButton(form).disabled, true);
});

test('PatternEditor: test line reports match state live', async t => {
  const el = await mount(t);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);
  const form = await fillValidForm(el);

  typeInto(field(form, 'Test line') as HTMLInputElement, 'boom 42 happened');
  await settled(el);
  assert.match(formOf(el).shadowRoot!.textContent, /✓ Matches/);

  typeInto(field(formOf(el), 'Test line') as HTMLInputElement, 'nothing here');
  await settled(el);
  assert.match(formOf(el).shadowRoot!.textContent, /✗ No match/);
});

test('PatternEditor: Edit populates the form and save posts replaceKey + optional fields', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);

  const list = el.shadowRoot!.querySelector('pattern-list')!;
  const editBtn = [...list.shadowRoot!.querySelectorAll('button')]
    .find(b => b.textContent === 'Edit') as HTMLButtonElement;
  editBtn.click();
  await settled(el);

  const form = formOf(el);
  assert.equal((field(form, 'Key') as HTMLInputElement).value, 'crash-loop');
  assert.equal((field(form, 'Pattern') as HTMLInputElement).value, 'boom (\\d+)');
  assert.equal((field(form, 'Severity') as HTMLSelectElement).value, '4');
  assert.equal((field(form, 'Recommendation') as HTMLTextAreaElement).value, 'Check the crash log');
  assert.equal((field(form, 'Level filter') as HTMLSelectElement).value, 'error');
  assert.equal((field(form, 'Tag filter') as HTMLInputElement).value, '^sdk$');
  assert.equal((field(form, 'User tag') as HTMLInputElement).value, 'crash');

  // Rename the key and adjust severity: the original key becomes replaceKey.
  typeInto(field(form, 'Key') as HTMLInputElement, 'crash-loop-v2');
  choose(field(form, 'Severity') as HTMLSelectElement, '5');
  await settled(el);

  const before = posted.length;
  saveButton(formOf(el)).click();
  assert.deepEqual(posted[before], {
    type: 'patternEditor.save',
    pattern: {
      key: 'crash-loop-v2',
      pattern: 'boom (\\d+)',
      severity: 5,
      recommendation: 'Check the crash log',
      level_filter: 'error',
      tag_filter: '^sdk$',
      user_tag: 'crash',
    },
    replaceKey: 'crash-loop',
  });
});

test('PatternEditor: Delete posts patternEditor.delete', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);

  const list = el.shadowRoot!.querySelector('pattern-list')!;
  const delBtn = [...list.shadowRoot!.querySelectorAll('button')]
    .find(b => b.textContent === 'Delete') as HTMLButtonElement;
  const before = posted.length;
  delBtn.click();
  assert.deepEqual(posted[before], { type: 'patternEditor.delete', key: 'crash-loop' });
});

test('PatternEditor: Cancel closes the form without posting', async t => {
  const el = await mount(t);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);
  assert.equal(el.showForm, true);

  const before = posted.length;
  const cancel = formOf(el).shadowRoot!.querySelector('.row button.secondary') as HTMLButtonElement;
  cancel.click();
  await settled(el);
  assert.equal(el.showForm, false);
  assert.equal(posted.length, before, 'cancel must not post anything');
});

test('PatternEditor: saveOk closes the form; saveFailed keeps it open with a banner', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);

  send({ type: 'patternEditor.saveFailed', key: 'my-key', message: 'regex rejected by host' });
  await settled(el);
  assert.equal(el.showForm, true, 'form stays open so the user can correct input');
  assert.match(el.shadowRoot!.querySelector('.err')!.textContent, /regex rejected by host/);

  send({ type: 'patternEditor.saveOk', key: 'my-key' });
  await settled(el);
  assert.equal(el.showForm, false);
  assert.equal(el.shadowRoot!.querySelector('.err'), null);
});

test('PatternEditor: snapshot clears a stale error banner', async t => {
  const el = await mount(t);
  send({ type: 'patternEditor.saveFailed', key: 'k', message: 'boom' });
  await settled(el);
  assert.ok(el.shadowRoot!.querySelector('.err'));

  sendSnapshot();
  await settled(el);
  assert.equal(el.shadowRoot!.querySelector('.err'), null);
});

test('PatternEditor: editing → add transition resets the form fields', async t => {
  const el = await mount(t);
  sendSnapshot();
  await settled(el);

  const list = el.shadowRoot!.querySelector('pattern-list')!;
  ([...list.shadowRoot!.querySelectorAll('button')]
    .find(b => b.textContent === 'Edit') as HTMLButtonElement).click();
  await settled(el);
  assert.equal((field(formOf(el), 'Key') as HTMLInputElement).value, 'crash-loop');

  // Cancel, then start a new pattern: nothing from the edit may leak through.
  (formOf(el).shadowRoot!.querySelector('.row button.secondary') as HTMLButtonElement).click();
  await settled(el);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);

  const form = formOf(el);
  assert.equal((field(form, 'Key') as HTMLInputElement).value, '');
  assert.equal((field(form, 'Pattern') as HTMLInputElement).value, '');
  assert.equal((field(form, 'Severity') as HTMLSelectElement).value, '3');
  assert.equal((field(form, 'Recommendation') as HTMLTextAreaElement).value, '');
  assert.equal((field(form, 'Level filter') as HTMLSelectElement).value, '');
  assert.equal((field(form, 'Tag filter') as HTMLInputElement).value, '');
  assert.equal((field(form, 'User tag') as HTMLInputElement).value, '');
});

test('PatternEditor: optional filters are omitted from the save payload when blank', async t => {
  const el = await mount(t);
  (el.shadowRoot!.querySelector('.toolbar button') as HTMLButtonElement).click();
  await settled(el);
  await fillValidForm(el);

  const before = posted.length;
  saveButton(formOf(el)).click();
  const msg = posted[before] as { pattern: Record<string, unknown> };
  assert.equal('level_filter' in msg.pattern, false);
  assert.equal('tag_filter' in msg.pattern, false);
  assert.equal('user_tag' in msg.pattern, false);
});

test('PatternEditor: ignores host messages while detached and resumes on re-attach', async t => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-pattern-editor></ditto-pattern-editor>`, host);
  const el = host.querySelector('ditto-pattern-editor') as unknown as Editor;
  await el.updateComplete;

  sendSnapshot();
  await settled(el);
  assert.equal(el.bundled.length, 1);

  host.remove();
  await el.updateComplete;
  sendSnapshot([], []);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.bundled.length, 1, 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  sendSnapshot([], []);
  await settled(el);
  assert.equal(el.bundled.length, 0);
});
