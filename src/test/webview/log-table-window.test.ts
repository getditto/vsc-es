import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { render, html } from 'lit';
import '../../../webview-ui/logAnalyzer/components/log-table.js';
import type { LogLine } from '../../logAnalyzer/types.js';

/**
 * The table is virtualised to roughly a viewport, so it must be fed a window
 * rather than the whole result set — the host used to ship 1000 rows per query
 * and re-query on every summary diff, ~25x more than could ever be painted.
 *
 * jsdom performs no layout, so `clientHeight` is 0 and the element's
 * ResizeObserver never supplies a real viewport height. The tests set
 * `viewportHeight` directly, which is what layout would have produced.
 */

const ROW_HEIGHT = 22; // must match log-table's constant

function lines(from: number, count: number): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    id: from + i,
    timestamp: null,
    level: 'info' as const,
    tag: 'sdk',
    raw: `line ${from + i}`,
    text: `line ${from + i}`,
  }));
}

interface TableEl extends HTMLElement {
  lines: LogLine[];
  windowOffset: number;
  totalRows: number;
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{
  el: TableEl;
  ranges: { start: number; end: number }[];
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<log-table></log-table>`, host);
  const el = host.querySelector('log-table') as unknown as TableEl;
  const ranges: { start: number; end: number }[] = [];
  el.addEventListener('visible-range', (e) => {
    ranges.push((e as CustomEvent).detail as { start: number; end: number });
  });
  // Stand in for layout: ~20 visible rows.
  (el as unknown as { viewportHeight: number }).viewportHeight = 20 * ROW_HEIGHT;
  await el.updateComplete;
  return { el, ranges };
}

/** jsdom's scroll does not fire natively; set the position and dispatch. */
async function scrollTo(el: TableEl, top: number): Promise<void> {
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true });
  el.dispatchEvent(new Event('scroll'));
  // reportVisibleRange coalesces to one report per frame; setup maps rAF to a
  // macrotask, so let it drain.
  await new Promise(r => setTimeout(r, 0));
  await el.updateComplete;
}

test('LogTable: sizes the scroll area to the whole result set, not the window', async t => {
  const { el } = await mount(t);
  el.lines = lines(0, 300);
  el.windowOffset = 0;
  el.totalRows = 50_000;
  await el.updateComplete;

  const spacer = el.shadowRoot!.querySelector('.spacer') as HTMLElement;
  assert.equal(
    spacer.style.height, `${50_000 * ROW_HEIGHT}px`,
    'the scrollbar must reflect all matching rows, or the user cannot reach them',
  );
});

test('LogTable: paints only a viewport of rows out of a large total', async t => {
  const { el } = await mount(t);
  el.lines = lines(0, 300);
  el.windowOffset = 0;
  el.totalRows = 50_000;
  await el.updateComplete;

  const rows = el.shadowRoot!.querySelectorAll('.spacer .row');
  assert.ok(rows.length > 0, 'something is painted');
  assert.ok(rows.length <= 40, `painted ${rows.length} rows for a 20-row viewport`);
});

test('LogTable: positions rows by absolute index, so a window renders in place', async t => {
  const { el } = await mount(t);
  // A window from the middle of the result set.
  el.lines = lines(1000, 300);
  el.windowOffset = 1000;
  el.totalRows = 50_000;
  await el.updateComplete;
  await scrollTo(el, 1000 * ROW_HEIGHT);

  const first = el.shadowRoot!.querySelector('.spacer .row') as HTMLElement;
  assert.ok(first, 'a row is painted');
  const top = Number.parseInt(first.style.top, 10);
  assert.ok(
    top >= 1000 * ROW_HEIGHT - 40 * ROW_HEIGHT,
    `row placed at ${top}px; a window rendered at window-relative offsets would sit near 0`,
  );
  assert.match(first.textContent ?? '', /line 1\d\d\d/, 'and shows a row from that window');
});

test('LogTable: reports the absolute range it needs on scroll', async t => {
  const { el, ranges } = await mount(t);
  el.lines = lines(0, 300);
  el.windowOffset = 0;
  el.totalRows = 50_000;
  await el.updateComplete;

  await scrollTo(el, 5_000 * ROW_HEIGHT);

  const last = ranges[ranges.length - 1];
  assert.ok(last, 'a range was reported');
  assert.ok(last.start <= 5_000 && last.start >= 5_000 - 40, `start ${last.start} tracks the scroll`);
  assert.ok(last.end > last.start && last.end <= 5_000 + 60, `end ${last.end} is a viewport, not the total`);
});

test('LogTable: coalesces a scroll burst into one report per frame', async t => {
  const { el, ranges } = await mount(t);
  el.lines = lines(0, 300);
  el.windowOffset = 0;
  el.totalRows = 50_000;
  await el.updateComplete;
  ranges.length = 0;

  // A real scroll gesture fires far more often than the window can change.
  for (let i = 0; i < 25; i++) {
    Object.defineProperty(el, 'scrollTop', { value: i * ROW_HEIGHT, writable: true, configurable: true });
    el.dispatchEvent(new Event('scroll'));
  }
  await new Promise(r => setTimeout(r, 0));

  assert.equal(ranges.length, 1, `25 scroll events produced ${ranges.length} reports`);
});

test('LogTable: rows outside the loaded window are simply not painted', async t => {
  // The owner refetches when the range leaves the window; for the frame or two
  // before that lands, the gap must render as blank rather than as wrong rows.
  const { el } = await mount(t);
  el.lines = lines(0, 300);
  el.windowOffset = 0;
  el.totalRows = 50_000;
  await el.updateComplete;
  await scrollTo(el, 10_000 * ROW_HEIGHT);

  const rows = el.shadowRoot!.querySelectorAll('.spacer .row');
  assert.equal(rows.length, 0, 'no rows from the stale window are shown at the new position');
});

test('LogTable: an empty result set shows the empty state, not a blank scroll area', async t => {
  const { el } = await mount(t);
  el.lines = [];
  el.windowOffset = 0;
  el.totalRows = 0;
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No lines match the current filter/);
});
