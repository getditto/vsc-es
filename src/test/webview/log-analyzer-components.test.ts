import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

// Side-effect imports register the custom elements. These components are
// pure presentation — none of them import messaging.ts, so no vscode API
// stub is needed here.
await import('../../../webview-ui/logAnalyzer/components/collapsible-section.js');
await import('../../../webview-ui/logAnalyzer/components/duration-histogram.js');
await import('../../../webview-ui/logAnalyzer/components/filter-tabs.js');
await import('../../../webview-ui/logAnalyzer/components/source-tabs.js');
await import('../../../webview-ui/logAnalyzer/components/histograms-row.js');
await import('../../../webview-ui/logAnalyzer/components/line-detail-drawer.js');
await import('../../../webview-ui/logAnalyzer/components/problems-histogram.js');
await import('../../../webview-ui/logAnalyzer/components/summary-header.js');

/** Mount an element by tag with properties assigned pre-connect, and clean
 *  it up when the test finishes. */
async function mount(
  t: { after(fn: () => void): void },
  tag: string,
  props: Record<string, unknown> = {},
): Promise<any> {
  const el = document.createElement(tag) as any;
  Object.assign(el, props);
  document.body.appendChild(el);
  t.after(() => el.remove());
  await el.updateComplete;
  return el;
}

/** Round-trips through JSON: over postMessage a Date arrives as an ISO
 *  string, and the components must cope with that shape. */
function detailLine(over: Record<string, unknown> = {}): any {
  return JSON.parse(JSON.stringify({
    id: 9,
    timestamp: new Date('2026-06-09T14:00:00Z'),
    level: 'error',
    tag: 'sdk',
    raw: '',
    text: 'something failed badly',
    ...over,
  }));
}

// ─── collapsible-section ─────────────────────────────────────────────

test('CollapsibleSection: body is visible while open and a header click collapses it', async t => {
  const el = await mount(t, 'collapsible-section', { heading: 'Summary' });
  const content = document.createElement('span');
  content.textContent = 'inner content';
  el.appendChild(content);
  await el.updateComplete;

  assert.ok(el.shadowRoot.querySelector('.body'), 'body rendered while open');
  assert.ok(el.shadowRoot.querySelector('.chevron').classList.contains('open'));
  assert.match(el.shadowRoot.textContent, /Summary/);
  // Slotted content lives in the light DOM, not the shadow tree.
  assert.match(el.textContent, /inner content/, 'slot content shows');

  el.shadowRoot.querySelector('.header').click();
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.body'), null, 'collapsed hides the body');
  assert.ok(!el.shadowRoot.querySelector('.chevron').classList.contains('open'));

  el.shadowRoot.querySelector('.header').click();
  await el.updateComplete;
  assert.ok(el.shadowRoot.querySelector('.body'), 'second click re-opens');
});

test('CollapsibleSection: honours the open property arriving as false', async t => {
  const el = await mount(t, 'collapsible-section', { heading: 'H', isOpen: false });
  assert.equal(el.shadowRoot.querySelector('.body'), null, 'starts collapsed');
  assert.ok(!el.shadowRoot.querySelector('.chevron').classList.contains('open'));
});

// ─── duration-histogram ──────────────────────────────────────────────

test('DurationHistogram: empty and all-zero bins show the placeholder', async t => {
  const el = await mount(t, 'duration-histogram');
  assert.match(el.shadowRoot.textContent, /No closed sessions yet/);

  el.bins = [{ binLabel: '<1s', count: 0 }, { binLabel: '1–10s', count: 0 }];
  await el.updateComplete;
  assert.match(el.shadowRoot.textContent, /No closed sessions yet/, 'all-zero counts still placeholder');
});

test('DurationHistogram: bars scale to the largest bin', async t => {
  const el = await mount(t, 'duration-histogram', {
    bins: [
      { binLabel: '<1s', count: 2 },
      { binLabel: '1–10s', count: 4 },
      { binLabel: '10s–1m', count: 1 },
    ],
  });
  const rows = [...el.shadowRoot.querySelectorAll('.row')];
  assert.equal(rows.length, 3);
  const widths = rows.map((r: any) => r.querySelector('.bar').style.width);
  assert.deepEqual(widths, ['50%', '100%', '25%']);
  const labels = rows.map((r: any) => r.querySelector('.label').textContent);
  assert.deepEqual(labels, ['<1s', '1–10s', '10s–1m']);
  const counts = rows.map((r: any) => r.querySelectorAll('.label')[1].textContent);
  assert.deepEqual(counts, ['2', '4', '1']);
});

// ─── filter-tabs ─────────────────────────────────────────────────────

