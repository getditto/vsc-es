import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

await import('../../../webview-ui/inspector/help-content-element.js');

/**
 * Help content element: fetches pre-rendered help HTML for the `uri`
 * property and injects it. Covers the placeholder, success, failure, and
 * the monotonic load counter that stops a superseded fetch from
 * overwriting newer content.
 *
 * The element calls the global `fetch`, resolved at call time, so each
 * test installs its own stub and restores the original afterwards.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
  uri: string;
  htmlContent: string;
  failed: boolean;
}

interface StubResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const realFetch = globalThis.fetch;

function stubFetch(t: { after(fn: () => void): void }, impl: (uri: string) => Promise<StubResponse>): string[] {
  const calls: string[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (uri: string) => {
    calls.push(uri);
    return impl(uri);
  };
  t.after(() => { (globalThis as unknown as { fetch: unknown }).fetch = realFetch; });
  return calls;
}

/** Flush the element's fire-and-forget load() promise chain. */
async function flush(el: Element): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  await el.updateComplete;
}

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ok = (body: string): StubResponse => ({ ok: true, status: 200, text: () => Promise.resolve(body) });

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<help-content-element></help-content-element>`, host);
  const el = host.querySelector('help-content-element') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

test('HelpContent: without a uri it shows the placeholder and never fetches', async t => {
  const calls = stubFetch(t, () => Promise.resolve(ok('<h1>x</h1>')));
  const { el } = await mount(t);
  assert.match(el.shadowRoot!.textContent ?? '', /Loading help…/);
  assert.equal(calls.length, 0);
});

test('HelpContent: setting uri fetches it and injects the HTML', async t => {
  const calls = stubFetch(t, () => Promise.resolve(ok('<h1 id="t">Query help</h1><p>body copy</p>')));
  const { el } = await mount(t);
  el.uri = 'https://webview.invalid/help/query.html';
  await flush(el);

  assert.deepEqual(calls, ['https://webview.invalid/help/query.html']);
  const injected = el.shadowRoot!.querySelector('h1#t')!;
  assert.ok(injected, 'bundled help HTML injected into the shadow root');
  assert.match(el.shadowRoot!.textContent ?? '', /body copy/);
});

test('HelpContent: a non-OK response renders the unavailable notice', async t => {
  stubFetch(t, () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }));
  const { el } = await mount(t);
  el.uri = 'https://webview.invalid/missing.html';
  await flush(el);

  assert.equal(el.failed, true);
  assert.match(el.shadowRoot!.textContent ?? '', /Help unavailable\./);
  assert.equal(el.htmlContent, '', 'no half-loaded content left behind');
});

test('HelpContent: a rejected fetch renders the unavailable notice', async t => {
  stubFetch(t, () => Promise.reject(new Error('network down')));
  const { el } = await mount(t);
  el.uri = 'https://webview.invalid/help.html';
  await flush(el);

  assert.equal(el.failed, true);
  assert.match(el.shadowRoot!.textContent ?? '', /Help unavailable\./);
});

test('HelpContent: clearing the uri resets to the placeholder', async t => {
  stubFetch(t, () => Promise.resolve(ok('<h1>loaded</h1>')));
  const { el } = await mount(t);
  el.uri = 'https://webview.invalid/help.html';
  await flush(el);
  assert.ok(el.shadowRoot!.querySelector('h1'));

  el.uri = '';
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Loading help…/);
  assert.equal(el.shadowRoot!.querySelector('h1'), null, 'injected content cleared');
  assert.equal(el.failed, false);
});

test('HelpContent: a late-resolving superseded fetch cannot overwrite newer content', async t => {
  const pending = new Map<string, ReturnType<typeof deferred<StubResponse>>>();
  stubFetch(t, uri => {
    const d = deferred<StubResponse>();
    pending.set(uri, d);
    return d.promise;
  });
  const { el } = await mount(t);

  el.uri = 'https://webview.invalid/a.html';
  await el.updateComplete;
  el.uri = 'https://webview.invalid/b.html';
  await el.updateComplete;
  assert.equal(pending.size, 2, 'both fetches in flight');

  pending.get('https://webview.invalid/b.html')!.resolve(ok('<p>newer</p>'));
  await flush(el);
  assert.match(el.shadowRoot!.textContent ?? '', /newer/);

  pending.get('https://webview.invalid/a.html')!.resolve(ok('<p>stale</p>'));
  await flush(el);
  assert.match(el.shadowRoot!.textContent ?? '', /newer/, 'stale resolution discarded');
  assert.equal(el.shadowRoot!.textContent?.includes('stale'), false);
});

test('HelpContent: a late-failing superseded fetch does not blank newer content', async t => {
  const pending = new Map<string, ReturnType<typeof deferred<StubResponse>>>();
  stubFetch(t, uri => {
    const d = deferred<StubResponse>();
    pending.set(uri, d);
    return d.promise;
  });
  const { el } = await mount(t);

  el.uri = 'https://webview.invalid/a.html';
  await el.updateComplete;
  el.uri = 'https://webview.invalid/b.html';
  await el.updateComplete;

  pending.get('https://webview.invalid/b.html')!.resolve(ok('<p>newer</p>'));
  await flush(el);
  pending.get('https://webview.invalid/a.html')!.reject(new Error('stale failure'));
  await flush(el);

  assert.match(el.shadowRoot!.textContent ?? '', /newer/, 'stale rejection discarded');
  assert.equal(el.failed, false);
  assert.equal(el.shadowRoot!.querySelector('.err'), null);
});

test('HelpContent: after a failure a new uri retries cleanly', async t => {
  let fail = true;
  stubFetch(t, () => fail
    ? Promise.reject(new Error('down'))
    : Promise.resolve(ok('<h1>recovered</h1>')));
  const { el } = await mount(t);

  el.uri = 'https://webview.invalid/a.html';
  await flush(el);
  assert.equal(el.failed, true);

  fail = false;
  el.uri = 'https://webview.invalid/b.html';
  await flush(el);
  assert.equal(el.failed, false);
  assert.match(el.shadowRoot!.textContent ?? '', /recovered/);
});
