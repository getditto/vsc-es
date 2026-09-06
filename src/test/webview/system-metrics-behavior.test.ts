import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/systemMetrics/system-metrics-element.js');

/**
 * System Metrics row-value formatting: headline totals, the last-period
 * delta indicator, ordering, and the expanded-details content (histogram
 * averages in µs/ms/s, absolute max). The HostMessages contract, filter
 * interaction and guidance states live in system-metrics-element.test.ts.
 */

interface El extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-system-metrics></ditto-system-metrics>`, host);
  const el = host.querySelector('ditto-system-metrics') as unknown as El;
  await el.updateComplete;
  return el;
}

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function text(el: El): string {
  return (el.shadowRoot!.textContent ?? '').replace(/\s+/g, ' ');
}

function sysSnapshot(samples: unknown[]): Record<string, unknown> {
  return {
    samples,
    sinceMs: Date.UTC(2026, 5, 9, 14, 0, 0),
    polledAtMs: Date.UTC(2026, 5, 9, 14, 1, 0),
    pollIntervalMs: 5000,
  };
}

async function mountSnapshot(
  t: { after(fn: () => void): void },
  samples: unknown[],
): Promise<El> {
  const el = await mount(t);
  fromHost({ type: 'sysMetrics.status', status: { kind: 'working', snapshot: sysSnapshot(samples) } });
  await el.updateComplete;
  return el;
}

/** Expand the details for the row carrying `keyFragment`; returns the panel. */
async function detailsFor(el: El, keyFragment: string): Promise<HTMLElement> {
  const row = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')]
    .find(r => r.querySelector('.mkey')?.textContent?.includes(keyFragment))!;
  row.querySelector<HTMLButtonElement>('.info-btn')!.click();
  await el.updateComplete;
  return row.querySelector<HTMLElement>('.mdetail')!;
}

test('SystemMetrics: zero samples invites patience; the footer still anchors the window', async t => {
  const el = await mountSnapshot(t, []);
  assert.match(text(el), /No metrics reported yet — they accumulate while this panel is visible\./);
  assert.match(text(el), /Since .* — updated /);
});

test('SystemMetrics: rows show the since-connect total and the last-period delta as ▲ +N or a dash', async t => {
  const el = await mountSnapshot(t, [
    {
      key: 'ditto.backend.sqlite3.fsync_total',
      labels: { db: 'main' }, description: 'Total fsync calls', unit: 'count', kind: 'counter',
      sinceConnect: 1000, periodDelta: 12,
    },
    {
      key: 'ditto.replication.session_resets',
      labels: {}, description: 'Resets', unit: 'count', kind: 'counter',
      sinceConnect: 2, periodDelta: 0,
    },
  ]);

  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')];
  const total = rows[0]!;
  assert.equal(total.querySelector('.mkey')!.textContent, 'backend.sqlite3.fsync_total',
    'only the ditto. prefix is stripped — the namespace stays');
  assert.equal(total.querySelector('.mval')!.textContent, '1,000', 'integral values localise');
  assert.match(total.querySelector('.mdelta')!.textContent ?? '', /▲ \+12/,
    'a positive last period renders as an up-tick delta');

  const idle = rows[1]!;
  assert.equal(idle.querySelector('.mdelta')!.textContent?.trim(), '—',
    'a zero last period renders a dash');
});

test('SystemMetrics: histogram details render µs/ms averages and the max, guarded against zero', async t => {
  const el = await mountSnapshot(t, [
    {
      key: 'ditto.backend.sqlite3.fsync_duration_secs',
      labels: { db: 'main' }, description: 'fsync duration', unit: 'seconds', kind: 'histogram',
      sinceConnect: 10, periodDelta: 2, sumSinceConnect: 0.0005, absMax: 1.23456,
    },
    {
      key: 'ditto.backend.sqlite3.wal_size_pages',
      labels: {}, description: 'wal size', unit: 'seconds', kind: 'histogram',
      sinceConnect: 4, periodDelta: 0, sumSinceConnect: 0.02, // 5 ms avg
    },
    {
      key: 'ditto.backend.sqlite3.checkpoint_duration_secs',
      labels: {}, description: 'checkpoint', unit: 'seconds', kind: 'histogram',
      sinceConnect: 0, periodDelta: 0,
    },
  ]);

  const fsync = await detailsFor(el, 'fsync_duration_secs');
  assert.match(fsync.textContent ?? '', /fsync duration/, 'description');
  assert.match(fsync.textContent ?? '', /Histogram/, 'kind');
  assert.match(fsync.textContent ?? '', /seconds/, 'unit');
  assert.match(fsync.textContent ?? '', /Avg since connect/, );
  assert.match(fsync.textContent ?? '', /50 µs/, 'sub-millisecond averages scale to µs');
  assert.match(fsync.textContent ?? '', /1\.23 s/, 'abs max scales to s');

  const wal = await detailsFor(el, 'wal_size_pages');
  assert.match(wal.textContent ?? '', /5\.0 ms/, 'millisecond band between µs and s');
  assert.ok(!/Abs max/.test(wal.textContent ?? ''), 'absMax absent → no max row');

  const checkpoint = await detailsFor(el, 'checkpoint_duration_secs');
  assert.ok(!/Avg since connect/.test(checkpoint.textContent ?? ''),
    'sinceConnect 0 → no average (division guard)');
  // fsync and wal were expanded earlier and stayed expanded.
  assert.equal(el.shadowRoot!.querySelectorAll('.mdetail').length, 3,
    'each series toggles independently — multiple rows can carry open details at once');
});

test('SystemMetrics: rows render in first-seen accumulation order, labels preserved per series', async t => {
  const opened = (labels: Record<string, string>) => ({
    key: 'ditto.network.dsoq.connection.opened',
    labels, description: 'opened', unit: 'count', kind: 'counter',
    sinceConnect: 1, periodDelta: 0,
  });
  const el = await mountSnapshot(t, [
    opened({ transport: 'wifi' }),
    { key: 'ditto.network.dsoq.connection.closed', labels: {}, description: 'closed', unit: 'count', kind: 'counter', sinceConnect: 3, periodDelta: 0 },
    opened({ transport: 'ble' }),
  ]);

  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')];
  assert.deepEqual(rows.map(r => r.querySelector('.mkey')!.textContent), [
    'network.dsoq.connection.opened',
    'network.dsoq.connection.closed',
    'network.dsoq.connection.opened',
  ], 'payload order is kept (first-seen), duplicates keyed by label set');
  assert.deepEqual(
    rows.map(r => r.querySelector('.mlabels')?.textContent ?? ''),
    ['transport=wifi', '', 'transport=ble'],
    'each series keeps its own label line',
  );
});

test('SystemMetrics: expansion state survives later status pushes', async t => {
  const el = await mountSnapshot(t, [
    {
      key: 'ditto.network.dsoq.connection.opened',
      labels: {}, description: 'opened', unit: 'count', kind: 'counter',
      sinceConnect: 1, periodDelta: 0,
    },
  ]);
  await detailsFor(el, 'connection.opened');
  assert.equal(el.shadowRoot!.querySelectorAll('.mdetail').length, 1);

  // A later poll updates the numbers — the open details must stay open.
  fromHost({
    type: 'sysMetrics.status',
    status: {
      kind: 'working',
      snapshot: sysSnapshot([
        {
          key: 'ditto.network.dsoq.connection.opened',
          labels: {}, description: 'opened', unit: 'count', kind: 'counter',
          sinceConnect: 5, periodDelta: 4,
        },
      ]),
    },
  });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelectorAll('.mdetail').length, 1, 'details persist across polls');
  assert.match(text(el), /▲ \+4/);
});
