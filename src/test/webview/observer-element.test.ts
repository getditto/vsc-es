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

/** CodeMirror (used by the shared json-viewer the detail pane embeds) needs
 *  MutationObserver as a global; setup.ts only copies the globals Lit itself
 *  needs, so provide the extra one here before any element mounts. */
(globalThis as any).MutationObserver = (globalThis as any).window.MutationObserver;

await import('../../../webview-ui/observer/observer-element.js');
await import('../../../webview-ui/observer/events-table-element.js');

import type { ObserverEvent } from '../../ditto/ObserverEventStore.js';

interface Panel extends HTMLElement {
  updateComplete: Promise<unknown>;
  events: ObserverEvent[];
  selectedEventId: string | null;
  active: boolean;
  observer: { id: string; name: string; query: string };
}

interface EventsTable extends HTMLElement {
  updateComplete: Promise<unknown>;
  events: ObserverEvent[];
  selectedEventId: string | null;
}

interface JsonViewer extends HTMLElement {
  value: string;
}

interface ResultTable extends HTMLElement {
  columns: string[];
}

/** Typed querySelector — custom tags aren't in HTMLElementTagNameMap, and the
 *  double assertion through `unknown` is the lint-clean narrowing idiom. */
function query<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector(selector) as unknown as T | null;
  assert.ok(el, `expected ${selector} to be rendered`);
  return el;
}

