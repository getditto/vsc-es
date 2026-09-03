import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

/**
 * <json-viewer> drives a REAL CodeMirror EditorView in these tests. Upstream
 * practice in this repo (inspector-query-panes.test.ts) no-ops setupView
 * because EditorView needs browser globals jsdom doesn't install on
 * globalThis. Those globals are stubbed locally below — MutationObserver,
 * Node, Range & friends from the jsdom window — which is enough for
 * EditorView to construct, measure (degenerate zero-size layout), decorate,
 * and destroy cleanly. Nothing here touches the shared setup.
 *
 * What this buys over the no-op: the selection StateField (range → line
 * decorations), the value/ranges/selectedIndex update pipeline, the wrap
 * compartment, and the destroy/recreate lifecycle all run for real.
 */
const g = globalThis as Record<string, unknown>;
for (const key of [
  'MutationObserver', 'DocumentFragment', 'Element', 'Node', 'NodeFilter',
  'Range', 'Text', 'Comment', 'DOMParser',
] as const) {
  g[key] ??= (g.window as Record<string, unknown>)[key];
}

await import('../../../webview-ui/shared/json-viewer.js');

interface Viewer extends HTMLElement {
  updateComplete: Promise<unknown>;
  value: string;
  ranges: { from: number; to: number }[];
  selectedIndex: number;
  wrap: boolean;
}

/** Two top-level objects, matching the Query Editor's page serialisation. */
const DOC = '[\n  {\n    "a": 1\n  },\n  {\n    "b": 2\n  }\n]';

function mount(t: { after(fn: () => void): void }): Viewer {
  const el = document.createElement('json-viewer') as unknown as Viewer;
  document.body.appendChild(el);
  t.after(() => el.remove());
  return el;
}

/** Decorations land on the DOM in CodeMirror's measure pass, which the
 *  setup's rAF stub schedules on a 0ms timer — updateComplete alone is not
 *  enough. */
async function settle(el: Viewer): Promise<void> {
  await el.updateComplete;
  await new Promise(r => setTimeout(r, 25));
}

function viewOf(el: Viewer): any {
  return (el as any).view;
}

function selectedLines(el: Viewer): string[] {
  return [...el.querySelectorAll('.cm-doc-selected')].map(n => n.textContent ?? '');
}

test('JsonViewer: mounts a real CodeMirror with the initial value', async t => {
  const el = mount(t);
  el.value = DOC;
  await settle(el);

  const view = viewOf(el);
  assert.ok(view, 'EditorView constructed');
  assert.equal(view.state.doc.toString(), DOC);
  assert.ok(el.querySelector('.cm-editor'), 'editor DOM lives in the light root');
  assert.ok(el.querySelector('.cm-gutters'), 'line-number gutter rendered');
  assert.equal(el.querySelectorAll('.cm-line').length, 8, 'one .cm-line per document line');
});

test('JsonViewer: changing value re-flows the document', async t => {
  const el = mount(t);
  el.value = DOC;
  await settle(el);

  el.value = '{"replaced":true}';
  await settle(el);
  assert.equal(viewOf(el).state.doc.toString(), '{"replaced":true}');
  assert.match(el.querySelector('.cm-content')!.textContent ?? '', /replaced/);
});

test('JsonViewer: setting the identical value dispatches nothing', async t => {
  const el = mount(t);
  el.value = DOC;
  await settle(el);

  const view = viewOf(el);
  let dispatches = 0;
  const realDispatch = view.dispatch.bind(view);
  view.dispatch = (...args: unknown[]) => { dispatches++; return realDispatch(...args); };

  el.value = DOC;
  await settle(el);
  assert.equal(dispatches, 0, 'identical content short-circuits before dispatch');

  el.value = DOC + '\n';
  await settle(el);
  assert.ok(dispatches > 0, 'a real change still flows');
});

test('JsonViewer: selectedIndex highlights exactly the lines of that range', async t => {
  const el = mount(t);
  el.value = DOC;
  // Second top-level object: from its opening '{' to its closing '}'.
  const from = DOC.indexOf('{', DOC.indexOf('{') + 1);
  const to = DOC.indexOf('}', from) + 1;
  el.ranges = [{ from: 2, to: DOC.indexOf('}') + 1 }, { from, to }];
  el.selectedIndex = 1;
  await settle(el);

  const lines = selectedLines(el);
  assert.deepEqual(lines, ['  {', '    "b": 2', '  }'], 'the range spans exactly three lines');

  el.selectedIndex = -1;
  await settle(el);
  assert.deepEqual(selectedLines(el), [], '-1 clears the highlight');
});

