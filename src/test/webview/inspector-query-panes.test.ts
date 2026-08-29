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

/** jsdom cannot host CodeMirror's EditorView (it measures against layout
 *  surfaces jsdom doesn't implement, and setupView throws on construction).
 *  Stubbing just the editor mount keeps the <json-viewer> element — and the
 *  property bindings the panes pass to it — fully renderable. */
const { JsonViewer } = await import('../../../webview-ui/shared/json-viewer.js');
(JsonViewer.prototype as unknown as { setupView: () => void }).setupView = () => {};

await import('../../../webview-ui/inspector/query-json-element.js');
await import('../../../webview-ui/inspector/query-history-element.js');
await import('../../../webview-ui/inspector/query-favorites-element.js');
await import('../../../webview-ui/inspector/query-metrics-element.js');

/**
 * The Inspector's query panes: history and favorites lists (row click loads
 * the query into the editor, hover actions post their own messages), the
 * JSON tab (pretty-prints the selected row and hands it to the attachment
 * viewer), and the Metrics tab (badges, EXPLAIN, and the LIMIT-clause tip).
 */

interface HistoryEntry { id: string; query: string; timestamp?: number; }

interface MetricsMetadata {
  durationMs?: number;
  resultCount?: number;
  usedIndex?: boolean;
  explain?: string;
  timestamp?: number;
  dql?: string;
  location?: 'local' | 'http';
}

interface AnyElement extends HTMLElement {
  updateComplete: Promise<unknown>;
}

interface JsonPane extends AnyElement { json: string | undefined; }
interface ListPane extends AnyElement { entries: HistoryEntry[]; }
interface MetricsPane extends AnyElement {
  metadata: MetricsMetadata | undefined;
  hideLimitHint: boolean;
}

function mountHost(t: { after(fn: () => void): void }): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  return host;
}

/** Indexing under noUncheckedIndexedAccess, with a built-in existence check. */
function at<T>(list: ArrayLike<T>, i: number): T {
  const v = list[i];
  assert.ok(v !== undefined, `expected index ${i} to exist`);
  return v;
}

async function mountJson(t: { after(fn: () => void): void }): Promise<JsonPane> {
  const host = mountHost(t);
  render(html`<query-json-element></query-json-element>`, host);
  const el = host.querySelector('query-json-element') as unknown as JsonPane;
  await el.updateComplete;
  return el;
}

async function mountHistory(t: { after(fn: () => void): void }): Promise<ListPane> {
  const host = mountHost(t);
  render(html`<query-history-element></query-history-element>`, host);
  const el = host.querySelector('query-history-element') as unknown as ListPane;
  await el.updateComplete;
  return el;
}

async function mountFavorites(t: { after(fn: () => void): void }): Promise<ListPane> {
  const host = mountHost(t);
  render(html`<query-favorites-element></query-favorites-element>`, host);
  const el = host.querySelector('query-favorites-element') as unknown as ListPane;
  await el.updateComplete;
  return el;
}

async function mountMetrics(t: { after(fn: () => void): void }): Promise<MetricsPane> {
  const host = mountHost(t);
  render(html`<query-metrics-element></query-metrics-element>`, host);
  const el = host.querySelector('query-metrics-element') as unknown as MetricsPane;
  await el.updateComplete;
  return el;
}

// ─── query-history-element ────────────────────────────────────

test('QueryHistory: empty state when there are no entries', async t => {
  const el = await mountHistory(t);
  assert.match(el.shadowRoot!.textContent ?? '', /No queries have been run yet\./);
});

test('QueryHistory: rows render and clicking one loads it into the editor', async t => {
  const el = await mountHistory(t);
  el.entries = [
    { id: 'h1', query: 'SELECT * FROM a' },
    { id: 'h2', query: 'SELECT * FROM b' },
  ];
  await el.updateComplete;

  const rows = el.shadowRoot!.querySelectorAll<HTMLElement>('.row');
  assert.equal(rows.length, 2);
  assert.match(at(rows, 1).textContent ?? '', /SELECT \* FROM b/);

  postedToHost.length = 0;
  at(rows, 1).click();
  assert.deepEqual(postedToHost, [{ type: 'inspector.loadQueryInEditor', query: 'SELECT * FROM b' }]);
});

test('QueryHistory: star adds to favorites without triggering the row load', async t => {
  const el = await mountHistory(t);
  el.entries = [{ id: 'h1', query: 'SELECT 1' }];
  await el.updateComplete;

  postedToHost.length = 0;
  el.shadowRoot!.querySelector<HTMLButtonElement>('button[title="Add to Favorites"]')!.click();
  assert.deepEqual(postedToHost, [{ type: 'inspector.addFavorite', query: 'SELECT 1' }],
    'stopPropagation keeps the row click (loadQueryInEditor) from firing');
});