function evt(id: string, overrides: Partial<ObserverEvent> = {}): ObserverEvent {
  return {
    id,
    eventTimeISO: '2026-08-29T12:34:56.789Z',
    data: [{ _id: id, n: 1 }],
    totalRows: 1,
    insertions: [],
    updates: [],
    deletions: [],
    moves: [],
    ...overrides,
  };
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Panel }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-observer-panel></ditto-observer-panel>`, host);
  const el = host.querySelector('ditto-observer-panel') as unknown as Panel;
  await el.updateComplete;
  return { host, el };
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

/** Await the panel and every rendered child element, so shadow-DOM queries
 *  see the settled tree. */
async function settled(el: Panel): Promise<void> {
  await el.updateComplete;
  const kids = el.shadowRoot!.querySelectorAll('ditto-events-table, ditto-result-table, json-viewer');
  for (const k of kids) { await (k as unknown as Panel).updateComplete; }
}

function eventsTable(el: Panel): EventsTable {
  return el.shadowRoot!.querySelector('ditto-events-table') as unknown as EventsTable;
}

function toolbarButton(el: Panel): HTMLButtonElement {
  return el.shadowRoot!.querySelector('.toolbar button')!;
}

test('Observer: init sets title/query; inactive empty state prompts activation', async t => {
  const { el } = await mount(t);
  send({ type: 'observer.init', observer: { id: 'o1', name: 'Tasks watcher', query: 'SELECT * FROM tasks' } });
  await settled(el);

  assert.equal(el.observer.name, 'Tasks watcher');
  assert.match(el.shadowRoot!.querySelector('.toolbar .title')!.textContent, /Tasks watcher/);
  assert.match(el.shadowRoot!.querySelector('.toolbar .query')!.textContent, /SELECT \* FROM tasks/);
  assert.match(toolbarButton(el).textContent, /Activate/);
  assert.match(el.shadowRoot!.querySelector('.detail-pane .empty')!.textContent,
    /Activate the observer to start collecting events/);

  const before = posted.length;
  toolbarButton(el).click();
  assert.deepEqual(posted[before], { type: 'observer.activate' });
});

test('Observer: statusChanged flips to Stop button and waiting empty state', async t => {
  const { el } = await mount(t);
  send({ type: 'observer.statusChanged', active: true });
  await settled(el);

  assert.equal(el.active, true);
  assert.match(toolbarButton(el).textContent, /Stop/);
  assert.match(el.shadowRoot!.querySelector('.detail-pane .empty')!.textContent, /Waiting for events/);

  const before = posted.length;
  toolbarButton(el).click();
  assert.deepEqual(posted[before], { type: 'observer.stop' });
});

test('Observer: events append to the ring buffer and empty batches are ignored', async t => {
  const { el } = await mount(t);
  send({ type: 'observer.events', events: [evt('a'), evt('b')] });
  await settled(el);
  assert.equal(el.events.length, 2);

  send({ type: 'observer.events', events: [] });
  await settled(el);
  assert.equal(el.events.length, 2, 'empty batch must not touch the buffer');

  // The events table child received the rows.
  const table = eventsTable(el);
  assert.equal(table.shadowRoot!.querySelectorAll('tbody tr').length, 2);
});

test('Observer: ring buffer caps at 500 events, evicting the oldest', async t => {
  const { el } = await mount(t);
  const first = Array.from({ length: 300 }, (_, i) => evt(`f${i}`));
  const second = Array.from({ length: 300 }, (_, i) => evt(`s${i}`));
  send({ type: 'observer.events', events: first });
  await settled(el);
  send({ type: 'observer.events', events: second });
  await settled(el);

  assert.equal(el.events.length, 500);
  assert.equal(el.events[0]!.id, 'f100', 'oldest 100 of 600 merged events were evicted');
  assert.equal(el.events[499]!.id, 's299');
});

test('Observer: selecting an event posts eventSelected and renders the JSON detail', async t => {
  const { el } = await mount(t);
  send({
    type: 'observer.events',
    events: [
      evt('a', { data: [{ _id: 'alpha', n: 1 }] }),
      evt('b', { data: [{ _id: 'beta', n: 2 }] }),
    ],
  });
  await settled(el);

  const table = eventsTable(el);
  const rows = table.shadowRoot!.querySelectorAll('tbody tr');
  const before = posted.length;
  (rows[0] as HTMLElement).click();
  await settled(el);

  assert.equal(el.selectedEventId, 'a');
  assert.deepEqual(posted[before], { type: 'observer.eventSelected', eventId: 'a' });

  const viewer = query<JsonViewer>(el.shadowRoot!, 'json-viewer');
  assert.deepEqual(JSON.parse(viewer.value), [{ _id: 'alpha', n: 1 }]);

  // New batches re-render the pane (memoized detail path) without
  // disturbing the selection's data.
  send({ type: 'observer.events', events: [evt('c')] });
  await settled(el);
  assert.deepEqual(JSON.parse(viewer.value), [{ _id: 'alpha', n: 1 }]);

  // Re-selecting a different event swaps the detail payload…
  (table.shadowRoot!.querySelectorAll('tbody tr')[1] as HTMLElement).click();
  await settled(el);
  assert.equal(el.selectedEventId, 'b');
  assert.deepEqual(JSON.parse(viewer.value), [{ _id: 'beta', n: 2 }]);

  // …and re-selecting the original restores it (cache re-selection).
  (table.shadowRoot!.querySelectorAll('tbody tr')[0] as HTMLElement).click();
  await settled(el);
  assert.equal(el.selectedEventId, 'a');
  assert.deepEqual(JSON.parse(viewer.value), [{ _id: 'alpha', n: 1 }]);

  // Clicking the selected row toggles the selection off entirely.
  const beforeToggle = posted.length;
  (table.shadowRoot!.querySelectorAll('tbody tr')[0] as HTMLElement).click();
  await settled(el);
  assert.equal(el.selectedEventId, null);
  assert.deepEqual(posted[beforeToggle], { type: 'observer.eventSelected', eventId: null });
  assert.match(el.shadowRoot!.querySelector('.detail-pane .empty')!.textContent,
    /Select an event above to inspect its data/);
});

test('Observer: event filter narrows detail rows to inserted/updated indexes', async t => {
  const { el } = await mount(t);
  send({
    type: 'observer.events',
    events: [evt('a', {
      data: [{ _id: 'r0' }, { _id: 'r1' }, { _id: 'r2' }],
      totalRows: 3,
      insertions: [0, 2],
      updates: [1],
    })],
  });
  await settled(el);
  (eventsTable(el).shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);

  const viewer = () => query<JsonViewer>(el.shadowRoot!, 'json-viewer');
  assert.equal(JSON.parse(viewer().value).length, 3, 'items filter shows everything');

  const select = el.shadowRoot!.querySelector('.detail-toolbar select') as unknown as HTMLSelectElement;
  select.value = 'inserted';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settled(el);
  assert.deepEqual(JSON.parse(viewer().value).map((r: any) => r._id), ['r0', 'r2']);

  select.value = 'updated';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settled(el);
  assert.deepEqual(JSON.parse(viewer().value).map((r: any) => r._id), ['r1']);
});

test('Observer: host row cap surfaces a truncation banner', async t => {
  const { el } = await mount(t);
  send({
    type: 'observer.events',
    events: [evt('a', { data: [{ _id: 'r0' }, { _id: 'r1' }], totalRows: 5 })],
  });
  await settled(el);
  (eventsTable(el).shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);

  const banner = el.shadowRoot!.querySelector('.detail-body div')!;
  assert.match(banner.textContent, /showing first 2 of 5 rows/);
});

test('Observer: detail pane caps rendering at 1000 rows with a banner', async t => {
  const { el } = await mount(t);
  const data = Array.from({ length: 1100 }, (_, i) => ({ _id: `r${i}` }));
  send({ type: 'observer.events', events: [evt('a', { data, totalRows: 1100 })] });
  await settled(el);
  (eventsTable(el).shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);

  const banner = el.shadowRoot!.querySelector('.detail-body div')!;
  assert.match(banner.textContent, /showing first 1,000 of 1,100 rows/);
  const viewer = query<JsonViewer>(el.shadowRoot!, 'json-viewer');
  assert.equal(JSON.parse(viewer.value).length, 1000);
});

test('Observer: table detail view renders rows and posts rowSelected on click', async t => {
  const { el } = await mount(t);
  send({
    type: 'observer.events',
    events: [evt('a', { data: [{ _id: 'r0', zz: 1, aa: 2 }] })],
  });
  await settled(el);
  (eventsTable(el).shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);

  const buttons = el.shadowRoot!.querySelectorAll('.detail-toolbar button');
  (buttons[1] as HTMLButtonElement).click(); // Table
  await settled(el);

  const resultTable = query<ResultTable>(el.shadowRoot!, 'ditto-result-table');
  assert.deepEqual(resultTable.columns, ['_id', 'aa', 'zz'], '_id leads, the rest sort');

  const before = posted.length;
  (resultTable.shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);
  const msg = posted[before] as { type: string; rowJson: string };
  assert.equal(msg.type, 'observer.rowSelected');
  assert.deepEqual(JSON.parse(msg.rowJson), { _id: 'r0', zz: 1, aa: 2 });
});

test('Observer: cleared empties the buffer and drops the selection', async t => {
  const { el } = await mount(t);
  send({ type: 'observer.events', events: [evt('a'), evt('b')] });
  await settled(el);
  (eventsTable(el).shadowRoot!.querySelector('tbody tr') as HTMLElement).click();
  await settled(el);
  assert.equal(el.selectedEventId, 'a');

  send({ type: 'observer.cleared' });
  await settled(el);
  assert.equal(el.events.length, 0);
  assert.equal(el.selectedEventId, null);
  assert.match(el.shadowRoot!.querySelector('.detail-pane .empty')!.textContent,
    /Activate the observer to start collecting events/);
});

test('Observer: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  send({ type: 'observer.events', events: [evt('a')] });
  await settled(el);
  assert.equal(el.events.length, 1);

  // VS Code re-parents the panel between editor groups: the element must
  // not process host messages while detached.
  host.remove();
  await el.updateComplete;
  send({ type: 'observer.events', events: [evt('x')] });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.events.length, 1, 'detached element must not process host messages');

  // Re-attach: exactly one handler must come back live.
  document.body.appendChild(host);
  await el.updateComplete;
  send({ type: 'observer.events', events: [evt('b')] });
  await settled(el);
  assert.deepEqual(el.events.map(e => e.id), ['a', 'b']);
});

// ─── events-table-element ──────────────────────────────────────

async function mountTable(
  t: { after(fn: () => void): void },
  events: ObserverEvent[],
  selectedEventId: string | null = null,
): Promise<EventsTable> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`
    <ditto-events-table
      .events=${events}
      .selectedEventId=${selectedEventId}
    ></ditto-events-table>`, host);
  const el = host.querySelector('ditto-events-table') as unknown as EventsTable;
  await el.updateComplete;
  return el;
}

test('EventsTable: empty state renders without a table', async t => {
  const el = await mountTable(t, []);
  assert.match(el.shadowRoot!.querySelector('.empty')!.textContent, /No events yet/);
  assert.equal(el.shadowRoot!.querySelector('table'), null);
});

test('EventsTable: rows carry diff counts with per-kind styling classes', async t => {
  const el = await mountTable(t, [evt('a', {
    data: [{ _id: 'r0' }, { _id: 'r1' }],
    totalRows: 2,
    insertions: [0],
    updates: [1],
    deletions: [3],
    moves: [{ from: 0, to: 1 }],
  })]);

  const cells = el.shadowRoot!.querySelectorAll('tbody tr td');
  // Time | Count | Inserted | Updated | Deleted | Moves
  assert.equal(cells.length, 6);
  assert.match(cells[0]!.textContent, /^\d{2}:\d{2}:\d{2}\.\d{3}$/, 'time renders HH:MM:SS.mmm');
  assert.equal(cells[1]!.textContent, '2');
  assert.equal(cells[2]!.textContent, '1');
  assert.equal(cells[3]!.textContent, '1');
  assert.equal(cells[4]!.textContent, '1');
  assert.equal(cells[5]!.textContent, '1');
  assert.ok(cells[2]!.classList.contains('ins'));
  assert.ok(cells[3]!.classList.contains('upd'));
  assert.ok(cells[4]!.classList.contains('del'));
  assert.ok(cells[5]!.classList.contains('mov'));
});

test('EventsTable: invalid ISO timestamps render through unchanged', async t => {
  const el = await mountTable(t, [evt('a', { eventTimeISO: 'not-a-date' })]);
  assert.equal(el.shadowRoot!.querySelector('tbody tr td')!.textContent, 'not-a-date');
});

test('EventsTable: selection toggles and marks the selected row', async t => {
  const el = await mountTable(t, [evt('a'), evt('b')], 'b');
  const seen: Array<string | null> = [];
  el.addEventListener('event-selected', e => seen.push((e as CustomEvent).detail.eventId));

  const rows = el.shadowRoot!.querySelectorAll('tbody tr');
  assert.ok(rows[1]!.classList.contains('selected'));
  assert.ok(!rows[0]!.classList.contains('selected'));

  (rows[0] as HTMLElement).click();
  assert.deepEqual(seen, ['a']);

  // Clicking the already-selected row toggles back to null.
  (rows[1] as HTMLElement).click();
  assert.deepEqual(seen, ['a', null]);
});
