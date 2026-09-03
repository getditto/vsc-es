import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** Posted-to-host recorder; the api must exist before the element module
 *  runs — `messaging.ts` calls acquireVsCodeApi() at import time and holds
 *  the result. */
const postedToHost: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { postedToHost.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/debugConsole/debug-console-element.js');

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  conn: { state: string; pathWarning?: string };
  runs: unknown[];
  shadowRoot: ShadowRoot | null;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  postedToHost.length = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-debug-console></ditto-debug-console>`, host);
  const el = host.querySelector('ditto-debug-console') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function hostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

test('DebugConsole: the live-mutation warning banner is always rendered', async (t) => {
  const { el } = await mount(t);
  const banner = el.shadowRoot!.querySelector('.warning-banner');
  assert.ok(banner, 'warning banner missing');
  assert.match(banner.textContent ?? '', /not a\s+sandbox/i);
});

test('DebugConsole: connect button posts the trimmed socket path', async (t) => {
  const { el } = await mount(t);
  const input = el.shadowRoot!.querySelector('.connect-bar input') as HTMLInputElement;
  input.value = '  /tmp/app-debug.sock  ';
  input.dispatchEvent(new Event('input'));
  await el.updateComplete;

  const button = [...el.shadowRoot!.querySelectorAll('.connect-bar button')][0] as HTMLButtonElement;
  assert.equal(button.disabled, false);
  button.click();

  assert.deepEqual(postedToHost, [{ type: 'debugConsole.connect', path: '/tmp/app-debug.sock' }]);
});

test('DebugConsole: host state messages drive the pill and input disablement', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connecting' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pill')!.textContent, 'Connecting…');
  assert.ok((el.shadowRoot!.querySelector('.connect-bar input') as HTMLInputElement).disabled);

  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pill')!.textContent, 'Connected');
  assert.match(el.shadowRoot!.textContent ?? '', /Disconnect/);

  hostMessage({ type: 'debugConsole.state', state: 'disconnected', error: 'socket closed' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.pill')!.textContent, 'Disconnected');
  assert.match(el.shadowRoot!.textContent ?? '', /socket closed/);
});

test('DebugConsole: pathWarning renders as a non-blocking alert', async (t) => {
  const { el } = await mount(t);
  hostMessage({
    type: 'debugConsole.state',
    state: 'connecting',
    pathWarning: 'This path is 120 bytes — macOS limits Unix socket paths to 104 bytes.',
  });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /104 bytes/);
});

test('DebugConsole: run is posted on click and the runResult renders a table', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  await el.updateComplete;

  const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'SELECT * FROM cars';
  textarea.dispatchEvent(new Event('input'));
  await el.updateComplete;
  const runButton = [...el.shadowRoot!.querySelectorAll('button')]
    .find(b => b.textContent === 'Run') as HTMLButtonElement;
  runButton.click();
  assert.deepEqual(postedToHost, [{ type: 'debugConsole.run', statement: 'SELECT * FROM cars' }]);

  hostMessage({
    type: 'debugConsole.runResult',
    run: {
      statement: 'SELECT * FROM cars',
      ok: true,
      rows: [{ _id: 'abc', make: 'Toyota', year: 2020 }, { _id: 'def', make: 'Toyota', year: 2023 }],
      totalRowCount: 2,
      truncated: false,
      durationMs: 7,
    },
  });
  await el.updateComplete;

  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /2 items · 7 ms/);
  const headers = [...el.shadowRoot!.querySelectorAll('th')].map(h => h.textContent);
  assert.deepEqual(headers, ['_id', 'make', 'year']);
  assert.match(text, /Toyota/);
});

test('DebugConsole: Enter runs, Shift+Enter does not', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  await el.updateComplete;

  const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'SELECT 1';
  textarea.dispatchEvent(new Event('input'));
  await el.updateComplete;

  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  assert.deepEqual(postedToHost, [], 'Shift+Enter must not run');

  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, cancelable: true }));
  assert.deepEqual(postedToHost, [{ type: 'debugConsole.run', statement: 'SELECT 1' }]);
});

test('DebugConsole: an error runResult renders in the run card', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  hostMessage({
    type: 'debugConsole.runResult',
    run: {
      statement: 'SELECT *** FROM cars',
      ok: false,
      error: 'Parse error: unexpected token `*`',
      totalRowCount: 0,
      truncated: false,
      durationMs: 3,
    },
  });
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /Parse error: unexpected token/);
  assert.match(text, /failed · 3 ms/);
});

test('DebugConsole: truncation indicator distinguishes shown vs total', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  hostMessage({
    type: 'debugConsole.runResult',
    run: {
      statement: 'SELECT * FROM cars',
      ok: true,
      rows: [{ n: 1 }],
      totalRowCount: 15000,
      truncated: true,
      durationMs: 42,
    },
  });
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /15,000 items/);
  assert.match(text, /first 1 of 15,000/);
});

test('DebugConsole: history is newest-first and bounded at 50 runs', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  for (let i = 1; i <= 55; i++) {
    hostMessage({
      type: 'debugConsole.runResult',
      run: { statement: `SELECT ${i}`, ok: true, rows: [], totalRowCount: 0, truncated: false, durationMs: 1 },
    });
  }
  await el.updateComplete;
  const statements = [...el.shadowRoot!.querySelectorAll('.run .statement')].map(s => s.textContent);
  assert.equal(statements.length, 50);
  assert.equal(statements[0], 'SELECT 55', 'newest first');
  assert.equal(statements.at(-1), 'SELECT 6', 'oldest beyond the cap evicted');
});

test('DebugConsole: a dropped connection clears the running flag so Run re-arms', async (t) => {
  const { el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  await el.updateComplete;
  const textarea = el.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement;
  textarea.value = 'SELECT 1';
  textarea.dispatchEvent(new Event('input'));
  await el.updateComplete;
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  assert.equal(postedToHost.length, 1);

  // The socket dies mid-run: no runResult will ever arrive. Reconnecting
  // must not leave the button stuck on "Running…".
  hostMessage({ type: 'debugConsole.state', state: 'disconnected', error: 'closed' });
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/app.sock' });
  await el.updateComplete;
  const runButton = [...el.shadowRoot!.querySelectorAll('button')]
    .find(b => b.textContent === 'Run' || b.textContent === 'Running…') as HTMLButtonElement;
  assert.equal(runButton.textContent, 'Run');
});

test('DebugConsole: ignores host messages while detached and resumes on re-attach', async (t) => {
  const { host, el } = await mount(t);
  hostMessage({ type: 'debugConsole.state', state: 'connected', path: '/tmp/a.sock' });
  await el.updateComplete;
  assert.equal(el.conn.state, 'connected');

  host.remove();
  await el.updateComplete;
  hostMessage({ type: 'debugConsole.state', state: 'disconnected', error: 'stale' });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(el.conn.state, 'connected', 'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  hostMessage({ type: 'debugConsole.state', state: 'disconnected', error: 'for real' });
  await el.updateComplete;
  assert.equal(el.conn.state, 'disconnected');
});