test('FilterTabs: renders five tabs with badges from the counts bag', async t => {
  const el = await mount(t, 'filter-tabs', {
    counts: { critical: 1, errors: 2, warnings: 3, problems: 4, totalLines: 100 },
  });
  const tabs = [...el.shadowRoot.querySelectorAll('.tab')];
  assert.equal(tabs.length, 5);
  const badges = tabs.map((b: any) => b.querySelector('.badge').textContent);
  assert.deepEqual(badges, ['100', '1', '2', '3', '4']);
  assert.ok(tabs[0].classList.contains('active'), 'All tab active by default');
  assert.ok(tabs[1].classList.contains('crit'));
  assert.ok(tabs[2].classList.contains('err'));
  assert.ok(tabs[3].classList.contains('warn'));
});

test('FilterTabs: clicking a tab emits filter-change; the active class follows the property', async t => {
  const el = await mount(t, 'filter-tabs', { active: 'all' });
  const seen: string[] = [];
  el.addEventListener('filter-change', (e: any) => seen.push(e.detail.key));

  const tabs = [...el.shadowRoot.querySelectorAll('.tab')];
  tabs[4].click();
  tabs[1].click();
  assert.deepEqual(seen, ['problem', 'critical']);

  el.active = 'warn';
  await el.updateComplete;
  const active = el.shadowRoot.querySelectorAll('.tab.active');
  assert.equal(active.length, 1);
  assert.match(active[0].textContent, /Warnings/);
});

// ─── source-tabs ─────────────────────────────────────────────────────

test('SourceTabs: renders the three sources; only the event streams carry badges', async t => {
  const el = await mount(t, 'source-tabs', {
    sourceCounts: { transport: 7, connectionRequests: 2 },
  });
  const tabs = [...el.shadowRoot.querySelectorAll('.tab')];
  assert.deepEqual(tabs.map((b: any) => b.textContent.trim()), [
    'Logs', 'Transport Conditions7', 'Connection Requests2',
  ]);
  assert.ok(tabs[0].classList.contains('active'), 'Logs tab active by default');
});

test('SourceTabs: clicking a tab emits source-change; the active class follows the property', async t => {
  const el = await mount(t, 'source-tabs', { active: 'all' });
  const seen: string[] = [];
  el.addEventListener('source-change', (e: any) => seen.push(e.detail.key));

  const tabs = [...el.shadowRoot.querySelectorAll('.tab')];
  tabs[1].click();
  tabs[2].click();
  assert.deepEqual(seen, ['transport', 'connectionRequests']);

  el.active = 'connectionRequests';
  await el.updateComplete;
  const active = el.shadowRoot.querySelectorAll('.tab.active');
  assert.equal(active.length, 1);
  assert.match(active[0].textContent, /Connection Requests/);
});

// ─── histograms-row ──────────────────────────────────────────────────

test('HistogramsRow: forwards each histogram slice to its child component', async t => {
  const el = await mount(t, 'histograms-row', {
    histograms: {
      volumeByLevel: [
        { binStartMs: 0, counts: { error: 1, warn: 0, info: 2, debug: 0, trace: 0 } },
        { binStartMs: 1000, counts: { error: 0, warn: 1, info: 1, debug: 0, trace: 0 } },
      ],
      problemsOverTime: [{ binStartMs: 0, count: 3, maxSeverity: 5 }],
      connectionDurations: [{ binLabel: '<1s', count: 2 }],
    },
  });
  const text = el.shadowRoot.textContent;
  assert.match(text, /Log Volume by Level/);
  assert.match(text, /Problems over Time/);
  assert.match(text, /Connection Durations/);

  const level = el.shadowRoot.querySelector('level-histogram');
  const problems = el.shadowRoot.querySelector('problems-histogram');
  const durations = el.shadowRoot.querySelector('duration-histogram');
  assert.equal(level.bins.length, 2);
  assert.equal(problems.bins.length, 1);
  assert.equal(durations.bins.length, 1);

  await level.updateComplete;
  await problems.updateComplete;
  await durations.updateComplete;
  assert.ok(level.shadowRoot.querySelectorAll('rect').length >= 3, 'level histogram painted');
  assert.equal(problems.shadowRoot.querySelectorAll('rect').length, 1);
  assert.equal(durations.shadowRoot.querySelectorAll('.row').length, 1);
});

test('HistogramsRow: empty histograms render every child placeholder', async t => {
  const el = await mount(t, 'histograms-row');
  const level = el.shadowRoot.querySelector('level-histogram');
  const problems = el.shadowRoot.querySelector('problems-histogram');
  const durations = el.shadowRoot.querySelector('duration-histogram');
  await level.updateComplete;
  await problems.updateComplete;
  await durations.updateComplete;
  assert.match(level.shadowRoot.textContent, /No volume data yet/);
  assert.match(problems.shadowRoot.textContent, /No problems yet/);
  assert.match(durations.shadowRoot.textContent, /No closed sessions yet/);
});

// ─── line-detail-drawer ──────────────────────────────────────────────

test('LineDetailDrawer: null line shows the empty state', async t => {
  const el = await mount(t, 'line-detail-drawer');
  assert.match(el.shadowRoot.textContent, /No line selected/);
  assert.match(el.shadowRoot.textContent, /Log line detail/, 'header still rendered');
});

