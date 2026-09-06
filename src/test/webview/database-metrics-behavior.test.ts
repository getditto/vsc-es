import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** Recorded webview→host traffic. The stub must exist before the element
 *  module runs — `messaging.ts` calls acquireVsCodeApi() at import time
 *  and holds the result. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/databaseMetrics/database-metrics-element.js');

/**
 * Database Metrics panel behaviour: the refresh round-trip, the category
 * card grid (byte formatting across B/KB/MB/GB, zero-total guard) and the
 * sortable collections table. The HostMessages re-attach contract lives in
 * database-metrics-element.test.ts; the system:metrics dashboard that used
 * to share this panel moved to webview-ui/systemMetrics/ (covered by
 * system-metrics-element.test.ts / system-metrics-behavior.test.ts).
 */

interface El extends HTMLElement {
  updateComplete: Promise<unknown>;
  view: { kind: string };
}

async function mount(t: { after(fn: () => void): void }): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-database-metrics></ditto-database-metrics>`, host);
  const el = host.querySelector('ditto-database-metrics') as unknown as El;
  await el.updateComplete;
  return el;
}

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function text(el: El): string {
  return (el.shadowRoot!.textContent ?? '').replace(/\s+/g, ' ');
}

function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storeBytes: 768,
    replicationBytes: 256,
    attachmentsBytes: 0,
    authBytes: 0,
    walShmBytes: 0,
    logsBytes: 0,
    otherBytes: 0,
    collectionBreakdown: [],
    collectionPayloadBytes: 0,
    totalDiskBytes: 1024,
    computedAt: Date.UTC(2026, 5, 9, 14, 0, 0),
    ...over,
  };
}

// ─── Refresh lifecycle ──────────────────────────────────────────

test('DatabaseMetrics: the idle state invites a refresh and the button posts dbMetrics.refresh', async t => {
  const el = await mount(t);
  assert.match(text(el), /Click Refresh to compute storage metrics\./);

  posted.length = 0;
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.header button')!;
  assert.equal(button.disabled, false);
  assert.match(button.textContent ?? '', /Refresh/);
  button.click();
  assert.deepEqual(posted, [{ type: 'dbMetrics.refresh' }]);
});

test('DatabaseMetrics: loading disables the button and narrates the walk', async t => {
  const el = await mount(t);
  fromHost({ type: 'dbMetrics.loading' });
  await el.updateComplete;

  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.header button')!;
  assert.equal(button.disabled, true);
  assert.match(button.textContent ?? '', /Computing…/);
  assert.match(text(el), /Walking the data directory/);
});

test('DatabaseMetrics: an error message renders in the error box', async t => {
  const el = await mount(t);
  fromHost({ type: 'dbMetrics.error', message: 'permission denied on ditto.store' });
  await el.updateComplete;
  const error = el.shadowRoot!.querySelector('.error');
  assert.ok(error);
  assert.match(error.textContent ?? '', /permission denied on ditto\.store/);
});

// ─── Category cards ─────────────────────────────────────────────

test('DatabaseMetrics: a loaded snapshot renders all seven cards with shares of the total', async t => {
  const el = await mount(t);
  fromHost({ type: 'dbMetrics.snapshot', snapshot: snapshot() });
  await el.updateComplete;

  assert.match(text(el), /1\.0 KB on disk/, 'header total');
  assert.match(text(el), /Refreshed at /, 'timestamp stamp');

  const cards = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.card')];
  assert.equal(cards.length, 7);
  const labels = cards.map(c => c.querySelector('.label')!.textContent);
  assert.deepEqual(labels, ['Store', 'Replication', 'Attachments', 'Auth', 'WAL / SHM', 'Logs', 'Other']);

  const store = cards[0]!;
  assert.match(store.querySelector('.value')!.textContent ?? '', /^768 B$/);
  assert.match(store.querySelector('.pct')!.textContent ?? '', /75\.0% of total/);
  const barWidth = store.querySelector<HTMLElement>('.bar-fill')!.style.width;
  assert.equal(barWidth, '75%');
  assert.match(store.querySelector('.card-tooltip')!.textContent ?? '', /Primary document store/,
    'each card carries its explanatory tooltip');
});

test('DatabaseMetrics: byte formatting scales through KB, MB and GB boundaries', async t => {
  const el = await mount(t);
  fromHost({
    type: 'dbMetrics.snapshot',
    snapshot: snapshot({
      storeBytes: 1023,                    // 1023 B
      replicationBytes: 1024,              // 1.0 KB
      attachmentsBytes: 2 * 1024 * 1024,   // 2.00 MB
      authBytes: 3 * 1024 * 1024 * 1024,   // 3.00 GB
      totalDiskBytes: 3 * 1024 * 1024 * 1024,
    }),
  });
  await el.updateComplete;

  const values = [...el.shadowRoot!.querySelectorAll('.card .value')].map(v => v.textContent);
  assert.deepEqual(values.slice(0, 4), ['1023 B', '1.0 KB', '2.00 MB', '3.00 GB']);
});

test('DatabaseMetrics: a zero-byte store renders 0% shares and zero-width bars', async t => {
  const el = await mount(t);
  fromHost({ type: 'dbMetrics.snapshot', snapshot: snapshot({ storeBytes: 0, replicationBytes: 0, totalDiskBytes: 0 }) });
  await el.updateComplete;

  for (const card of el.shadowRoot!.querySelectorAll<HTMLElement>('.card')) {
    assert.match(card.querySelector('.pct')!.textContent ?? '', /0% of total/);
    assert.equal(card.querySelector<HTMLElement>('.bar-fill')!.style.width, '0%',
      'the bar width is guarded against division by zero');
  }
});

// ─── Collections table ──────────────────────────────────────────

const COLLECTIONS = [
  { name: 'zebra', documentCount: 5, cborPayloadBytes: 300 },
  { name: 'apple', documentCount: 100, cborPayloadBytes: 900 },
  { name: 'mango', documentCount: 50, cborPayloadBytes: 100 },
];

async function mountWithCollections(t: { after(fn: () => void): void }): Promise<El> {
  const el = await mount(t);
  fromHost({
    type: 'dbMetrics.snapshot',
    snapshot: snapshot({ collectionBreakdown: COLLECTIONS, collectionPayloadBytes: 1300 }),
  });
  await el.updateComplete;
  return el;
}

function tableRows(el: El): string[][] {
  return [...el.shadowRoot!.querySelectorAll('tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].map(td => td.textContent ?? ''));
}

function header(el: El, label: string): HTMLElement {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('th')]
    .find(th => th.textContent?.includes(label))!;
}

test('DatabaseMetrics: collections sort by CBOR size descending out of the box', async t => {
  const el = await mountWithCollections(t);
  assert.match(text(el), /3 collections · 1\.3 KB total/);
  assert.deepEqual(tableRows(el).map(r => r[0]), ['apple', 'zebra', 'mango']);
  assert.match(header(el, 'CBOR size').textContent ?? '', /↓/, 'descending arrow on the default key');
  assert.match(header(el, 'CBOR size').className, /sorted/);
  // % of payload column: apple is 900/1300.
  assert.deepEqual(tableRows(el).map(r => r[3]), ['69.2%', '23.1%', '7.7%']);
  assert.deepEqual(tableRows(el)[1]!.slice(0, 3), ['zebra', '5', '300 B']);
});

test('DatabaseMetrics: clicking a header sorts ascending first, then toggles descending', async t => {
  const el = await mountWithCollections(t);

  header(el, 'Name').click();
  await el.updateComplete;
  assert.deepEqual(tableRows(el).map(r => r[0]), ['apple', 'mango', 'zebra'], 'name ascending');
  assert.match(header(el, 'Name').textContent ?? '', /↑/);

  header(el, 'Name').click();
  await el.updateComplete;
  assert.deepEqual(tableRows(el).map(r => r[0]), ['zebra', 'mango', 'apple'], 'same key again flips to descending');
  assert.match(header(el, 'Name').textContent ?? '', /↓/);
});

test('DatabaseMetrics: numeric headers start descending and toggle back', async t => {
  const el = await mountWithCollections(t);

  header(el, 'Documents').click();
  await el.updateComplete;
  assert.deepEqual(tableRows(el).map(r => r[0]), ['apple', 'mango', 'zebra'], 'documentCount descending');
  assert.match(header(el, 'Documents').className, /numeric/, 'numeric columns keep right alignment');
  assert.match(header(el, 'Documents').className, /sorted/);

  header(el, 'Documents').click();
  await el.updateComplete;
  assert.deepEqual(tableRows(el).map(r => r[0]), ['zebra', 'mango', 'apple'], 'second click → ascending');

  header(el, 'CBOR size').click();
  await el.updateComplete;
  assert.deepEqual(tableRows(el).map(r => r[0]), ['apple', 'zebra', 'mango'], 'switching keys restores the new key default');
});

test('DatabaseMetrics: one collection is singular; none renders the empty state', async t => {
  const el = await mount(t);
  fromHost({
    type: 'dbMetrics.snapshot',
    snapshot: snapshot({
      collectionBreakdown: [{ name: 'only', documentCount: 1, cborPayloadBytes: 64 }],
      collectionPayloadBytes: 64,
    }),
  });
  await el.updateComplete;
  assert.match(text(el), /1 collection · 64 B total/, 'singular noun');

  fromHost({ type: 'dbMetrics.snapshot', snapshot: snapshot() });
  await el.updateComplete;
  assert.match(text(el), /0 collections/);
  assert.match(text(el), /No user collections found\./);
  assert.equal(el.shadowRoot!.querySelector('tbody'), null, 'no table without collections');
});
