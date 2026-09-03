import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

await import('../../../webview-ui/shared/result-table-element.js');

/**
 * <ditto-result-table>: the generic rows+columns renderer the Query Editor
 * pages through. Selection state is owned by the parent; the table emits
 * `row-selected` / `row-activated` / `row-context-menu` with ABSOLUTE
 * indices (pageOffset + page-local index). These tests pin the cell
 * formatting matrix (null/undefined/object/primitive, 120-char truncation)
 * and the event contract.
 */

interface Table extends HTMLElement {
  updateComplete: Promise<unknown>;
  rows: Record<string, unknown>[];
  columns: string[];
  selectedRowIndex: number | null;
  pageOffset: number;
}

async function mount(
  t: { after(fn: () => void): void },
  props: Partial<{ rows: Record<string, unknown>[]; columns: string[]; selectedRowIndex: number | null; pageOffset: number }> = {},
): Promise<Table> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-result-table></ditto-result-table>`, host);
  const el = host.querySelector('ditto-result-table') as unknown as Table;
  if (props.rows) { el.rows = props.rows; }
  if (props.columns) { el.columns = props.columns; }
  if (props.selectedRowIndex !== undefined) { el.selectedRowIndex = props.selectedRowIndex; }
  if (props.pageOffset !== undefined) { el.pageOffset = props.pageOffset; }
  await el.updateComplete;
  return el;
}

function rows_(el: Table): HTMLElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('tbody tr')];
}

function cells_(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('td')];
}

test('ResultTable: an empty row set renders the placeholder, not a table', async t => {
  const el = await mount(t, { rows: [], columns: ['a'] });
  assert.match(el.shadowRoot!.textContent ?? '', /No rows\./);
  assert.equal(el.shadowRoot!.querySelector('table'), null);
});

test('ResultTable: headers come from columns and primitives render verbatim', async t => {
  const el = await mount(t, {
    columns: ['name', 'count', 'ok', 'big'],
    rows: [{ name: 'alpha', count: 42, ok: true, big: 10n }],
  });
  const heads = [...el.shadowRoot!.querySelectorAll('th')].map(h => h.textContent);
  assert.deepEqual(heads, ['name', 'count', 'ok', 'big']);
  const cells = cells_(rows_(el)[0]!).map(c => c.textContent);
  assert.deepEqual(cells, ['alpha', '42', 'true', '10']);
  assert.ok(!rows_(el)[0]!.classList.contains('selected'));
  assert.equal(rows_(el)[0]!.getAttribute('aria-selected'), 'false');
});

test('ResultTable: null and undefined cells render italic nullish text', async t => {
  const el = await mount(t, {
    columns: ['a', 'b', 'c'],
    rows: [{ a: null /* b absent → undefined */, c: 'x' }],
  });
  const cells = cells_(rows_(el)[0]!);
  assert.equal(cells[0]!.textContent, 'null');
  assert.equal(cells[0]!.title, 'null');
  assert.ok(cells[0]!.classList.contains('nullish'));
  assert.equal(cells[1]!.textContent, 'undefined');
  assert.ok(cells[1]!.classList.contains('nullish'));
  assert.equal(cells[2]!.textContent, 'x');
  assert.ok(!cells[2]!.classList.contains('nullish'), 'real text is not styled nullish');
});

test('ResultTable: objects render as JSON and truncate at 120 chars with the full value in the title', async t => {
  const small = { k: [1, 2] };
  const big = { k: 'x'.repeat(200) };
  const el = await mount(t, { columns: ['small', 'big'], rows: [{ small, big }] });
  const cells = cells_(rows_(el)[0]!);

  assert.equal(cells[0]!.textContent, JSON.stringify(small));
  assert.equal(cells[0]!.title, JSON.stringify(small));

  const full = JSON.stringify(big);
  assert.equal(cells[1]!.textContent, full.slice(0, 120) + '…');
  assert.equal(cells[1]!.title, full, 'the untruncated JSON survives on the tooltip');
});

test('ResultTable: a long primitive string truncates the same way', async t => {
  const s = 'y'.repeat(150);
  const el = await mount(t, { columns: ['s'], rows: [{ s }] });
  const cell = cells_(rows_(el)[0]!)[0]!;
  assert.equal(cell.textContent, 'y'.repeat(120) + '…');
  assert.equal(cell.title, s);
});

test('ResultTable: a value JSON.stringify cannot represent renders empty', async t => {
  // A function value: the object branch is skipped (typeof === 'function'),
  // JSON.stringify returns undefined, and the ?? '' fallback kicks in.
  const el = await mount(t, { columns: ['f'], rows: [{ f: () => 1 }] });
  const cell = cells_(rows_(el)[0]!)[0]!;
  assert.equal(cell.textContent, '');
  assert.equal(cell.title, '');
});

test('ResultTable: the selected row highlights by absolute index', async t => {
  const el = await mount(t, {
    columns: ['id'],
    rows: [{ id: 'r0' }, { id: 'r1' }, { id: 'r2' }],
    selectedRowIndex: 1,
  });
  const rows = rows_(el);
  assert.deepEqual(rows.map(r => r.classList.contains('selected')), [false, true, false]);
  assert.equal(rows[1]!.getAttribute('aria-selected'), 'true');

  el.selectedRowIndex = null;
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('tr.selected'), null, 'clearing selection clears the highlight');
});

test('ResultTable: click emits row-selected with the absolute index and pretty rowJson', async t => {
  const row = { id: 'r1', n: 2 };
  const el = await mount(t, {
    columns: ['id', 'n'],
    rows: [{ id: 'r0', n: 1 }, row],
    pageOffset: 100,
  });
  const events: CustomEvent[] = [];
  el.addEventListener('row-selected', e => events.push(e as CustomEvent));

  rows_(el)[1]!.click();
  assert.equal(events.length, 1);
  const d = events[0]!.detail;
  assert.equal(d.absIndex, 101, 'pageOffset + page-local index');
  assert.deepEqual(d.row, row);
  assert.equal(d.rowJson, JSON.stringify(row, null, 2), 'rowJson is the pretty-printed row');
  assert.equal(d.event, undefined, 'no mouse event rides on a plain selection');
});

test('ResultTable: double-click emits row-activated', async t => {
  const el = await mount(t, { columns: ['id'], rows: [{ id: 'r0' }, { id: 'r1' }] });
  const events: CustomEvent[] = [];
  el.addEventListener('row-activated', e => events.push(e as CustomEvent));

  rows_(el)[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.detail.absIndex, 0);
});

test('ResultTable: right-click emits row-context-menu carrying the mouse event, and prevents the default menu', async t => {
  const el = await mount(t, { columns: ['id'], rows: [{ id: 'r0' }] });
  const events: CustomEvent[] = [];
  el.addEventListener('row-context-menu', e => events.push(e as CustomEvent));

  const e = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 30, clientY: 40 });
  rows_(el)[0]!.dispatchEvent(e);
  assert.equal(events.length, 1);
  assert.equal(e.defaultPrevented, true, 'the browser context menu is suppressed');
  assert.equal(events[0]!.detail.absIndex, 0);
  assert.equal(events[0]!.detail.event, e, 'the originating mouse event travels in the detail');
});