test('LineDetailDrawer: renders timestamp, level, tag, user tags and message', async t => {
  const el = await mount(t, 'line-detail-drawer', {
    line: detailLine({ userTags: ['query', 'auth'] }),
    beforeLines: [detailLine({ id: 8 })],
    afterLines: [detailLine({ id: 10 })],
  });
  const text = el.shadowRoot.textContent.replace(/\s+/g, ' ');
  assert.match(text, /2026-06-09T14:00:00.000Z/, 'timestamp carried as a string renders');
  assert.match(text, /ERROR/);
  assert.match(text, /sdk/);
  assert.match(text, /query/);
  assert.match(text, /auth/);
  assert.match(text, /something failed badly/);
  const pill = el.shadowRoot.querySelector('.level-pill');
  assert.ok(pill.classList.contains('lvl-error'));
  assert.equal(el.shadowRoot.querySelectorAll('.user-tag-chip').length, 2);
});

test('LineDetailDrawer: missing timestamp and tag render as placeholders', async t => {
  const el = await mount(t, 'line-detail-drawer', {
    line: detailLine({ timestamp: null, tag: null }),
  });
  const text = el.shadowRoot.textContent.replace(/\s+/g, ' ');
  assert.match(text, /—/, 'em-dash for a missing timestamp');
  assert.match(text, /\(no tag\)/);
  assert.equal(el.shadowRoot.querySelector('.user-tag-chip'), null);
  assert.ok(!text.includes('User tags'), 'no User tags row without userTags');
});

test('LineDetailDrawer: close button emits drawer-close', async t => {
  const el = await mount(t, 'line-detail-drawer', { line: detailLine() });
  let closed = 0;
  el.addEventListener('drawer-close', () => { closed++; });
  el.shadowRoot.querySelector('.close').click();
  assert.equal(closed, 1);
});

// ─── problems-histogram ──────────────────────────────────────────────

test('ProblemsHistogram: empty bins show the placeholder', async t => {
  const el = await mount(t, 'problems-histogram');
  assert.match(el.shadowRoot.textContent, /No problems yet/);
});

test('ProblemsHistogram: one rect per bin, colored by severity, normalized to the busiest', async t => {
  const el = await mount(t, 'problems-histogram', {
    bins: [
      { binStartMs: 0, count: 1, maxSeverity: 2 },
      { binStartMs: 1000, count: 3, maxSeverity: 5 },
      { binStartMs: 2000, count: 2, maxSeverity: 99 },
    ],
  });
  const rects = [...el.shadowRoot.querySelectorAll('rect')];
  assert.equal(rects.length, 3);
  assert.equal(rects[0].getAttribute('fill'), '#4ea1ff');
  assert.equal(rects[1].getAttribute('fill'), '#ff5252');
  assert.equal(rects[2].getAttribute('fill'), '#888', 'unknown severity falls back to grey');

  // Heights normalize to the busiest bin (count=3 → full height at y=0).
  assert.equal(rects[1].getAttribute('height'), '100');
  assert.equal(rects[1].getAttribute('y'), '0');
  assert.ok(Math.abs(Number(rects[0].getAttribute('height')) - 100 / 3) < 1e-9);

  // Bins share the 100-unit row evenly.
  assert.equal(rects[0].getAttribute('x'), '0');
  assert.ok(Math.abs(Number(rects[1].getAttribute('x')) - 100 / 3) < 1e-9);
});

// ─── summary-header ──────────────────────────────────────────────────

test('SummaryHeader: null counts shows the loading placeholder', async t => {
  const el = await mount(t, 'summary-header');
  assert.match(el.shadowRoot.textContent, /Loading…/);
});

test('SummaryHeader: renders counts, sdk, tags and range', async t => {
  const el = await mount(t, 'summary-header', {
    counts: {
      critical: 1, errors: 2, warnings: 3, problems: 4,
      problemLines: 3, criticalLines: 1, totalLines: 55, unparseableLines: 0,
    },
    tags: ['sync', 'auth'],
    sdkVersion: '5.1.0',
    sessionRange: '14:00:00 → 14:00:30 (30s)',
  });
  const text = el.shadowRoot.textContent.replace(/\s+/g, ' ');
  for (const frag of [
    'Critical: 1', 'Errors: 2', 'Warnings: 3', 'Problems: 4', 'Lines: 55',
    'SDK: 5.1.0', 'Tags: sync, auth', 'Range: 14:00:00 → 14:00:30 (30s)',
  ]) {
    assert.ok(text.includes(frag), `missing fragment: ${frag}`);
  }
});

test('SummaryHeader: absent metadata falls back to unknown / none / n/a', async t => {
  const el = await mount(t, 'summary-header', {
    counts: {
      critical: 0, errors: 0, warnings: 0, problems: 0,
      problemLines: 0, criticalLines: 0, totalLines: 0, unparseableLines: 0,
    },
  });
  const text = el.shadowRoot.textContent.replace(/\s+/g, ' ');
  assert.match(text, /SDK: unknown/);
  assert.match(text, /Tags: none/);
  assert.match(text, /Range: n\/a/);
});
