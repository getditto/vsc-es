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

await import('../../../webview-ui/query/query-element.js');

/**
 * Query Editor webview — the ADVISE advisory card. Elements mount in
 * table view so the CodeMirror-backed JSON view never instantiates
 * (jsdom lacks the measurement surface EditorView measures against).
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  advice: unknown;
  view: string;
}

const SUGGESTION = {
  collection: 'atest',
  reason: 'equality predicates on `e`',
  statement: 'CREATE INDEX IF NOT EXISTS adv_atest_e ON default:`atest` (`e` ASC)',
};

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-query-editor></ditto-query-editor>`, host);
  const el = host.querySelector('ditto-query-editor') as unknown as Element;
  el.view = 'table'; // json view mounts CodeMirror; jsdom can't host EditorView
  await el.updateComplete;
  return { host, el };
}

function resultMessage(advice: unknown): unknown {
  return {
    type: 'query.result',
    rows: [{ advice: { statement: 'SELECT * FROM atest WHERE e = 1\n', suggestedIndexes: [SUGGESTION] } }],
    columns: ['advice'],
    durationMs: 1,
    metadata: { dql: 'ADVISE SELECT * FROM atest WHERE e = 1', durationMs: 1, resultCount: 1, explain: '', timestamp: 0 },
    advice,
  };
}

test('Query webview: a result carrying advice renders the advisory card', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'SELECT * FROM atest WHERE e = 1\n', suggestions: [SUGGESTION] }),
  }));
  await el.updateComplete;
  const card = el.shadowRoot!.querySelector('.advice-card');
  assert.ok(card, 'advisory card rendered');
  assert.match(card.textContent ?? '', /Index advice/);
  assert.match(card.textContent ?? '', /equality predicates on `e`/);
  assert.match(card.textContent ?? '', /CREATE INDEX IF NOT EXISTS adv_atest_e/);
});

test('Query webview: a result without advice renders no card', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', { data: resultMessage(null) }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.advice-card'), null);
});

test('Query webview: advice with no suggestions explains the outcome', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'SELECT * FROM atest\n', suggestions: [], outcome: 'no keys to advise on' }),
  }));
  await el.updateComplete;
  const card = el.shadowRoot!.querySelector('.advice-card');
  assert.ok(card);
  assert.match(card.textContent ?? '', /no keys to advise on/);
  assert.equal(card.querySelector('button'), null, 'nothing to apply — no button');
});

test('Query webview: Create index posts the suggestion and tracks host feedback', async t => {
  const { el } = await mount(t);
  postedToHost.length = 0;
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'S\n', suggestions: [SUGGESTION] }),
  }));
  await el.updateComplete;

  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.advice-suggestion button');
  assert.ok(button, 'create button rendered');
  assert.equal(button.disabled, false);
  button.click();
  await el.updateComplete;

  assert.deepEqual(postedToHost, [{
    type: 'query.createSuggestedIndex',
    statement: SUGGESTION.statement,
    collection: 'atest',
  }], 'the exact suggested statement went to the host');
  assert.equal(button.disabled, true, 'pending while the host confirms');

  // Host confirms the create succeeded → button locks into "Created".
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'query.adviseFeedback', statement: SUGGESTION.statement, outcome: 'created' },
  }));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Index created/);
  assert.equal(el.shadowRoot!.querySelector<HTMLButtonElement>('.advice-suggestion button')?.disabled, true);
});

test('Query webview: declined feedback re-arms the button', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'S\n', suggestions: [SUGGESTION] }),
  }));
  await el.updateComplete;

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'query.adviseFeedback', statement: SUGGESTION.statement, outcome: 'declined' },
  }));
  await el.updateComplete;
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.advice-suggestion button');
  assert.ok(button);
  assert.equal(button.disabled, false, 'declined re-arms');
  assert.match(button.textContent ?? '', /Create index/);
});

test('Query webview: a fresh result resets the advisory state', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'S\n', suggestions: [SUGGESTION] }),
  }));
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'query.adviseFeedback', statement: SUGGESTION.statement, outcome: 'created' },
  }));
  await el.updateComplete;

  // New ADVISE run → the card re-renders from scratch with armed buttons.
  window.dispatchEvent(new MessageEvent('message', {
    data: resultMessage({ statement: 'S\n', suggestions: [SUGGESTION] }),
  }));
  await el.updateComplete;
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.advice-suggestion button');
  assert.ok(button);
  assert.match(button.textContent ?? '', /Create index/);
  assert.equal(el.shadowRoot!.textContent?.includes('Index created'), false);
});