test('QueryHistory: trash deletes the entry without triggering the row load', async t => {
  const el = await mountHistory(t);
  el.entries = [{ id: 'h1', query: 'SELECT 1' }];
  await el.updateComplete;

  postedToHost.length = 0;
  el.shadowRoot!.querySelector<HTMLButtonElement>('button[title="Delete"]')!.click();
  assert.deepEqual(postedToHost, [{ type: 'inspector.deleteHistoryEntry', id: 'h1' }],
    'stopPropagation keeps the row click (loadQueryInEditor) from firing');
});

// ─── query-favorites-element ──────────────────────────────────

test('QueryFavorites: empty state when there are no entries', async t => {
  const el = await mountFavorites(t);
  assert.match(el.shadowRoot!.textContent ?? '', /No favorite queries saved yet\./);
});

test('QueryFavorites: rows render and clicking one loads it into the editor', async t => {
  const el = await mountFavorites(t);
  el.entries = [
    { id: 'f1', query: 'SELECT * FROM fav' },
    { id: 'f2', query: 'SELECT count(*) FROM fav' },
  ];
  await el.updateComplete;

  const rows = el.shadowRoot!.querySelectorAll<HTMLElement>('.row');
  assert.equal(rows.length, 2);
  assert.match(at(rows, 0).textContent ?? '', /SELECT \* FROM fav/);

  postedToHost.length = 0;
  at(rows, 0).click();
  assert.deepEqual(postedToHost, [{ type: 'inspector.loadQueryInEditor', query: 'SELECT * FROM fav' }]);
});

test('QueryFavorites: close removes the favorite without triggering the row load', async t => {
  const el = await mountFavorites(t);
  el.entries = [{ id: 'f1', query: 'SELECT 1' }];
  await el.updateComplete;

  postedToHost.length = 0;
  el.shadowRoot!.querySelector<HTMLButtonElement>('button[title="Remove from Favorites"]')!.click();
  assert.deepEqual(postedToHost, [{ type: 'inspector.removeFavorite', id: 'f1' }],
    'stopPropagation keeps the row click (loadQueryInEditor) from firing');
});

// ─── query-json-element ───────────────────────────────────────

test('QueryJson: empty state until a row is selected', async t => {
  const el = await mountJson(t);
  assert.match(el.shadowRoot!.textContent ?? '', /Select a JSON result to view it here\./);
  assert.equal(el.shadowRoot!.querySelector('json-viewer'), null);
});

test('QueryJson: pretty-prints the row into the viewer and hands the raw row to the attachment viewer', async t => {
  const el = await mountJson(t);
  el.json = '{"b":2,"a":1}';
  await el.updateComplete;

  const viewer = el.shadowRoot!.querySelector('json-viewer') as unknown as { value: string };
  assert.ok(viewer, 'json-viewer rendered');
  assert.equal(viewer.value, JSON.stringify({ b: 2, a: 1 }, null, 2), 'row is re-serialised with indentation');

  const attachments = el.shadowRoot!.querySelector('attachment-viewer-element') as unknown as { json: string };
  assert.ok(attachments, 'attachment viewer rendered');
  assert.equal(attachments.json, '{"b":2,"a":1}', 'the raw row — not the pretty print — goes to attachment scanning');
});

test('QueryJson: unparseable JSON is passed through verbatim', async t => {
  const el = await mountJson(t);
  el.json = 'not json {';
  await el.updateComplete;

  const viewer = el.shadowRoot!.querySelector('json-viewer') as unknown as { value: string };
  assert.ok(viewer);
  assert.equal(viewer.value, 'not json {');
});

// ─── query-metrics-element ────────────────────────────────────

test('QueryMetrics: empty state until a query has run', async t => {
  const el = await mountMetrics(t);
  assert.match(el.shadowRoot!.textContent ?? '', /Run a query to see execution metrics\./);
});