test('JsonViewer: an out-of-bounds selectedIndex decorates nothing', async t => {
  const el = mount(t);
  el.value = DOC;
  el.ranges = [{ from: 2, to: 5 }];
  el.selectedIndex = 9;
  await settle(el);
  assert.deepEqual(selectedLines(el), []);
});

test('JsonViewer: ranges selected before connect are applied once the editor mounts', async t => {
  const el = document.createElement('json-viewer') as unknown as Viewer;
  t.after(() => el.remove());
  // Set everything BEFORE the element ever connects: connectedCallback's
  // early setupView runs with no .cm-host yet, and firstUpdated must pick
  // up the initial ranges/selection itself.
  el.value = DOC;
  el.ranges = [{ from: 0, to: DOC.length }];
  el.selectedIndex = 0;
  document.body.appendChild(el);
  await settle(el);

  assert.ok(viewOf(el), 'editor created on firstUpdated');
  assert.equal(selectedLines(el).length, 8, 'the whole document is one highlighted range');
});

test('JsonViewer: a range that outlives a document shrink is clamped, not fatal', async t => {
  const el = mount(t);
  el.value = DOC;
  el.ranges = [{ from: 40, to: 50 }];
  el.selectedIndex = 0;
  await settle(el);

  // Shrink the doc out from under the range: lineAt() clamps to the new
  // document length and the decoration lands on the last line.
  el.value = '[1]';
  await settle(el);
  assert.equal(viewOf(el).state.doc.toString(), '[1]');
  assert.equal(selectedLines(el).length, 1, 'clamped range decorates the single remaining line');
});

test('JsonViewer: wrap reconfigures the wrapping compartment both ways', async t => {
  const el = mount(t);
  el.value = DOC;
  await settle(el);
  assert.ok(!viewOf(el).contentDOM.classList.contains('cm-lineWrapping'), 'nowrap by default');

  el.wrap = true;
  await settle(el);
  assert.ok(viewOf(el).contentDOM.classList.contains('cm-lineWrapping'));

  el.wrap = false;
  await settle(el);
  assert.ok(!viewOf(el).contentDOM.classList.contains('cm-lineWrapping'));
});

test('JsonViewer: a click inside a range emits documentSelected; outside stays silent', async t => {
  const el = mount(t);
  el.value = DOC;
  el.ranges = [{ from: 0, to: 10 }];
  await settle(el);

  const hits: number[] = [];
  el.addEventListener('documentSelected', e => hits.push((e as CustomEvent).detail.index));

  // (0,0) lands on document position 0, which range 0 covers.
  viewOf(el).contentDOM.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
  assert.deepEqual(hits, [0]);

  // Ranges that don't cover position 0 swallow the same click.
  el.ranges = [{ from: 20, to: 30 }];
  await settle(el);
  viewOf(el).contentDOM.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
  assert.deepEqual(hits, [0], 'no range under the cursor → no event');
});

test('JsonViewer: disconnect destroys the editor; reconnect rebuilds it with live state', async t => {
  const el = mount(t);
  el.value = DOC;
  el.ranges = [{ from: 0, to: DOC.length }];
  el.selectedIndex = 0;
  await settle(el);
  const first = viewOf(el);
  assert.ok(first);

  // VS Code re-parents webview panels between editor groups: the editor
  // must not stay dead after the move.
  el.remove();
  assert.equal(viewOf(el), undefined, 'EditorView destroyed on disconnect');
  assert.equal(el.querySelector('.cm-editor'), null, 'editor DOM torn down');

  document.body.appendChild(el);
  await settle(el);
  assert.ok(viewOf(el), 'a fresh EditorView was built on reconnect');
  assert.notEqual(viewOf(el), first);
  assert.equal(viewOf(el).state.doc.toString(), DOC, 'current value survives the rebuild');
  assert.equal(selectedLines(el).length, 8, 'selection decorations are re-applied too');
});
