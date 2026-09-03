import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** Recorded webview→host traffic. The stub must exist before the element
 *  module runs — `messaging.ts` calls acquireVsCodeApi() at import time
 *  and holds the result. */
const posted: any[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

/** jsdom cannot host CodeMirror's EditorView without extra globals (see
 *  json-viewer.test.ts, which runs the real editor). The Query Editor's
 *  contract with <json-viewer> is property bindings and CustomEvents, so a
 *  no-op setupView keeps these tests on that contract. Precedent:
 *  inspector-query-panes.test.ts. */
const { JsonViewer } = await import('../../../webview-ui/shared/json-viewer.js');
(JsonViewer.prototype as unknown as { setupView: () => void }).setupView = () => {};

// The element's click-away handler does `t instanceof Element`; the shared
// setup exposes HTMLElement but not Element. Local stub only.
(globalThis as any).Element ??= (globalThis as any).window.Element;

await import('../../../webview-ui/query/query-element.js');

/**
 * Query Editor behaviour around the ADVISE card (which lives in
 * query-element.advise.test.ts): running, view switching, error handling,
 * truncation, pagination, row selection/context-menu/export, the settings
 * cog, the mode picker, editor↔host text sync, and the JSON document
 * memoization.
 */

interface El extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-query-editor></ditto-query-editor>`, host);
  const el = host.querySelector('ditto-query-editor') as unknown as El;
  await el.updateComplete;
  return el;
}

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function lastPosted(type: string): any {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i]?.type === type) { return posted[i]; }
  }
  return undefined;
}

function countPosted(type: string): number {
  return posted.filter(m => m?.type === type).length;
}

function rows(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ _id: `id-${i}`, n: i }));
}

function resultMessage(n: number, over: Record<string, unknown> = {}): unknown {
  return {
    type: 'query.result',
    rows: rows(n),
    columns: ['_id', 'n'],
    durationMs: 5,
    metadata: { dql: 'SELECT * FROM c', durationMs: 5, resultCount: n, explain: '', timestamp: 0 },
    ...over,
  };
}

function textarea(el: El): HTMLTextAreaElement {
  return el.shadowRoot!.querySelector('textarea')!;
}

function runButton(el: El): HTMLButtonElement {
  return el.shadowRoot!.querySelector('button.run')!;
}

function type(el: El, value: string): void {
  const ta = textarea(el);
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleButton(el: El, label: string): HTMLButtonElement | undefined {
  return [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.view-toggle button')]
    .find(b => b.textContent === label);
}

/** Typed child lookup inside the element's shadow root. */
function child<T = any>(el: El, sel: string): T {
  return el.shadowRoot!.querySelector(sel) as T;
}

/** Send a result and switch to the table view. */
async function resultInTableView(el: El, n: number, over: Record<string, unknown> = {}): Promise<void> {
  fromHost(resultMessage(n, over));
  await el.updateComplete;
  toggleButton(el, 'Table')!.click();
  await el.updateComplete;
}

// ─── Running ────────────────────────────────────────────────────

test('QueryEditor: starts idle with Run disabled and an invitation', async t => {
  const el = await mount(t);
  assert.match(el.shadowRoot!.textContent ?? '', /Run a query to see results\./);
  assert.equal(runButton(el).disabled, true, 'blank query → Run disabled');
  assert.equal(el.shadowRoot!.querySelector('.results-header'), null, 'no results chrome yet');
  assert.equal(el.shadowRoot!.querySelector('.pagination'), null);
});

test('QueryEditor: typing debounces the title sync and enables Run', async t => {
  const el = await mount(t);
  posted.length = 0;

  type(el, 'SELECT * FROM cars');
  await el.updateComplete;
  assert.equal(runButton(el).disabled, false);
  assert.equal(countPosted('query.textChanged'), 0, 'no immediate post — debounced');

  type(el, 'SELECT * FROM cars LIMIT 5');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(countPosted('query.textChanged'), 1, 'rapid edits coalesce to one post');
  assert.equal(lastPosted('query.textChanged').text, 'SELECT * FROM cars LIMIT 5',
    'and the post carries the latest text');
});

test('QueryEditor: Cmd/Ctrl+Enter runs; a bare Enter does not; running twice is a no-op', async t => {
  const el = await mount(t);
  posted.length = 0;
  type(el, 'SELECT 1');
  await el.updateComplete;

  textarea(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(countPosted('query.run'), 0, 'no modifier → no run');

  textarea(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.run'), { type: 'query.run', query: 'SELECT 1', mode: 'local' });
  assert.match(runButton(el).textContent ?? '', /Running…/);
  assert.equal(runButton(el).disabled, true);
  assert.match(el.shadowRoot!.textContent ?? '', /Running…/, 'running indicator in the header');

  // A second run while one is in flight must not double-post.
  textarea(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(countPosted('query.run'), 1, 'the running guard swallows the re-run');
});

test('QueryEditor: whitespace-only queries never run', async t => {
  const el = await mount(t);
  type(el, '   \n  ');
  await el.updateComplete;
  assert.equal(runButton(el).disabled, true, 'trimmed-empty stays disabled');

  posted.length = 0;
  textarea(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  assert.equal(countPosted('query.run'), 0, 'the keyboard path has the same guard');
});

test('QueryEditor: a successful result shows the meta line with plural and singular forms', async t => {
  const el = await mount(t);
  type(el, 'SELECT * FROM cars');
  await el.updateComplete;
  runButton(el).click();
  fromHost(resultMessage(2));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /2 rows · 5 ms/);

  fromHost(resultMessage(1));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /1 row · 5 ms/, 'singular');
});

test('QueryEditor: a truncated result warns and a full result clears the warning', async t => {
  const el = await mount(t);
  fromHost(resultMessage(10_000, {
    metadata: { dql: 'SELECT * FROM big', durationMs: 42, resultCount: 10_000, truncated: true, totalResultCount: 21_344 },
  }));
  await el.updateComplete;
  const warning = el.shadowRoot!.querySelector('.truncation-warning');
  assert.ok(warning);
  assert.match(warning.textContent ?? '', /showing first 10,000 of 21,344 rows — add a LIMIT clause/);

  fromHost(resultMessage(2));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.truncation-warning'), null, 'no cap → no warning');
});

test('QueryEditor: query.error renders a banner, Escape dismisses it, the next result clears it', async t => {
  const el = await mount(t);
  fromHost({ type: 'query.error', message: 'syntax error near SELCT' });
  await el.updateComplete;
  const banner = el.shadowRoot!.querySelector('.error-banner');
  assert.ok(banner);
  assert.match(banner.textContent ?? '', /Query failed/);
  assert.match(banner.textContent ?? '', /syntax error near SELCT/);
  assert.equal(el.shadowRoot!.querySelector('.results-header'), null, 'error state has no results chrome');

  textarea(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.error-banner'), null, 'Escape clears the banner');

  // A fresh error, then a result: the result wins and rows are back.
  fromHost({ type: 'query.error', message: 'boom again' });
  await el.updateComplete;
  fromHost(resultMessage(3));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.error-banner'), null);
  assert.match(el.shadowRoot!.textContent ?? '', /3 rows · 5 ms/);
});

test('QueryEditor: an error after a result empties the rows', async t => {
  const el = await mount(t);
  await resultInTableView(el, 2);
  assert.ok(el.shadowRoot!.querySelector('ditto-result-table'));

  fromHost({ type: 'query.error', message: 'connection lost' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('ditto-result-table'), null);
  assert.match(el.shadowRoot!.textContent ?? '', /connection lost/);
});

test('QueryEditor: query.setText fills the editor and syncs the host without a debounce', async t => {
  const el = await mount(t);
  posted.length = 0;
  fromHost({ type: 'query.setText', text: 'SELECT * FROM loaded' });
  await el.updateComplete;
  assert.equal(textarea(el).value, 'SELECT * FROM loaded');
  assert.deepEqual(posted, [{ type: 'query.textChanged', text: 'SELECT * FROM loaded' }],
    'immediate — the tab title must follow a deliberate load');
});

// ─── Mode picker ────────────────────────────────────────────────

test('QueryEditor: the mode picker appears with multiple modes and the choice rides on run', async t => {
  const el = await mount(t);
  assert.equal(el.shadowRoot!.querySelector('.top-toolbar select'), null, 'single mode → no picker');

  fromHost({ type: 'query.modeInit', availableModes: ['local', 'http'] });
  await el.updateComplete;
  const select = el.shadowRoot!.querySelector('select')!;
  assert.ok(select, 'two modes → picker');
  assert.deepEqual([...select.querySelectorAll('option')].map(o => o.textContent), ['Local', 'HTTP']);

  type(el, 'SELECT 1');
  select.value = 'http';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  posted.length = 0;
  runButton(el).click();
  assert.equal(lastPosted('query.run').mode, 'http');

  // Let the run finish so Run re-arms, then have the host re-push without
  // http (config changed): the selection pins back to a valid mode and the
  // picker disappears.
  fromHost(resultMessage(1));
  await el.updateComplete;
  fromHost({ type: 'query.modeInit', availableModes: ['local'] });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.top-toolbar select'), null);
  runButton(el).click();
  assert.equal(lastPosted('query.run').mode, 'local', 'pinned back to local');

  // An empty mode list is defensive — falls back to local, still no picker.
  fromHost({ type: 'query.modeInit', availableModes: [] });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.top-toolbar select'), null);
});

// ─── Favorite + settings cog ────────────────────────────────────

test('QueryEditor: Favorite posts the current query and is disabled when blank', async t => {
  const el = await mount(t);
  const star = el.shadowRoot!.querySelector<HTMLButtonElement>('button.star')!;
  assert.equal(star.disabled, true);

  type(el, 'SELECT * FROM fav');
  await el.updateComplete;
  posted.length = 0;
  star.click();
  assert.deepEqual(posted, [{ type: 'query.starCurrent', query: 'SELECT * FROM fav' }]);
});

test('QueryEditor: the settings cog opens a popover whose toggles post query.setSetting', async t => {
  const el = await mount(t);
  const cog = el.shadowRoot!.querySelector<HTMLButtonElement>('button.settings-cog')!;
  assert.equal(cog.getAttribute('aria-expanded'), 'false');

  posted.length = 0;
  cog.click();
  await el.updateComplete;
  const popover = el.shadowRoot!.querySelector('.settings-popover');
  assert.ok(popover, 'popover opens');
  assert.equal(cog.getAttribute('aria-expanded'), 'true');
  assert.match(popover.textContent ?? '', /Capture profiling data/);
  assert.match(popover.textContent ?? '', /Capture query metrics/);

  const metricsToggle = [...popover.querySelectorAll('label.row')].map((l: any) => ({
    label: l.textContent.trim(), input: l.querySelector('input') as HTMLInputElement,
  })).find(r => /metrics/.test(r.label))!;
  assert.equal(metricsToggle.input.checked, true, 'defaults optimistic-on');
  metricsToggle.input.checked = false;
  metricsToggle.input.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.setSetting'), { type: 'query.setSetting', key: 'collectMetrics', value: false });

  const profilingToggle = [...popover.querySelectorAll('label.row')].map((l: any) => ({
    label: l.textContent.trim(), input: l.querySelector('input') as HTMLInputElement,
  })).find(r => /profiling/.test(r.label))!;
  profilingToggle.input.checked = false;
  profilingToggle.input.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.setSetting'), { type: 'query.setSetting', key: 'collectProfiling', value: false });

  // A click inside the popover does not close it; a document click does.
  popover.querySelector('.hint')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.settings-popover'), 'inside clicks are contained');

  document.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.settings-popover'), null, 'click-away closes');

  cog.click();
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.settings-popover'));
  cog.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.settings-popover'), null, 'the cog toggles closed too');
});

test('QueryEditor: a host settings push hides the Profile toggle and bails out of the profile view', async t => {
  const el = await mount(t);
  fromHost(resultMessage(1));
  await el.updateComplete;

  toggleButton(el, 'Profile')!.click();
  await el.updateComplete;
  const viewer = child(el, 'ditto-profile-viewer');
  assert.ok(viewer, 'profile viewer mounted');
  assert.equal(viewer.lastQueryText, '', 'no run yet — nothing executed');
  assert.equal(viewer.mode, 'local');

  fromHost({ type: 'query.settings', collectProfiling: false, collectMetrics: true });
  await el.updateComplete;
  assert.equal(toggleButton(el, 'Profile'), undefined, 'Profile toggle gone');
  assert.equal(el.shadowRoot!.querySelector('ditto-profile-viewer'), null, 'viewer unmounted');
  assert.ok(el.shadowRoot!.querySelector('json-viewer'), 'fell back to the JSON view');
  assert.ok(toggleButton(el, 'JSON')!.classList.contains('active'));
});

test('QueryEditor: a profiling-off push while NOT on the profile view leaves the view alone', async t => {
  const el = await mount(t);
  await resultInTableView(el, 1);
  fromHost({ type: 'query.settings', collectProfiling: false, collectMetrics: true });
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('ditto-result-table'), 'still on the table view');
  assert.equal(toggleButton(el, 'Profile'), undefined);
});

test('QueryEditor: a captured profile is forwarded to the profile viewer', async t => {
  const el = await mount(t);
  const profile = { query: 'SELECT * FROM cars', plan: { indexesUsed: ['ix'] } };
  fromHost(resultMessage(1, { metadata: { dql: 'SELECT * FROM cars', durationMs: 5, resultCount: 1, profile } }));
  await el.updateComplete;

  toggleButton(el, 'Profile')!.click();
  await el.updateComplete;
  const viewer = child(el, 'ditto-profile-viewer');
  assert.deepEqual(viewer.profile, profile);
});

test('QueryEditor: the profile viewer receives the query that was actually run', async t => {
  const el = await mount(t);
  type(el, 'SELECT * FROM cars LIMIT 5');
  await el.updateComplete;
  runButton(el).click();
  type(el, ' -- edited after the run');
  fromHost(resultMessage(1));
  await el.updateComplete;

  toggleButton(el, 'Profile')!.click();
  await el.updateComplete;
  const viewer = child(el, 'ditto-profile-viewer');
  assert.equal(viewer.lastQueryText, 'SELECT * FROM cars LIMIT 5',
    'the executed statement, not the current editor contents');
});

// ─── View switching + JSON document ─────────────────────────────

test('QueryEditor: the JSON view hands the current page to the viewer and memoizes the document', async t => {
  const el = await mount(t);
  fromHost(resultMessage(30));
  await el.updateComplete;

  const viewer = child(el, 'json-viewer');
  assert.ok(viewer, 'json view is the default');
  const doc1 = (el as any).buildJsonDoc() as { doc: string; ranges: { from: number; to: number }[] };
  assert.equal(viewer.value, doc1.doc);
  assert.equal(doc1.ranges.length, 10, 'one range per row ON THE PAGE (pageSize clamped to 10 for 30 rows)');
  assert.match(doc1.doc, /^\[\n {2}\{/, 'array with indented items');

  // Memoized on rows identity + page + pageSize: a re-render (typing)
  // must not recompute.
  type(el, 'SELECT * FROM cars -- more typing');
  await el.updateComplete;
  const doc2 = (el as any).buildJsonDoc();
  assert.equal(doc2, doc1, 'same cache entry after an unrelated render');

  // Page change busts the cache and re-slices.
  const next = [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button.page-nav')]
    .find(b => b.title === 'Next page')!;
  next.click();
  await el.updateComplete;
  const doc3 = (el as any).buildJsonDoc();
  assert.notEqual(doc3, doc1);
  assert.equal(child(el, 'json-viewer').value, doc3.doc);
  assert.match(doc3.doc, /id-10/, 'page 2 starts at row 10');
});

test('QueryEditor: an empty result shows the empty states per view', async t => {
  const el = await mount(t);
  fromHost(resultMessage(0));
  await el.updateComplete;
  const viewer = child(el, 'json-viewer');
  assert.equal(viewer.value, '[]', 'empty page serialises as an empty array');
  assert.deepEqual(viewer.ranges, []);
  assert.equal(el.shadowRoot!.querySelector('.pagination'), null, 'no pagination for zero rows');

  toggleButton(el, 'Table')!.click();
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Query returned no rows\./);
});

// ─── Selection + context menu ───────────────────────────────────

test('QueryEditor: table row click selects with a compact rowJson; double-click activates', async t => {
  const el = await mount(t);
  await resultInTableView(el, 2);
  posted.length = 0;

  const table = child(el, 'ditto-result-table');
  assert.deepEqual(table.columns, ['_id', 'n']);
  const trs = table.shadowRoot.querySelectorAll('tbody tr');
  (trs[1] as HTMLElement).click();
  await el.updateComplete;

  assert.deepEqual(lastPosted('query.rowSelected'), {
    type: 'query.rowSelected',
    rowJson: JSON.stringify({ _id: 'id-1', n: 1 }),
  });
  assert.equal(trs[1]!.classList.contains('selected'), true, 'selection paints back through selectedRowIndex');

  trs[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.rowActivated'), {
    type: 'query.rowActivated',
    rowJson: JSON.stringify({ _id: 'id-1', n: 1 }),
  });
});

test('QueryEditor: selection on a later page resolves to the absolute row', async t => {
  const el = await mount(t);
  await resultInTableView(el, 30); // pageSize clamps to 10
  posted.length = 0;

  [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button.page-nav')]
    .find(b => b.title === 'Next page')!.click();
  await el.updateComplete;
  assert.equal(countPosted('query.rowSelected'), 1, 'page change clears the host-side selection…');
  assert.equal(lastPosted('query.rowSelected').rowJson, null, '…with an explicit null');

  const table = child(el, 'ditto-result-table');
  (table.shadowRoot.querySelector('tbody tr') as HTMLElement).click();
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.rowSelected'), {
    type: 'query.rowSelected',
    rowJson: JSON.stringify({ _id: 'id-10', n: 10 }),
  }, 'page-local index 0 + pageOffset 10 → absolute row 10');
});

test('QueryEditor: right-click opens the context menu at the cursor and both actions post the row', async t => {
  const el = await mount(t);
  await resultInTableView(el, 2);
  posted.length = 0;

  const table = child(el, 'ditto-result-table');
  table.shadowRoot.querySelector('tbody tr:nth-child(2)')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 44, clientY: 55 }));
  await el.updateComplete;

  const menu = el.shadowRoot!.querySelector('.ctx-menu') as HTMLElement;
  assert.ok(menu, 'menu rendered');
  assert.match(menu.style.left ?? '', /44px/);
  assert.match(menu.style.top ?? '', /55px/);
  assert.equal(lastPosted('query.rowSelected').rowJson, JSON.stringify({ _id: 'id-1', n: 1 }),
    'right-click also selects the row');

  const items = [...menu.querySelectorAll<HTMLElement>('.ctx-menu-item')];
  assert.deepEqual(items.map(i => i.textContent), ['Add Attachment…', 'Delete Attachment…']);
  items[0]!.click();
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.addAttachment'), {
    type: 'query.addAttachment',
    rowJson: JSON.stringify({ _id: 'id-1', n: 1 }),
  });
  assert.equal(el.shadowRoot!.querySelector('.ctx-menu'), null, 'menu closes after the action');

  // Reopen and take the destructive path.
  table.shadowRoot.querySelector('tbody tr:nth-child(1)')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 1, clientY: 2 }));
  await el.updateComplete;
  [...el.shadowRoot!.querySelectorAll<HTMLElement>('.ctx-menu-item')]
    .find(i => i.textContent === 'Delete Attachment…')!.click();
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.deleteAttachment'), {
    type: 'query.deleteAttachment',
    rowJson: JSON.stringify({ _id: 'id-0', n: 0 }),
  });
});

test('QueryEditor: a document click closes the context menu without an action', async t => {
  const el = await mount(t);
  await resultInTableView(el, 1);

  const table = child(el, 'ditto-result-table');
  table.shadowRoot.querySelector('tbody tr')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.ctx-menu'));

  posted.length = 0;
  document.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.ctx-menu'), null);
  assert.equal(countPosted('query.addAttachment'), 0, 'no action fired');

  // A document-level contextmenu (a right-click anywhere else) closes it too.
  table.shadowRoot.querySelector('tbody tr')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 5, clientY: 5 }));
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.ctx-menu'), 'menu reopened');
  document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.ctx-menu'), null);
});

test('QueryEditor: JSON-viewer events select, activate, and gate the context menu on a selection', async t => {
  const el = await mount(t);
  fromHost(resultMessage(2));
  await el.updateComplete;
  posted.length = 0;

  const viewer = child(el, 'json-viewer');
  // No selection yet: right-click on the JSON doc is a no-op.
  viewer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true }));
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.ctx-menu'), null, 'no selected row → no menu');

  viewer.dispatchEvent(new CustomEvent('documentSelected', { detail: { index: 1 }, bubbles: true, composed: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.rowSelected'), {
    type: 'query.rowSelected',
    rowJson: JSON.stringify({ _id: 'id-1', n: 1 }),
  });

  viewer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 7, clientY: 9 }));
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.ctx-menu'), 'with a selection the JSON right-click opens the menu');

  viewer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.deepEqual(lastPosted('query.rowActivated'), {
    type: 'query.rowActivated',
    rowJson: JSON.stringify({ _id: 'id-1', n: 1 }),
  });
  assert.equal(viewer.selectedIndex, 1, 'the page-local selection is bound back into the viewer');
});

test('QueryEditor: double-click without a selection activates nothing', async t => {
  const el = await mount(t);
  fromHost(resultMessage(2));
  await el.updateComplete;
  posted.length = 0;

  const viewer = child(el, 'json-viewer');
  viewer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(countPosted('query.rowActivated'), 0, 'no selected row → no activation');
});

test('QueryEditor: a table selection translates to the JSON viewer on view switch', async t => {
  const el = await mount(t);
  await resultInTableView(el, 3);

  const table = child(el, 'ditto-result-table');
  (table.shadowRoot.querySelectorAll('tbody tr')[2] as HTMLElement).click();
  await el.updateComplete;

  toggleButton(el, 'JSON')!.click();
  await el.updateComplete;
  const viewer = child(el, 'json-viewer');
  assert.equal(viewer.selectedIndex, 2, 'absolute selection maps back to the page-local JSON index');
});

test('QueryEditor: context-menu actions no-op when no menu is open', async t => {
  const el = await mount(t);
  await resultInTableView(el, 2);
  posted.length = 0;

  // The menu is only rendered open over a valid row; the in-code guards are
  // the second line of defence against a stale click handler.
  (el as any).contextAdd();
  (el as any).contextDelete();
  await el.updateComplete;
  assert.equal(countPosted('query.addAttachment'), 0);
  assert.equal(countPosted('query.deleteAttachment'), 0);

  // A menu state whose row index no longer resolves (rows replaced under
  // it) still posts nothing.
  (el as any).contextMenu = { x: 0, y: 0, rowAbsIndex: 99 };
  (el as any).contextAdd();
  (el as any).contextMenu = { x: 0, y: 0, rowAbsIndex: 99 };
  (el as any).contextDelete();
  await el.updateComplete;
  assert.equal(countPosted('query.addAttachment'), 0);
  assert.equal(countPosted('query.deleteAttachment'), 0);
  assert.equal((el as any).contextMenu, null, 'the stale menu state is cleared either way');
});

// ─── Pagination ─────────────────────────────────────────────────

test('QueryEditor: page sizes scale with the result and the size picker re-anchors the page', async t => {
  const el = await mount(t);
  fromHost(resultMessage(30));
  await el.updateComplete;

  const pos = () => el.shadowRoot!.querySelector('.pagination-pos')!.textContent;
  const sizeSelect = () => el.shadowRoot!.querySelector<HTMLSelectElement>('.pagination-size select')!;
  const nav = (title: string) => [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('button.page-nav')]
    .find(b => b.title === title)!;

  assert.match(el.shadowRoot!.querySelector('.pagination-total')!.textContent ?? '', /30 total/);
  assert.deepEqual([...sizeSelect().querySelectorAll('option')].map(o => o.value), ['10', '25', '50'],
    'every size up to the first that fits 30 rows');
  assert.equal(sizeSelect().value, '10', 'default pageSize 100 is invalid here → clamped to the first offered');
  assert.equal(pos(), '1 of 3');
  assert.equal(nav('Previous page').disabled, true);
  assert.equal(nav('Next page').disabled, false);

  nav('Next page').click();
  await el.updateComplete;
  nav('Next page').click();
  await el.updateComplete;
  assert.equal(pos(), '3 of 3');
  assert.equal(nav('Next page').disabled, true, 'last page clamps the forward nav');

  // Re-anchor: page 3 covers rows 20-29; size 25 puts row 20 on page 1.
  posted.length = 0;
  sizeSelect().value = '25';
  sizeSelect().dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.equal(pos(), '1 of 2');
  assert.equal(lastPosted('query.rowSelected').rowJson, null, 'size change drops the selection');

  // Re-selecting the current size is a no-op.
  posted.length = 0;
  sizeSelect().value = '25';
  sizeSelect().dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.equal(countPosted('query.rowSelected'), 0);

  // A fresh result snaps back to page 1 and re-clamps the size list.
  fromHost(resultMessage(3));
  await el.updateComplete;
  assert.deepEqual([...sizeSelect().querySelectorAll('option')].map(o => o.value), ['10'],
    'three rows offer only the smallest page');
  assert.equal(pos(), '1 of 1');
});

test('QueryEditor: gotoPage clamps out-of-range targets', async t => {
  const el = await mount(t);
  fromHost(resultMessage(30));
  await el.updateComplete;
  const pos = () => el.shadowRoot!.querySelector('.pagination-pos')!.textContent;

  posted.length = 0;
  (el as any).gotoPage(99);
  await el.updateComplete;
  assert.equal(pos(), '3 of 3', 'beyond the end clamps to the last page');
  (el as any).gotoPage(0);
  await el.updateComplete;
  assert.equal(pos(), '1 of 3', 'below the start clamps to the first page');
  (el as any).gotoPage(1);
  await el.updateComplete;
  assert.equal(countPosted('query.rowSelected'), 2, 'one post per real page change; the same-page call was a no-op');
});

// ─── Export ─────────────────────────────────────────────────────

test('QueryEditor: Export ships the full result set and the host acks clear the busy state', async t => {
  const el = await mount(t);
  fromHost(resultMessage(30));
  await el.updateComplete; // pageSize 10, page 1 — export must still carry all 30
  posted.length = 0;

  const exportBtn = el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!;
  exportBtn.click();
  await el.updateComplete;
  assert.match(exportBtn.textContent ?? '', /Exporting…/);
  assert.equal(exportBtn.disabled, true);

  const sent = lastPosted('query.exportRows');
  assert.ok(sent, 'export posted');
  assert.equal(sent.rowCount, 30);
  const parsed = JSON.parse(sent.json) as unknown[];
  assert.equal(parsed.length, 30, 'the FULL result set, not the current page');

  fromHost({ type: 'query.exportDone', rowCount: 30, path: '/tmp/out.json' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.textContent ?? '', /Export/);
  assert.equal(el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.disabled, false);

  // Cancelled and errored exports clear the flag the same way.
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.click();
  await el.updateComplete;
  fromHost({ type: 'query.exportCancelled' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.disabled, false);

  el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.click();
  await el.updateComplete;
  fromHost({ type: 'query.exportError', message: 'disk full' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.disabled, false);
});

test('QueryEditor: an unserialisable result set fails the export in-page instead of wedging the button', async t => {
  const el = await mount(t);
  // A BigInt cell renders fine in the table (primitive stringification) but
  // makes JSON.stringify throw — exactly the freak payload the export
  // try/catch exists for. MessageEvent carries it without a structured
  // clone. Switch to the table view first: the JSON view's document builder
  // would (correctly) throw on the same value.
  (el as any).view = 'table';
  await resultInTableView(el, 0, { rows: [{ _id: 'big', n: 10n }], columns: ['_id', 'n'] });
  assert.match(el.shadowRoot!.textContent ?? '', /10/, 'the bigint cell rendered');

  posted.length = 0;
  el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.click();
  await el.updateComplete;
  await new Promise(r => setTimeout(r, 0));

  assert.equal(countPosted('query.exportRows'), 0, 'nothing was posted');
  assert.match(el.shadowRoot!.textContent ?? '', /Could not serialise results for export: /);
  assert.equal(el.shadowRoot!.querySelector<HTMLButtonElement>('button.export-btn')!.disabled, false,
    'the button re-arms after the failure');
});

// ─── Lifecycle ──────────────────────────────────────────────────

test('QueryEditor: ignores host messages while detached and resumes on re-attach', async t => {
  const el = await mount(t);
  const host = el.parentElement!;
  fromHost(resultMessage(1));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /1 row/);

  host.remove();
  await el.updateComplete;
  fromHost(resultMessage(5));
  await new Promise(r => setTimeout(r, 0));
  assert.match(el.shadowRoot!.textContent ?? '', /1 row/, 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  fromHost(resultMessage(5));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /5 rows/, 'resumed after re-attach');
});

test('QueryEditor: detaching with a pending title debounce cancels it', async t => {
  const el = await mount(t);
  const host = el.parentElement!;
  posted.length = 0;

  type(el, 'SELECT 1');
  host.remove();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(countPosted('query.textChanged'), 0, 'the pending debounce was cleared on disconnect');
});