test('QueryMetrics: renders DQL, badges, location and the EXPLAIN viewer', async t => {
  const el = await mountMetrics(t);
  el.metadata = {
    dql: 'SELECT * FROM cars LIMIT 5',
    durationMs: 12,
    resultCount: 3,
    usedIndex: true,
    explain: '{"plan":"index"}',
    timestamp: 1_700_000_000_000,
    location: 'http',
  };
  await el.updateComplete;

  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /Location/);
  assert.match(text, /HTTP/);
  assert.match(text, /SELECT \* FROM cars LIMIT 5/);

  const badges = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.badge')];
  assert.equal(badges.length, 4);
  assert.match(at(badges, 0).textContent ?? '', /Time: 12 ms/);
  assert.ok(at(badges, 0).classList.contains('t-ok'), 'fast query → green');
  assert.match(at(badges, 1).textContent ?? '', /Results: 3/);
  assert.match(at(badges, 2).textContent ?? '', /Index: ✓/);
  assert.ok(at(badges, 2).classList.contains('t-ok'));
  assert.match(at(badges, 3).textContent ?? '', /At: /);
  assert.doesNotMatch(at(badges, 3).textContent ?? '', /At: —/, 'a real timestamp is formatted');

  const explain = el.shadowRoot!.querySelector('json-viewer.explain-viewer') as unknown as { value: string };
  assert.ok(explain, 'EXPLAIN renders in the json viewer');
  assert.equal(explain.value, '{"plan":"index"}');

  assert.equal(el.shadowRoot!.querySelector('.tip'), null, 'LIMIT present → no tip');
});

test('QueryMetrics: badge tiers, missing fields and the local location label', async t => {
  const el = await mountMetrics(t);
  el.metadata = { durationMs: 200, usedIndex: false, location: 'local' };
  await el.updateComplete;

  let badges = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.badge')];
  assert.ok(at(badges, 0).classList.contains('t-warn'), '200 ms → orange');
  assert.match(at(badges, 0).textContent ?? '', /Time: 200 ms/);
  assert.match(at(badges, 1).textContent ?? '', /Results: —/, 'missing count renders a dash');
  assert.match(at(badges, 2).textContent ?? '', /Index: ✗/);
  assert.ok(at(badges, 2).classList.contains('t-warn'), 'no index → orange');
  assert.match(at(badges, 3).textContent ?? '', /At: —/, 'missing timestamp renders a dash');
  assert.match(el.shadowRoot!.textContent ?? '', /Local Database/);
  assert.match(el.shadowRoot!.textContent ?? '', /\(unavailable\)/, 'missing DQL');
  assert.match(el.shadowRoot!.textContent ?? '', /\(plan unavailable\)/, 'missing EXPLAIN');
  assert.equal(el.shadowRoot!.querySelector('json-viewer.explain-viewer'), null);

  el.metadata = { durationMs: 900 };
  await el.updateComplete;
  badges = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.badge')];
  assert.ok(at(badges, 0).classList.contains('t-bad'), '900 ms → red');
  assert.doesNotMatch(el.shadowRoot!.textContent ?? '', /Location/, 'no location row when unset');
});

test('QueryMetrics: a SELECT without LIMIT shows the tip; dismissing it posts to the host', async t => {
  const el = await mountMetrics(t);
  el.metadata = { dql: 'SELECT * FROM cars', durationMs: 5 };
  await el.updateComplete;

  const tip = el.shadowRoot!.querySelector('.tip')!;
  assert.ok(tip, 'tip shown for LIMIT-less SELECT');
  assert.match(tip.textContent ?? '', /no LIMIT clause/);

  postedToHost.length = 0;
  tip.querySelector<HTMLButtonElement>('.tip-dismiss')!.click();
  await el.updateComplete;
  assert.deepEqual(postedToHost, [{ type: 'inspector.dismissLimitHint' }]);
  assert.equal(el.hideLimitHint, true, 'optimistically suppressed locally');
  assert.equal(el.shadowRoot!.querySelector('.tip'), null, 'tip gone after dismiss');
});

test('QueryMetrics: the LIMIT tip respects the suppression preference and query shape', async t => {
  const el = await mountMetrics(t);

  // Preference from the host suppresses the tip even for a LIMIT-less SELECT.
  el.hideLimitHint = true;
  el.metadata = { dql: 'SELECT * FROM cars' };
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.tip'), null);

  el.hideLimitHint = false;
  el.metadata = { dql: '  select * from cars limit :n' };
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.tip'), null, 'parameterised LIMIT counts (case-insensitive)');

  el.metadata = { dql: 'INSERT INTO cars VALUES ({ "id": 1 })' };
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.tip'), null, 'non-SELECT never hints');

  el.metadata = { dql: 'SELECT * FROM cars LIMIT 100' };
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.tip'), null, 'bare numeric LIMIT counts');

  el.metadata = { dql: 'SELECT * FROM cars' };
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.tip'), 'LIMIT-less SELECT hints');
});
