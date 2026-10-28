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

await import('../../../webview-ui/systemMetrics/system-metrics-element.js');

/**
 * System Metrics panel element (SwiftUI-parity layout): the HostMessages
 * wiring (consume while attached, stay silent while detached, resume on
 * re-attach), the Refresh round-trip, the namespace segment filter, the
 * info-icon details expansion, the divergence banner, and the status
 * guidance states. Value-formatting detail lives in
 * system-metrics-behavior.test.ts.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  systemMetrics: { kind: string } | null;
}

const SYSTEM_SNAPSHOT = {
  samples: [
    {
      key: 'ditto.network.dsoq.connection.opened',
      labels: {}, description: 'Connections opened', unit: 'count', kind: 'counter',
      sinceConnect: 12, periodDelta: 1,
    },
    {
      key: 'ditto.network.dsoq.connection.closed',
      labels: {}, description: 'Connections closed', unit: 'count', kind: 'counter',
      sinceConnect: 10, periodDelta: 1,
    },
    {
      key: 'ditto.backend.sqlite3.fsync_duration_secs',
      labels: { db: 'main' }, description: 'fsync duration', unit: 'seconds', kind: 'histogram',
      sinceConnect: 24, periodDelta: 2, sumSinceConnect: 0.024, absMax: 0.004,
    },
    {
      key: 'ditto.store.changes',
      labels: {}, description: 'Store rows changed', unit: 'count', kind: 'counter',
      sinceConnect: 18, periodDelta: 4,
    },
    {
      key: 'ditto.replication.session_resets',
      labels: { cause: 'handshake_timeout' }, description: 'Resets', unit: 'count', kind: 'counter',
      sinceConnect: 2, periodDelta: 0,
    },
    {
      key: 'ditto.query.executions_total',
      labels: {}, description: 'Query executions', unit: 'count', kind: 'counter',
      sinceConnect: 41, periodDelta: 3,
    },
    {
      // Legacy dual-emitted series: the SDK reports every query metric
      // twice — dql.requests alongside ditto.query.requests. The legacy
      // row must land in the Query segment with its OTLP twin, not Other.
      key: 'dql.requests',
      labels: {}, description: 'Query requests (legacy alias)', unit: 'count', kind: 'counter',
      sinceConnect: 41, periodDelta: 3,
    },
    {
      key: 'ditto.discovery.mdns.active_browse_sessions',
      labels: {}, description: 'Active mDNS browse sessions', unit: 'count', kind: 'counter',
      sinceConnect: 2, periodDelta: 0,
    },
    {
      key: 'ditto.multiplexer.phy.bytes_sent',
      labels: { transport: 'tcp' }, description: 'Bytes sent at the physical link layer', unit: 'bytes', kind: 'counter',
      sinceConnect: 4096, periodDelta: 512,
    },
    {
      // A diffcaster mesh series — proves the broadened Sync segment
      // catches more than ditto.sync.*/ditto.replication.*.
      key: 'ditto.diffcaster.diffs_applied',
      labels: {}, description: 'Diffs applied to the local store', unit: 'count', kind: 'counter',
      sinceConnect: 7, periodDelta: 1,
    },
    {
      // A NORM multicast transport series — proves Transport catches the
      // multicast root, not just multiplexer/transport.
      key: 'ditto.multicast.tx_objects_sent',
      labels: {}, description: 'Multicast objects sent', unit: 'count', kind: 'counter',
      sinceConnect: 3, periodDelta: 0,
    },
    {
      // Peer identity/attachment series — its own segment.
      key: 'ditto.peer.revocation_entries_stored',
      labels: {}, description: 'Revocation entries stored', unit: 'count', kind: 'counter',
      sinceConnect: 1, periodDelta: 0,
    },
    {
      key: 'ditto.small_peer_info.write_store_duration_secs',
      labels: {}, description: 'Small-peer-info store write duration', unit: 'seconds', kind: 'histogram',
      sinceConnect: 9, periodDelta: 1, sumSinceConnect: 0.09, absMax: 0.02,
    },
    {
      key: 'custom.metric.from.somewhere_else',
      labels: {}, description: 'A metric outside Ditto namespaces', unit: 'count', kind: 'counter',
      sinceConnect: 7, periodDelta: 0,
    },
  ],
  sinceMs: Date.now() - 60_000,
  polledAtMs: Date.now(),
  pollIntervalMs: 5000,
};

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-system-metrics></ditto-system-metrics>`, host);
  const el = host.querySelector('ditto-system-metrics') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

async function mountWorking(t: { after(fn: () => void): void }): Promise<Element> {
  const { el } = await mount(t);
  fromHost({ type: 'sysMetrics.status', status: { kind: 'working', snapshot: SYSTEM_SNAPSHOT } });
  await el.updateComplete;
  return el;
}

function rows(el: Element): string[] {
  return [...el.shadowRoot!.querySelectorAll('.mrow .mkey')].map(k => k.textContent ?? '');
}

function segment(el: Element, label: string): HTMLButtonElement {
  return [...el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.seg button')]
    .find(b => b.textContent === label)!;
}

test('SystemMetrics: the Refresh button posts sysMetrics.refresh', async t => {
  const { el } = await mount(t);
  posted.length = 0;
  const button = el.shadowRoot!.querySelector<HTMLButtonElement>('.header button')!;
  assert.match(button.textContent ?? '', /Refresh/);
  button.click();
  assert.deepEqual(posted, [{ type: 'sysMetrics.refresh' }]);
});

test('SystemMetrics: a working snapshot renders one row per series, keys stripped to the namespace', async t => {
  const el = await mountWorking(t);
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /System Metrics/);
  assert.deepEqual(rows(el), [
    'network.dsoq.connection.opened',
    'network.dsoq.connection.closed',
    'backend.sqlite3.fsync_duration_secs',
    'store.changes',
    'replication.session_resets',
    'query.executions_total',
    'dql.requests',
    'discovery.mdns.active_browse_sessions',
    'multiplexer.phy.bytes_sent',
    'diffcaster.diffs_applied',
    'multicast.tx_objects_sent',
    'peer.revocation_entries_stored',
    'small_peer_info.write_store_duration_secs',
    'custom.metric.from.somewhere_else',
  ], 'every series renders under All, with the ditto. prefix stripped');
  assert.match(text, /db=main/, 'series carry their labels');
  assert.match(text, /cause=handshake_timeout/);
  assert.match(text, /Since .* — updated /, 'footer anchors the accumulation window');
  assert.match(text, /every 5s/, 'poll cadence rendered');
});

test('SystemMetrics: the segment control filters rows by namespace', async t => {
  const el = await mountWorking(t);

  segment(el, 'Network').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), [
    'network.dsoq.connection.opened',
    'network.dsoq.connection.closed',
  ]);
  assert.equal(segment(el, 'Network').getAttribute('aria-pressed'), 'true');
  assert.equal(segment(el, 'All').getAttribute('aria-pressed'), 'false');

  segment(el, 'Store').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), [
    'backend.sqlite3.fsync_duration_secs',
    'store.changes',
    'small_peer_info.write_store_duration_secs',
  ], 'ditto.backend.*, ditto.store.* and ditto.small_peer_info.* series land in the Store segment');

  segment(el, 'Sync').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['replication.session_resets', 'diffcaster.diffs_applied'],
    'Sync covers ditto.sync.*, ditto.replication.* and the diffcaster mesh');

  segment(el, 'Query').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['query.executions_total', 'dql.requests'],
    'ditto.query.* and legacy dql.* series land in the Query segment');

  segment(el, 'Discovery').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['discovery.mdns.active_browse_sessions'],
    'ditto.discovery.* series land in the Discovery segment');

  segment(el, 'Transport').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['multiplexer.phy.bytes_sent', 'multicast.tx_objects_sent'],
    'ditto.multiplexer.* and ditto.multicast.* series land in the Transport segment');

  segment(el, 'Peer').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['peer.revocation_entries_stored'],
    'ditto.peer.* series land in the Peer segment');

  segment(el, 'Other').click();
  await el.updateComplete;
  assert.deepEqual(rows(el), ['custom.metric.from.somewhere_else'],
    'Other catches series outside every known namespace');

  segment(el, 'All').click();
  await el.updateComplete;
  assert.equal(rows(el).length, 14);
});

test('SystemMetrics: an empty namespace says so rather than showing a blank panel', async t => {
  const { el } = await mount(t);
  const snapshot = {
    ...SYSTEM_SNAPSHOT,
    samples: SYSTEM_SNAPSHOT.samples.filter(s => s.key.startsWith('ditto.network.')),
  };
  fromHost({ type: 'sysMetrics.status', status: { kind: 'working', snapshot } });
  await el.updateComplete;

  segment(el, 'Store').click();
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No metrics in this namespace\./);
});

test('SystemMetrics: diverging opened/closed totals surface the leak banner', async t => {
  const el = await mountWorking(t);
  const banner = el.shadowRoot!.querySelector('.banner');
  assert.ok(banner);
  assert.match(banner.textContent ?? '', /opened \(12\) ≠ closed \(10\)/);
  assert.match(banner.textContent ?? '', /connection leak or handshake issue/);
});

test('SystemMetrics: converged opened/closed totals render no banner', async t => {
  const { el } = await mount(t);
  const snapshot = {
    ...SYSTEM_SNAPSHOT,
    samples: SYSTEM_SNAPSHOT.samples.map(s =>
      s.key.endsWith('connection.closed') ? { ...s, sinceConnect: 12 } : s),
  };
  fromHost({ type: 'sysMetrics.status', status: { kind: 'working', snapshot } });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.banner'), null);
});

test('SystemMetrics: gauge rows render the absolute value and a ▼ for negative deltas', async t => {
  const { el } = await mount(t);
  fromHost({
    type: 'sysMetrics.status',
    status: {
      kind: 'working',
      snapshot: {
        ...SYSTEM_SNAPSHOT,
        samples: [
          {
            key: 'ditto.transport.awdl.interface_up',
            labels: {}, description: 'AWDL interface status', unit: 'count', kind: 'gauge',
            sinceConnect: 1, periodDelta: 0,
          },
          {
            key: 'ditto.network.connections',
            labels: {}, description: 'Active connections', unit: 'count', kind: 'gauge',
            sinceConnect: 2, periodDelta: -3,
          },
        ],
      },
    },
  });
  await el.updateComplete;

  const rowVals = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')]
    .map(r => ({
      key: r.querySelector('.mkey')?.textContent,
      headline: r.querySelector('.mval')?.textContent,
      delta: r.querySelector('.mdelta')?.textContent?.trim(),
      deltaCls: r.querySelector('.mdelta')?.className ?? '',
    }));
  assert.deepEqual(rowVals, [
    { key: 'transport.awdl.interface_up', headline: '1', delta: '—', deltaCls: 'mdelta ' },
    { key: 'network.connections', headline: '2', delta: '▼ −3', deltaCls: 'mdelta down' },
  ], 'gauges show current value; negative period delta renders ▼ in the down colour');
});

test('SystemMetrics: epoch-timestamp gauges render as an age, not a raw epoch', async t => {
  const { el } = await mount(t);
  const nowSec = Date.now() / 1000;
  fromHost({
    type: 'sysMetrics.status',
    status: {
      kind: 'working',
      snapshot: {
        ...SYSTEM_SNAPSHOT,
        samples: [
          {
            key: 'ditto.multiplexer.phy.last_sent_at',
            labels: { transport_type: 'awdl' }, description: 'Last send',
            unit: 'seconds', kind: 'gauge',
            sinceConnect: nowSec - 12, periodDelta: 5,
          },
          {
            key: 'ditto.multiplexer.phy.last_received_at',
            labels: { transport_type: 'awdl' }, description: 'Last receive',
            unit: 'seconds', kind: 'gauge',
            sinceConnect: 0, periodDelta: 0,
          },
        ],
      },
    },
  });
  await el.updateComplete;

  const headlines = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow .mval')]
    .map(n => n.textContent);
  assert.deepEqual(headlines, ['12s ago', 'never'],
    'epoch seconds render as a relative age; a zero epoch means no activity yet');
});

test('SystemMetrics: the info icon toggles the row details', async t => {
  const el = await mountWorking(t);
  const firstRow = el.shadowRoot!.querySelector('.mrow')!;
  const info = firstRow.querySelector<HTMLButtonElement>('.info-btn')!;
  assert.equal(info.getAttribute('aria-expanded'), 'false');
  assert.equal(firstRow.querySelector('.mdetail'), null, 'details start collapsed');

  info.click();
  await el.updateComplete;
  assert.equal(info.getAttribute('aria-expanded'), 'true');
  const detail = firstRow.querySelector('.mdetail')!;
  assert.ok(detail);
  assert.match(detail.textContent ?? '', /Connections opened/, 'description surfaces');
  assert.match(detail.textContent ?? '', /ditto\.network\.dsoq\.connection\.opened/, 'full key in details');
  assert.match(detail.textContent ?? '', /Counter/, 'kind in details');

  info.click();
  await el.updateComplete;
  assert.equal(firstRow.querySelector('.mdetail'), null, 'second click collapses');
});

test('SystemMetrics: the exporter disabled state shows enable-and-reconnect guidance', async t => {
  const { el } = await mount(t);
  fromHost({ type: 'sysMetrics.status', status: { kind: 'exporterDisabled' } });
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /exporter is off for this connection/);
  assert.match(text, /collectSystemMetrics/);
  assert.match(text, /reconnect/i);
});

test('SystemMetrics: setting-off and no-connection states are distinct guidance', async t => {
  const { el } = await mount(t);

  fromHost({ type: 'sysMetrics.status', status: { kind: 'settingDisabled' } });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /System metrics are disabled.*collectSystemMetrics/s);

  fromHost({ type: 'sysMetrics.status', status: { kind: 'noConnection' } });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No active connection/);

  fromHost({ type: 'sysMetrics.status', status: { kind: 'unavailable', message: 'unknown collection system:metrics' } });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /unavailable: unknown collection system:metrics/);
});

// ─── Search / text filter ──────────────────────────────────────

function typeSearch(el: Element, q: string): void {
  const input = el.shadowRoot!.querySelector<HTMLInputElement>('.search')!;
  input.value = q;
  input.dispatchEvent(new Event('input'));
}

/** Master-list rows only (excludes the pinned accordion). */
function masterKeys(el: Element): (string | null)[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')]
    .filter(r => !r.closest('.pinned'))
    .map(r => r.querySelector('.mkey')?.textContent ?? null);
}

test('SystemMetrics: the search box sits on the segment control row, right-aligned after it', async t => {
  const el = await mountWorking(t);
  const row = el.shadowRoot!.querySelector('.filter-row')!;
  assert.ok(row);
  const order = [...row.children].map(c => c.classList.contains('seg-wrap') ? 'seg' : 'search');
  assert.deepEqual(order, ['seg', 'search']);
  const input = row.querySelector<HTMLInputElement>('.search')!;
  assert.equal(input.getAttribute('placeholder'), 'Filter metrics…');
  assert.equal(input.getAttribute('type'), 'search', 'native clear affordance');
});

test('SystemMetrics: searching filters the master list by key, case-insensitively', async t => {
  const el = await mountWorking(t);
  typeSearch(el, 'NETWORK');
  await el.updateComplete;
  assert.deepEqual(masterKeys(el), [
    'network.dsoq.connection.opened',
    'network.dsoq.connection.closed',
  ]);
});

test('SystemMetrics: search matches label keys and values (e.g. every ble series)', async t => {
  const { el } = await mount(t);
  const ble = (key: string) => ({
    key, labels: { transport: 'ble' }, description: '', unit: 'count', kind: 'counter',
    sinceConnect: 1, periodDelta: 0,
  });
  fromHost({
    type: 'sysMetrics.status',
    status: {
      kind: 'working',
      snapshot: {
        ...SYSTEM_SNAPSHOT,
        samples: [
          ...SYSTEM_SNAPSHOT.samples,
          ble('ditto.network.dsoq.connection.mx.end'),       // label value hit
          { ...ble('custom.other'), labels: { ble: 'on' } },  // label KEY hit
        ],
      },
    },
  });
  await el.updateComplete;

  typeSearch(el, 'ble');
  await el.updateComplete;
  assert.deepEqual(masterKeys(el), [
    'network.dsoq.connection.mx.end',
    'custom.other',
  ], 'label values and label keys both participate');

  typeSearch(el, '   ');
  await el.updateComplete;
  assert.equal(masterKeys(el).length, 16, 'a whitespace-only query is no filter at all');
});

test('SystemMetrics: search composes with the namespace segment', async t => {
  const el = await mountWorking(t);
  segment(el, 'Network').click();
  typeSearch(el, 'closed');
  await el.updateComplete;
  assert.deepEqual(masterKeys(el), ['network.dsoq.connection.closed']);

  // …and the empty state names the query when one is active.
  typeSearch(el, 'zzz-no-such-metric');
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No metrics match "zzz-no-such-metric"\./);
});

test('SystemMetrics: the pinned section ignores the search query', async t => {
  const el = await mountWorking(t);
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;

  typeSearch(el, 'sqlite');
  await el.updateComplete;
  assert.deepEqual(masterKeys(el), ['backend.sqlite3.fsync_duration_secs']);
  assert.deepEqual(
    [...el.shadowRoot!.querySelectorAll('.pinned .mrow .mkey')].map(k => k.textContent),
    ['network.dsoq.connection.opened'],
    'the pinned set stays put regardless of the query',
  );
});

// ─── Pinned metrics ────────────────────────────────────────────

function rowWith(el: Element, keyFragment: string): HTMLElement {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')]
    .find(r => r.querySelector('.mkey')?.textContent?.includes(keyFragment))!;
}

test('SystemMetrics: no pins → no pinned section', async t => {
  const el = await mountWorking(t);
  assert.equal(el.shadowRoot!.querySelector('.pinned'), null);
});

test('SystemMetrics: pinning a row adds it to the Pinned section above the segment control without removing the master row', async t => {
  const el = await mountWorking(t);
  posted.length = 0;

  const masterCount = el.shadowRoot!.querySelectorAll('.mrow').length;
  const row = rowWith(el, 'network.dsoq.connection.opened');
  const pinBtn = row.querySelector<HTMLButtonElement>('.pin-btn')!;
  assert.equal(pinBtn.getAttribute('aria-pressed'), 'false');
  pinBtn.click();
  await el.updateComplete;

  assert.deepEqual(posted, [{
    type: 'sysMetrics.setPins',
    pins: [{ key: 'ditto.network.dsoq.connection.opened', labels: {} }],
  }], 'the complete replacement list is posted');

  const pinned = el.shadowRoot!.querySelector('.pinned');
  assert.ok(pinned, 'pinned section appeared');
  // Ordering: the pinned accordion sits above the segment control.
  const order = [...el.shadowRoot!.querySelectorAll('.pinned, .seg-wrap')];
  assert.deepEqual(order.map(n => n.classList.contains('pinned') ? 'pinned' : 'seg'),
    ['pinned', 'seg']);
  assert.match(pinned.textContent ?? '', /Pinned\s+\(1\)/);
  assert.ok(
    pinned.querySelector('.mkey')?.textContent?.includes('network.dsoq.connection.opened'),
    'pinned section shows the series',
  );
  assert.equal(pinBtn.getAttribute('aria-pressed'), 'true');
  assert.ok(pinBtn.querySelector('.codicon-pinned'), 'filled pin glyph when pinned');

  assert.equal(
    [...el.shadowRoot!.querySelectorAll('.mkey')]
      .filter(k => k.textContent === 'network.dsoq.connection.opened').length,
    2,
    'pinned AND master list both render the series (pinning does not remove it)',
  );
  assert.equal(el.shadowRoot!.querySelectorAll('.mrow').length, masterCount + 1);
});

test('SystemMetrics: the pinned section honours the live snapshot, not the namespace filter', async t => {
  const el = await mountWorking(t);
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;

  segment(el, 'Store').click();
  await el.updateComplete;
  const pinned = el.shadowRoot!.querySelector('.pinned')!;
  assert.ok(pinned.querySelector('.mkey')?.textContent?.includes('network.dsoq.connection.opened'),
    'pinned rows are filter-independent');
  assert.match(pinned.querySelector('.mval')!.textContent ?? '', /12/,
    'pinned row carries the live since-connect total');
});

test('SystemMetrics: unpinning from the master row and from the pinned row both remove the pin', async t => {
  const el = await mountWorking(t);
  posted.length = 0;
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;

  // Unpin from the master row.
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pinned'), null, 'last pin removed → section gone');
  assert.deepEqual(posted.pop(), { type: 'sysMetrics.setPins', pins: [] });

  // Pin again, then unpin from inside the pinned section.
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;
  const pinnedRow = el.shadowRoot!.querySelector('.pinned')!
    .querySelector<HTMLElement>('.mrow')!;
  pinnedRow.querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pinned'), null, 'unpin from the pinned row works');
});

test('SystemMetrics: the accordion header collapses and re-expands the pinned rows', async t => {
  const el = await mountWorking(t);
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;

  const head = el.shadowRoot!.querySelector<HTMLButtonElement>('.pinned-head')!;
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'open by default');
  assert.ok(el.shadowRoot!.querySelector('.pinned-body'));

  head.click();
  await el.updateComplete;
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(el.shadowRoot!.querySelector('.pinned-body'), null, 'rows hidden when closed');
  assert.match(head.textContent ?? '', /Pinned\s+\(1\)/, 'header keeps the count when closed');

  head.click();
  await el.updateComplete;
  assert.ok(el.shadowRoot!.querySelector('.pinned-body'), 're-expanded');
});

test('SystemMetrics: Clear empties every pin without touching the accordion state', async t => {
  const el = await mountWorking(t);
  posted.length = 0;
  rowWith(el, 'network.dsoq.connection.opened').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  rowWith(el, 'replication.session_resets').querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;
  assert.match(el.shadowRoot!.querySelector('.pinned')!.textContent ?? '', /Pinned\s+\(2\)/);

  el.shadowRoot!.querySelector<HTMLElement>('.pinned-clear')!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pinned'), null);
  assert.deepEqual(posted.pop(), { type: 'sysMetrics.setPins', pins: [] });
});

test('SystemMetrics: a host pins push restores the section (panel reopen)', async t => {
  const el = await mountWorking(t);
  fromHost({
    type: 'sysMetrics.pins',
    pins: [
      { key: 'ditto.backend.sqlite3.fsync_duration_secs', labels: { db: 'main' } },
      { key: 'ditto.network.dsoq.connection.opened', labels: {} },
    ],
  });
  await el.updateComplete;
  const keys = [...el.shadowRoot!.querySelectorAll('.pinned .mkey')].map(k => k.textContent);
  assert.deepEqual(keys, [
    'backend.sqlite3.fsync_duration_secs',
    'network.dsoq.connection.opened',
  ], 'pins render in stored pin order');
});

test('SystemMetrics: a pinned series absent from the snapshot renders a dashed placeholder that can be unpinned', async t => {
  const el = await mountWorking(t);
  posted.length = 0;
  fromHost({
    type: 'sysMetrics.pins',
    pins: [{ key: 'ditto.network.dsoq.handshake_failed', labels: {} }],
  });
  await el.updateComplete;

  const row = el.shadowRoot!.querySelector('.pinned .mrow')!;
  assert.ok(row.classList.contains('idle'));
  assert.match(row.textContent ?? '', /handshake_failed/);
  assert.equal(row.querySelector('.mval')!.textContent?.trim(), '—');
  assert.match(row.textContent ?? '', /no data yet/);

  row.querySelector<HTMLButtonElement>('.pin-btn')!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pinned'), null, 'placeholder unpins itself');
  assert.deepEqual(posted.pop(), { type: 'sysMetrics.setPins', pins: [] });
});

// ─── Pinned reorder (drag and drop) ────────────────────────────

async function mountWithPins(t: { after(fn: () => void): void }, pins: unknown[]): Promise<Element> {
  const el = await mountWorking(t);
  fromHost({ type: 'sysMetrics.pins', pins });
  await el.updateComplete;
  return el;
}

const THREE_PINS = [
  { key: 'ditto.network.dsoq.connection.opened', labels: {} },
  { key: 'ditto.network.dsoq.connection.closed', labels: {} },
  { key: 'ditto.replication.session_resets', labels: { cause: 'handshake_timeout' } },
];

/** Dispatch one drag-gesture event on `target`. jsdom has no DragEvent or
 *  layout, so dataTransfer is a stub attached to a plain Event and the
 *  row rects are all zeros — `clientY` drives the before/after split:
 *  unset (undefined < 0+0/2 is false) means "below the midpoint", a
 *  negative value means "above" it. */
function fireDrag(target: HTMLElement, type: string, opts: { clientY?: number } = {}): void {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { setData() {}, getData: () => '', effectAllowed: '', dropEffect: '' },
  });
  if (opts.clientY !== undefined) { Object.assign(ev, { clientY: opts.clientY }); }
  target.dispatchEvent(ev);
}

function pinnedKeys(el: Element): (string | null)[] {
  return [...el.shadowRoot!.querySelectorAll('.pinned .mrow .mkey')].map(k => k.textContent);
}

test('SystemMetrics: dragging a pinned row onto another reorders and persists (drop below midpoint = after)', async t => {
  const el = await mountWithPins(t, THREE_PINS);
  posted.length = 0;
  const rows = () => [...el.shadowRoot!.querySelectorAll<HTMLElement>('.pinned .mrow')];

  // Every pinned row is draggable and carries the three-bars handle.
  for (const r of rows()) {
    assert.equal(r.getAttribute('draggable'), 'true');
    assert.ok(r.querySelector('.drag-handle .codicon-three-bars'));
  }

  // Drag "opened" onto "resets" (jsdom geometry → after) → [closed, resets, opened].
  fireDrag(rows()[0]!, 'dragstart');
  fireDrag(rows()[2]!, 'dragover');
  fireDrag(rows()[2]!, 'drop');
  fireDrag(rows()[0]!, 'dragend');
  await el.updateComplete;

  assert.deepEqual(pinnedKeys(el), [
    'network.dsoq.connection.closed',
    'replication.session_resets',
    'network.dsoq.connection.opened',
  ]);
  assert.deepEqual(posted.pop(), {
    type: 'sysMetrics.setPins',
    pins: [THREE_PINS[1], THREE_PINS[2], THREE_PINS[0]],
  }, 'the reordered list persists wholesale');
});

test('SystemMetrics: dropping above a row (negative clientY, i.e. its top half) inserts before it', async t => {
  const el = await mountWithPins(t, THREE_PINS);
  posted.length = 0;
  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.pinned .mrow')];

  // Drag "resets" onto the TOP half of "opened" → [resets, opened, closed].
  fireDrag(rows[2]!, 'dragstart');
  fireDrag(rows[0]!, 'dragover', { clientY: -1 });
  assert.ok(rows[0]!.classList.contains('drop-before'), 'the before indicator shows');
  fireDrag(rows[0]!, 'drop', { clientY: -1 });
  await el.updateComplete;

  assert.deepEqual(pinnedKeys(el), [
    'replication.session_resets',
    'network.dsoq.connection.opened',
    'network.dsoq.connection.closed',
  ]);
  assert.equal(rows[0]!.className.includes('drop-'), false, 'indicators cleared after the drop');
});

test('SystemMetrics: dragleave and dragend clear the drop indicators', async t => {
  const el = await mountWithPins(t, THREE_PINS);
  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.pinned .mrow')];

  fireDrag(rows[0]!, 'dragstart');
  assert.ok(rows[0]!.classList.contains('dragging'), 'source dims while dragging');
  fireDrag(rows[1]!, 'dragover');
  assert.ok(rows[1]!.classList.contains('drop-after'), 'below-midpoint default in zero-layout');
  fireDrag(rows[1]!, 'dragleave');
  assert.equal(rows[1]!.classList.contains('drop-after'), false);
  fireDrag(rows[0]!, 'dragend');
  assert.equal(rows[0]!.classList.contains('dragging'), false, 'dragend resets the source');
  assert.equal(el.shadowRoot!.querySelector('.drop-before, .drop-after'), null);
});

test('SystemMetrics: dropping a row onto itself is a no-op', async t => {
  const el = await mountWithPins(t, THREE_PINS);
  posted.length = 0;
  const row = el.shadowRoot!.querySelector<HTMLElement>('.pinned .mrow')!;
  fireDrag(row, 'dragstart');
  fireDrag(row, 'dragover'); // same row — not adopted as a target
  assert.equal(row.classList.contains('drop-before') || row.classList.contains('drop-after'), false);
  fireDrag(row, 'drop');
  await el.updateComplete;
  assert.deepEqual(posted, [], 'nothing persisted');
  assert.equal(pinnedKeys(el)[0], 'network.dsoq.connection.opened', 'order unchanged');
});

test('SystemMetrics: placeholder (no-data-yet) pins are draggable too', async t => {
  const el = await mountWithPins(t, [
    { key: 'ditto.network.dsoq.handshake_failed', labels: {} }, // no sample
    THREE_PINS[0],
  ]);
  posted.length = 0;
  const rows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.pinned .mrow')];
  assert.ok(rows[0]!.classList.contains('idle'), 'first pin is a placeholder');
  assert.equal(rows[0]!.getAttribute('draggable'), 'true');
  assert.ok(rows[0]!.querySelector('.drag-handle'));

  fireDrag(rows[0]!, 'dragstart');
  fireDrag(rows[1]!, 'dragover');
  fireDrag(rows[1]!, 'drop');
  await el.updateComplete;
  assert.deepEqual(pinnedKeys(el), [
    'network.dsoq.connection.opened',
    'network.dsoq.handshake_failed',
  ]);
});

test('SystemMetrics: master-list rows are never draggable', async t => {
  const el = await mountWithPins(t, THREE_PINS);
  const masterRows = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mrow')]
    .filter(r => !r.closest('.pinned'));
  assert.ok(masterRows.length > 0);
  for (const r of masterRows) {
    assert.equal(r.getAttribute('draggable'), null,
      `master row for ${r.querySelector('.mkey')?.textContent} is not a drag source`);
    assert.equal(r.querySelector('.drag-handle'), null, 'no handle');
  }
});

test('SystemMetrics: a pins push containing duplicates renders each series once', async t => {
  const el = await mountWorking(t);
  const a = { key: 'ditto.network.dsoq.connection.opened', labels: {} };
  fromHost({ type: 'sysMetrics.pins', pins: [THREE_PINS[1], a, THREE_PINS[1], a] });
  await el.updateComplete;
  assert.deepEqual(pinnedKeys(el), [
    'network.dsoq.connection.closed',
    'network.dsoq.connection.opened',
  ], 'duplicates collapse to a single row');
  assert.match(el.shadowRoot!.querySelector('.pinned')!.textContent ?? '', /Pinned\s+\(2\)/);
});

test('SystemMetrics: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  fromHost({ type: 'sysMetrics.status', status: { kind: 'working', snapshot: SYSTEM_SNAPSHOT } });
  await el.updateComplete;
  assert.equal(el.systemMetrics?.kind, 'working');

  host.remove();
  await el.updateComplete;
  fromHost({ type: 'sysMetrics.status', status: { kind: 'noConnection' } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.systemMetrics?.kind, 'working', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  fromHost({ type: 'sysMetrics.status', status: { kind: 'noConnection' } });
  await el.updateComplete;
  assert.equal(el.systemMetrics?.kind, 'noConnection');
});
