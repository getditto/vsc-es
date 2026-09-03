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

await import('../../../webview-ui/databaseMetrics/database-metrics-element.js');

/**
 * HostMessages wiring for the Database Metrics panel: consume while
 * attached, stay silent while detached (panel re-parenting between editor
 * groups), resume on re-attach.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  view: { kind: string };
}

const SNAPSHOT = {
  storeBytes: 1024,
  replicationBytes: 0,
  attachmentsBytes: 0,
  authBytes: 0,
  walShmBytes: 0,
  logsBytes: 0,
  otherBytes: 0,
  collectionBreakdown: [],
  collectionPayloadBytes: 512,
  totalDiskBytes: 1536,
  computedAt: Date.now(),
};

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-database-metrics></ditto-database-metrics>`, host);
  const el = host.querySelector('ditto-database-metrics') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

test('DatabaseMetrics: renders a snapshot pushed by the host', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.snapshot', snapshot: SNAPSHOT },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'loaded');
  assert.match(el.shadowRoot!.textContent ?? '', /1\.5 KB/, 'header shows total on disk');
});

test('DatabaseMetrics: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.snapshot', snapshot: SNAPSHOT },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'loaded');

  host.remove();
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.error', message: 'stale failure' },
  }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.view.kind, 'loaded', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.error', message: 'disk unreadable' },
  }));
  await el.updateComplete;
  assert.equal(el.view.kind, 'error');
});

// ─── System metrics section (SDK 5.1 system:metrics) ───────────

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
      key: 'ditto.replication.session_resets',
      labels: { cause: 'handshake_timeout' }, description: 'Resets', unit: 'count', kind: 'counter',
      sinceConnect: 2, periodDelta: 0,
    },
  ],
  sinceMs: Date.now() - 60_000,
  polledAtMs: Date.now(),
  pollIntervalMs: 5000,
};

test('DatabaseMetrics: a working system:metrics snapshot renders all three dashboard sections', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.systemMetrics', status: { kind: 'working', snapshot: SYSTEM_SNAPSHOT } },
  }));
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /System metrics/);
  assert.match(text, /DSOQ network/);
  assert.match(text, /SQLite per database role/);
  assert.match(text, /Replication recovery/);
  assert.match(text, /db=main/, 'sqlite series broken down by db label');
  assert.match(text, /cause=handshake_timeout/, 'recovery series carries its cause label');
});

test('DatabaseMetrics: diverging opened/closed totals surface the leak alert', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.systemMetrics', status: { kind: 'working', snapshot: SYSTEM_SNAPSHOT } },
  }));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /diverge/, 'opened 12 vs closed 10 → divergence banner');
});

test('DatabaseMetrics: converged opened/closed totals render no alert', async t => {
  const { el } = await mount(t);
  const snapshot = {
    ...SYSTEM_SNAPSHOT,
    samples: SYSTEM_SNAPSHOT.samples.map(s =>
      s.key.endsWith('connection.closed') ? { ...s, sinceConnect: 12 } : s),
  };
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.systemMetrics', status: { kind: 'working', snapshot } },
  }));
  await el.updateComplete;
  assert.equal(/diverge/.test(el.shadowRoot!.textContent ?? ''), false);
});

test('DatabaseMetrics: the exporter disabled state shows enable-and-reconnect guidance', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.systemMetrics', status: { kind: 'exporterDisabled' } },
  }));
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /exporter is off for this connection/);
  assert.match(text, /collectSystemMetrics/);
  assert.match(text, /reconnect/i);
});

test('DatabaseMetrics: setting-off and no-connection states are distinct guidance', async t => {
  const { el } = await mount(t);
  const dispatch = (status: unknown) => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dbMetrics.systemMetrics', status },
  }));

  dispatch({ kind: 'settingDisabled' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /System metrics are disabled.*collectSystemMetrics/s);

  dispatch({ kind: 'noConnection' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No active connection/);

  dispatch({ kind: 'unavailable', message: 'unknown collection system:metrics' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /unavailable: unknown collection system:metrics/);
});
