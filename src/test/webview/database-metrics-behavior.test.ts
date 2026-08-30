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
 * card grid (byte formatting across B/KB/MB/GB, zero-total guard), the
 * sortable collections table, and the system:metrics dashboard's histogram
 * detail column (µs/ms/s averaging, max, empty sections, label ordering).
 * The HostMessages re-attach contract and the divergence banner live in
 * database-metrics-element.test.ts; this file covers everything around them.
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

function sysSnapshot(samples: unknown[]): Record<string, unknown> {
  return {
    samples,
    sinceMs: Date.UTC(2026, 5, 9, 14, 0, 0),
    polledAtMs: Date.UTC(2026, 5, 9, 14, 1, 0),
    pollIntervalMs: 5000,
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

// ─── System metrics dashboard detail ────────────────────────────

test('DatabaseMetrics: empty metric sections say there is nothing to observe yet', async t => {
  const el = await mount(t);
  fromHost({ type: 'dbMetrics.systemMetrics', status: { kind: 'working', snapshot: sysSnapshot([]) } });
  await el.updateComplete;

  const nones = el.shadowRoot!.querySelectorAll('.sys-none');
  assert.equal(nones.length, 3, 'one placeholder per dashboard section');
  assert.match(nones[0]!.textContent ?? '', /No observations yet/);
  assert.match(text(el), /every 5s/, 'poll interval rendered');
  assert.match(text(el), /Totals since /);
});

test('DatabaseMetrics: histogram rows render µs/ms averages and the max; counters show their description', async t => {
  const el = await mount(t);
  fromHost({
    type: 'dbMetrics.systemMetrics',
    status: {
      kind: 'working',
      snapshot: sysSnapshot([
        {
          key: 'ditto.backend.sqlite3.fsync_duration_secs',
          labels: { db: 'main' }, description: 'fsync duration', unit: 'seconds', kind: 'histogram',
          sinceConnect: 10, periodDelta: 2, sumSinceConnect: 0.0005, absMax: 1.23456,
        },
        {
          key: 'ditto.backend.sqlite3.fsync_total',
          labels: { db: 'main' }, description: 'Total fsync calls', unit: 'count', kind: 'counter',
          sinceConnect: 1000, periodDelta: 12,
        },
      ]),
    },
  });
  await el.updateComplete;

  // samplesFor orders by SQLITE_KEYS: fsync_total precedes fsync_duration_secs.
  const rows = [...el.shadowRoot!.querySelectorAll('.sys-table tbody tr')];
  assert.equal(rows.length, 2);
  const counter = [...rows[0]!.querySelectorAll('td')].map(td => (td.textContent ?? '').trim());
  assert.equal(counter[0], 'sqlite3.fsync_total', 'shortKey strips the two-segment prefix');
  assert.equal(counter[2], '1,000', 'counter values localise');
  assert.equal(counter[4], 'Total fsync calls', 'counters use the description as the detail');

  const hist = [...rows[1]!.querySelectorAll('td')].map(td => td.textContent ?? '');
  assert.equal(hist[0], 'sqlite3.fsync_duration_secs');
  assert.equal(hist[1], 'db=main');
  assert.equal(hist[2], '10', 'histogram count column is a plain count, not seconds');
  assert.equal(hist[3], '2');
  assert.match(hist[4]!, /avg 50 µs/, 'sub-millisecond averages render in µs');
  assert.match(hist[4]!, /max 1\.23 s/, 'second-scale values render in s');
});

test('DatabaseMetrics: a histogram with no observations yet omits the average, and a missing max stays absent', async t => {
  const el = await mount(t);
  fromHost({
    type: 'dbMetrics.systemMetrics',
    status: {
      kind: 'working',
      snapshot: sysSnapshot([
        {
          key: 'ditto.backend.sqlite3.checkpoint_duration_secs',
          labels: {}, description: 'checkpoint', unit: 'seconds', kind: 'histogram',
          sinceConnect: 0, periodDelta: 0,
        },
        {
          key: 'ditto.backend.sqlite3.wal_size_pages',
          labels: {}, description: 'wal size', unit: 'seconds', kind: 'histogram',
          sinceConnect: 4, periodDelta: 1, sumSinceConnect: 0.02, // 5 ms avg
        },
      ]),
    },
  });
  await el.updateComplete;

  // SQLITE_KEYS order: wal_size_pages precedes checkpoint_duration_secs.
  const rows = [...el.shadowRoot!.querySelectorAll('.sys-table tbody tr')];
  const msRow = [...rows[0]!.querySelectorAll('td')].map(td => (td.textContent ?? '').trim());
  assert.match(msRow[4]!, /avg 5\.0 ms/, 'millisecond band between µs and s');
  assert.ok(!/max/.test(msRow[4]!), 'absMax absent → no max clause');
  const zeroRow = [...rows[1]!.querySelectorAll('td')].map(td => (td.textContent ?? '').trim());
  assert.equal(zeroRow[4], '', 'sinceConnect 0 → no average (division guard) and no max');
});

test('DatabaseMetrics: samples are ordered by section key, then by label set', async t => {
  const el = await mount(t);
  const opened = (labels: Record<string, string>) => ({
    key: 'ditto.network.dsoq.connection.opened',
    labels, description: 'opened', unit: 'count', kind: 'counter',
    sinceConnect: 1, periodDelta: 0,
  });
  fromHost({
    type: 'dbMetrics.systemMetrics',
    status: {
      kind: 'working',
      // Payload deliberately scrambled: closed before opened, and two
      // opened series whose label sets need the tiebreak.
      snapshot: sysSnapshot([
        opened({ transport: 'wifi' }),
        { key: 'ditto.network.dsoq.connection.closed', labels: {}, description: 'closed', unit: 'count', kind: 'counter', sinceConnect: 3, periodDelta: 0 },
        opened({ transport: 'ble' }),
      ]),
    },
  });
  await el.updateComplete;

  const firstTable = el.shadowRoot!.querySelector('.sys-table')!;
  const keys = [...firstTable.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent);
  assert.deepEqual(keys, [
    'dsoq.connection.opened',
    'dsoq.connection.opened',
    'dsoq.connection.closed',
  ], 'rows follow DSOQ_KEYS order, not payload order');
  const labelCells = [...firstTable.querySelectorAll('tbody tr td.labels')].map(td => td.textContent);
  assert.deepEqual(labelCells.slice(0, 2), ['transport=ble', 'transport=wifi'],
    'same-key series are ordered by their label set');
});
