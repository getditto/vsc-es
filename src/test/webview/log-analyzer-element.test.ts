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

/** jsdom has no ResizeObserver; log-table constructs one on connect. The
 *  throw is non-fatal (jsdom routes it to the virtual console), but the
 *  stub keeps the test output readable. */
(globalThis as any).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

await import('../../../webview-ui/logAnalyzer/log-analyzer-element.js');

/**
 * The Log Analyzer root element: owns the AnalyzerOut message listener, the
 * aggregate state derived from host diffs, and the windowed queryLines
 * requests that feed the virtualized table. These tests drive the panel the
 * way the host and the child components do — host→webview by dispatching
 * `message` events on window, webview→host by reading the recorded
 * postMessage traffic, child→root by dispatching the child's composed
 * CustomEvents.
 */

interface AnalyzerEl extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: AnalyzerEl }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-log-analyzer></ditto-log-analyzer>`, host);
  const el = host.querySelector('ditto-log-analyzer') as unknown as AnalyzerEl;
  await el.updateComplete;
  return { host, el };
}

/** A host→webview message, exactly as `vscode.postMessage` delivers it. */
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

function child(el: AnalyzerEl, sel: string): any {
  return el.shadowRoot!.querySelector(sel);
}

/** Round-trips through JSON: over postMessage a Date arrives as an ISO
 *  string, and the components must cope with that shape. */
function line(id: number, over: Record<string, unknown> = {}): any {
  return JSON.parse(JSON.stringify({
    id,
    timestamp: new Date(Date.UTC(2026, 5, 9, 14, 0, id)),
    level: 'info',
    tag: 'sdk',
    raw: '',
    text: `line ${id}`,
    ...over,
  }));
}

function summary(over: Record<string, unknown> = {}): any {
  return {
    type: 'analyzer.summary',
    counts: {
      critical: 2, errors: 5, warnings: 7, problems: 9,
      problemLines: 6, criticalLines: 2, totalLines: 123, unparseableLines: 1,
    },
    tags: ['sync', 'auth'],
    sdkVersion: '5.1.0',
    startTimeMs: Date.UTC(2026, 5, 9, 14, 0, 0),
    endTimeMs: Date.UTC(2026, 5, 9, 14, 0, 30),
    ...over,
  };
}

function problem(patternKey: string, severity: number, lineId = 1): any {
  return JSON.parse(JSON.stringify({
    patternKey,
    severity,
    recommendation: 'Fix it.',
    line: {
      id: lineId,
      timestamp: new Date('2026-06-09T14:00:00Z'),
      level: 'error',
      tag: 'sdk',
      raw: '',
      text: `hit on ${patternKey}`,
    },
  }));
}

test('LogAnalyzer: requests the first window of lines on connect', async t => {
  posted.length = 0;
  await mount(t);
  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'an initial queryLines was posted');
  assert.equal(q.filter, 'all');
  assert.equal(q.limit, 300, 'the table window is three 100-row chunks');
  assert.equal(q.offset, 0);
  assert.equal(q.search, undefined, 'empty search travels as undefined');
  assert.equal(typeof q.requestId, 'string');
});

test('LogAnalyzer: summary fills the header and tab badges, then re-queries', async t => {
  const { el } = await mount(t);
  posted.length = 0;
  fromHost(summary());
  await el.updateComplete;

  const header = child(el, 'summary-header');
  await header.updateComplete;
  const text = header.shadowRoot.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Critical: 2/);
  assert.match(text, /Errors: 5/);
  assert.match(text, /Warnings: 7/);
  assert.match(text, /Problems: 9/, 'header shows the occurrence count');
  assert.match(text, /Lines: 123/);
  assert.match(text, /SDK: 5\.1\.0/);
  assert.match(text, /Tags: sync, auth/);
  assert.match(text, /Range: 14:00:00 → 14:00:30 \(30s\)/);

  // Tab badges use the listable line counts (problemLines/criticalLines),
  // not the occurrence counts the header shows.
  const tabs = child(el, 'filter-tabs');
  await tabs.updateComplete;
  const badges = [...tabs.shadowRoot.querySelectorAll('.badge')].map((b: any) => b.textContent);
  assert.deepEqual(badges, ['123', '2', '5', '7', '6']);

  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'a counts diff re-queries the current window');
  assert.equal(q.filter, 'all');
});

test('LogAnalyzer: Range field compacts to minutes, hours, or n/a', async t => {
  const { el } = await mount(t);
  const t0 = Date.UTC(2026, 5, 9, 14, 0, 0);
  const header = child(el, 'summary-header');

  fromHost(summary({ startTimeMs: t0, endTimeMs: t0 + 5 * 60_000 }));
  await el.updateComplete;
  await header.updateComplete;
  assert.match(header.shadowRoot.textContent, /\(5m\)/);

  fromHost(summary({ startTimeMs: t0, endTimeMs: t0 + 90 * 60_000 }));
  await el.updateComplete;
  await header.updateComplete;
  assert.match(header.shadowRoot.textContent, /\(1\.5h\)/);

  fromHost(summary({ startTimeMs: null, endTimeMs: null }));
  await el.updateComplete;
  await header.updateComplete;
  assert.match(header.shadowRoot.textContent, /Range: n\/a/);
});

test('LogAnalyzer: problems are grouped by pattern, severity-sorted, capped per pattern', async t => {
  const { el } = await mount(t);
  // Lower-severity pattern first: the sort must still float severity 5 up.
  fromHost({ type: 'analyzer.problemsAdded', items: [problem('warn_pat', 2, 1)] });
  fromHost({ type: 'analyzer.problemsAdded', items: [problem('crit_pat', 5, 2), problem('crit_pat', 5, 3)] });
  await el.updateComplete;

  const groups = child(el, 'problems-list').groups;
  assert.deepEqual(groups.map((g: any) => g.key), ['crit_pat', 'warn_pat']);
  assert.equal(groups[0].items.length, 2, 'hits accumulate within a group');

  // The per-pattern cap mirrors the host's PROBLEM_CAP so the grouped map
  // can never grow for the life of the panel.
  const flood = Array.from({ length: 1100 }, (_, i) => problem('flood', 3, i));
  fromHost({ type: 'analyzer.problemsAdded', items: flood });
  await el.updateComplete;
  const floodGroup = child(el, 'problems-list').groups.find((g: any) => g.key === 'flood');
  assert.equal(floodGroup.items.length, 1000);
});

test('LogAnalyzer: analyzer.error surfaces a banner that reset clears', async t => {
  const { el } = await mount(t);
  fromHost({ type: 'analyzer.error', stage: 'backfill', message: 'cannot read log' });
  await el.updateComplete;
  const banner = el.shadowRoot!.querySelector('.banner');
  assert.ok(banner, 'banner rendered');
  assert.equal(banner.textContent, '[backfill] cannot read log');

  fromHost({ type: 'analyzer.reset' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.banner'), null, 'reset clears the banner');
});

test('LogAnalyzer: reset returns the panel to its empty state', async t => {
  const { el } = await mount(t);
  fromHost(summary());
  fromHost({ type: 'analyzer.problemsAdded', items: [problem('p', 4)] });
  fromHost({
    type: 'analyzer.histogramsUpdated',
    histograms: {
      volumeByLevel: [{ binStartMs: 0, counts: { error: 1, warn: 0, info: 0, debug: 0, trace: 0 } }],
      problemsOverTime: [{ binStartMs: 0, count: 1, maxSeverity: 4 }],
      connectionDurations: [{ binLabel: '<1s', count: 2 }],
    },
  });
  const q = lastPosted('analyzer.queryLines');
  fromHost({ type: 'analyzer.linesResult', requestId: q.requestId, items: [line(0)], offset: 0, total: 1 });
  await el.updateComplete;
  assert.match(el.shadowRoot!.querySelector('.result-info')!.textContent, /1 line\b/, 'singular');

  fromHost({ type: 'analyzer.reset' });
  await el.updateComplete;

  const header = child(el, 'summary-header');
  await header.updateComplete;
  assert.match(header.shadowRoot.textContent, /Loading…/);
  assert.deepEqual(child(el, 'problems-list').groups, []);
  assert.deepEqual(child(el, 'histograms-row').histograms, {
    volumeByLevel: [], problemsOverTime: [], connectionDurations: [],
  });
  const table = child(el, 'log-table');
  assert.equal(table.totalRows, 0);
  assert.equal(table.lines.length, 0);
  assert.equal(table.selectedId, null);
  assert.match(el.shadowRoot!.querySelector('.result-info')!.textContent, /0 lines/);
  assert.ok(child(el, 'line-detail-drawer').hasAttribute('hidden'), 'drawer closed');
});

test('LogAnalyzer: histogramsUpdated forwards the bins to the histogram row', async t => {
  const { el } = await mount(t);
  fromHost({
    type: 'analyzer.histogramsUpdated',
    histograms: {
      volumeByLevel: [{ binStartMs: 0, counts: { error: 1, warn: 1, info: 2, debug: 0, trace: 0 } }],
      problemsOverTime: [{ binStartMs: 0, count: 3, maxSeverity: 5 }],
      connectionDurations: [{ binLabel: '<1s', count: 2 }],
    },
  });
  await el.updateComplete;

  const row = child(el, 'histograms-row');
  assert.equal(row.histograms.problemsOverTime[0].maxSeverity, 5);
  const level = row.shadowRoot.querySelector('level-histogram');
  assert.equal(level.bins.length, 1);
  await level.updateComplete;
  assert.ok(level.shadowRoot.querySelectorAll('rect').length >= 3, 'one rect per non-zero level');
});

test('LogAnalyzer: sessionsUpdated is accepted and ignored', async t => {
  const { el } = await mount(t);
  fromHost({ type: 'analyzer.sessionsUpdated', sessions: [] });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.banner'), null, 'no error surfaced');
});

test('LogAnalyzer: honours only the latest linesResult and drops late responses', async t => {
  const { el } = await mount(t);
  const q = lastPosted('analyzer.queryLines');

  // A stale response (unknown requestId) must not touch the table.
  fromHost({ type: 'analyzer.linesResult', requestId: '999', items: [line(50)], offset: 0, total: 1 });
  await el.updateComplete;
  assert.equal(child(el, 'log-table').totalRows, 0);
  assert.match(el.shadowRoot!.querySelector('.result-info')!.textContent, /0 lines/);

  fromHost({ type: 'analyzer.linesResult', requestId: q.requestId, items: [line(0), line(1), line(2)], offset: 0, total: 3 });
  await el.updateComplete;
  const table = child(el, 'log-table');
  assert.equal(table.totalRows, 3);
  assert.equal(table.lines.length, 3);
  assert.equal(table.windowOffset, 0);
  assert.match(el.shadowRoot!.querySelector('.result-info')!.textContent, /3 lines/);
});

test('LogAnalyzer: switching filter tabs re-queries from the top of the new result set', async t => {
  const { el } = await mount(t);
  fromHost(summary());
  await el.updateComplete;
  posted.length = 0;

  const tabs = child(el, 'filter-tabs');
  await tabs.updateComplete;
  const errorsTab = [...tabs.shadowRoot.querySelectorAll('button.tab')]
    .find((b: any) => /Errors/.test(b.textContent)) as HTMLElement;
  errorsTab.click();
  await el.updateComplete;

  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'filter change issued a new query');
  assert.equal(q.filter, 'error');
  assert.equal(q.offset, 0, 'a new filter is a new result set — restart at the top');
  assert.equal(tabs.active, 'error');
  await tabs.updateComplete;
  const active = tabs.shadowRoot.querySelectorAll('button.tab.active');
  assert.equal(active.length, 1);
  assert.match(active[0].textContent, /Errors/);

  // Re-clicking the active tab is a no-op.
  posted.length = 0;
  errorsTab.click();
  await el.updateComplete;
  assert.equal(countPosted('analyzer.queryLines'), 0, 'same-tab click must not re-query');
});

test('LogAnalyzer: search input debounces, then re-queries with the search text', async t => {
  const { el } = await mount(t);
  posted.length = 0;

  const input = el.shadowRoot!.querySelector('input.search') as HTMLInputElement;
  input.value = 'sync stalled';
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;
  assert.equal(countPosted('analyzer.queryLines'), 0, 'debounced: no immediate query');

  await new Promise(r => setTimeout(r, 300));
  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'query fired after the debounce');
  assert.equal(q.search, 'sync stalled');
  assert.equal(q.offset, 0, 'a new search restarts at the top');
});

test('LogAnalyzer: toolbar buttons post pause/resume/clear/pattern-editor to the host', async t => {
  const { el } = await mount(t);
  posted.length = 0;
  const buttons = [...el.shadowRoot!.querySelectorAll('.toolbar button')] as HTMLElement[];
  assert.equal(buttons.length, 4);
  for (const b of buttons) { b.click(); }
  assert.deepEqual(
    posted.map(m => m.type),
    ['analyzer.pause', 'analyzer.resume', 'analyzer.clear', 'analyzer.openPatternEditor'],
  );
});

test('LogAnalyzer: clicking a row requests detail; the response opens the drawer', async t => {
  const { el } = await mount(t);
  posted.length = 0;

  const table = child(el, 'log-table');
  table.dispatchEvent(new CustomEvent('line-clicked', { detail: { lineId: 7 }, bubbles: true, composed: true }));
  await el.updateComplete;

  const req = lastPosted('analyzer.requestLineDetail');
  assert.ok(req, 'detail request posted');
  assert.equal(req.lineId, 7);
  assert.equal(table.selectedId, 7, 'the clicked row highlights as selected');

  const drawer = child(el, 'line-detail-drawer');
  assert.ok(drawer.hasAttribute('hidden'), 'drawer starts hidden');

  // A late/mismatched response is dropped.
  fromHost({ type: 'analyzer.lineDetail', requestId: '999', line: line(7), before: [], after: [] });
  await el.updateComplete;
  assert.ok(drawer.hasAttribute('hidden'), 'late detail response ignored');

  fromHost({
    type: 'analyzer.lineDetail',
    requestId: req.requestId,
    line: line(7, { level: 'error', text: 'boom' }),
    before: [line(6)],
    after: [line(8)],
  });
  await el.updateComplete;
  await drawer.updateComplete;
  assert.ok(!drawer.hasAttribute('hidden'), 'drawer opened');
  assert.match(drawer.shadowRoot.textContent, /boom/);

  drawer.dispatchEvent(new CustomEvent('drawer-close', { bubbles: true, composed: true }));
  await el.updateComplete;
  assert.ok(drawer.hasAttribute('hidden'), 'drawer closed again');
});

test("LogAnalyzer: a problem's reveal arrow drives the same detail flow as a row click", async t => {
  const { el } = await mount(t);
  fromHost({ type: 'analyzer.problemsAdded', items: [problem('p', 4, 42)] });
  await el.updateComplete;
  posted.length = 0;

  child(el, 'problems-list').dispatchEvent(
    new CustomEvent('reveal-line', { detail: { id: 42 }, bubbles: true, composed: true }),
  );
  await el.updateComplete;
  const req = lastPosted('analyzer.requestLineDetail');
  assert.ok(req, 'detail request posted');
  assert.equal(req.lineId, 42);
});

test('LogAnalyzer: refetches only when the visible range leaves the loaded window', async t => {
  const { el } = await mount(t);
  const q0 = lastPosted('analyzer.queryLines');
  fromHost({
    type: 'analyzer.linesResult',
    requestId: q0.requestId,
    items: Array.from({ length: 300 }, (_, i) => line(i)),
    offset: 0,
    total: 50_000,
  });
  await el.updateComplete;
  posted.length = 0;

  const table = child(el, 'log-table');
  // Inside the loaded window: no fetch.
  table.dispatchEvent(new CustomEvent('visible-range', { detail: { start: 10, end: 40 }, bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(countPosted('analyzer.queryLines'), 0, 'in-window range needs no fetch');

  // Outside: refetch a chunk-aligned window with a chunk of slack before it.
  table.dispatchEvent(new CustomEvent('visible-range', { detail: { start: 5000, end: 5040 }, bubbles: true, composed: true }));
  await el.updateComplete;
  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'out-of-window range refetched');
  assert.equal(q.offset, 4900, 'window start = floor(5000/100)*100 - one chunk of slack');

  // The same window again while in flight is deduped.
  posted.length = 0;
  table.dispatchEvent(new CustomEvent('visible-range', { detail: { start: 5001, end: 5041 }, bubbles: true, composed: true }));
  await el.updateComplete;
  assert.equal(countPosted('analyzer.queryLines'), 0, 'an in-flight window is not refetched per frame');
});

test('LogAnalyzer: a summary refresh re-queries the window already on screen', async t => {
  const { el } = await mount(t);
  const q0 = lastPosted('analyzer.queryLines');
  fromHost({ type: 'analyzer.linesResult', requestId: q0.requestId, items: [line(200)], offset: 200, total: 50_000 });
  await el.updateComplete;
  posted.length = 0;

  fromHost(summary());
  await el.updateComplete;
  const q = lastPosted('analyzer.queryLines');
  assert.ok(q, 'summary re-queried');
  assert.equal(q.offset, 200, 'a periodic refresh does not yank the user back to the top');
});

test('LogAnalyzer: ignores null and unknown host messages', async t => {
  const { el } = await mount(t);
  fromHost(null);
  fromHost({ type: 'analyzer.unborn' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.banner'), null, 'no error surfaced');
});

test('LogAnalyzer: ignores host messages while detached and resumes on re-attach', async t => {
  const { host, el } = await mount(t);

  fromHost(summary());
  await el.updateComplete;
  assert.ok((el as any).counts, 'summary processed while attached');

  // VS Code re-parents panels between editor groups: while detached the
  // element must not process host messages…
  host.remove();
  await el.updateComplete;
  fromHost({ type: 'analyzer.reset' });
  await new Promise(r => setTimeout(r, 0));
  assert.ok((el as any).counts, 'detached element must not process host messages');

  // …and a re-attach must re-subscribe exactly once.
  document.body.appendChild(host);
  await el.updateComplete;
  fromHost({ type: 'analyzer.reset' });
  await el.updateComplete;
  assert.equal((el as any).counts, null, 'resumed after re-attach');
});

test('LogAnalyzer: disconnecting with a pending search cancels the debounce', async t => {
  const { host, el } = await mount(t);
  posted.length = 0;

  const input = el.shadowRoot!.querySelector('input.search') as HTMLInputElement;
  input.value = 'stalled';
  input.dispatchEvent(new Event('input'));
  host.remove();

  await new Promise(r => setTimeout(r, 300));
  assert.equal(countPosted('analyzer.queryLines'), 0, 'pending debounce was cleared on disconnect');
});
