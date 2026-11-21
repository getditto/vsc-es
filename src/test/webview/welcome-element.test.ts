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

await import('../../../webview-ui/welcome/welcome-element.js');

/**
 * First-run onboarding. The contract is one inbound message — `welcome.init`
 * flips the copy between "first run" and "reference" modes — and three
 * outbound CTAs (register a database, clone a quickstart, close). Every
 * section renders unconditionally, so the surface worth pinning is the mode
 * flip, the exact outbound message each CTA posts, and the HostMessages
 * lifecycle across VS Code's panel re-parenting.
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  posted.length = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-welcome></ditto-welcome>`, host);
  const el = host.querySelector('ditto-welcome') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function init(hasExistingDatabases: boolean, version = '9.9.9-test'): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'welcome.init', hasExistingDatabases, version },
  }));
}

function button(el: Element, label: string): HTMLButtonElement {
  const btn = [...el.shadowRoot!.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').includes(label));
  assert.ok(btn, `button containing "${label}" exists`);
  return btn;
}

function postedTypes(): string {
  return posted.map(m => (m as { type?: string }).type ?? '<no type>').join(', ');
}

test('Welcome: first run renders the tour copy with all three CTAs', async t => {
  const { el } = await mount(t);
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /quick tour of what this extension does/);
  assert.match(text, /Get started in three steps/);
  button(el, 'Register Database');
  button(el, 'Maybe later');
  button(el, 'Get Quickstarts');
});

test('Welcome: welcome.init with existing databases switches to reference copy', async t => {
  const { el } = await mount(t);
  init(true);
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /quick reference for the Ditto extension/);
  assert.match(text, /Adding another connection/);
  assert.doesNotMatch(text, /Get started in three steps/);
  button(el, 'Close');
  assert.ok(!text.includes('Maybe later'), 'the first-run dismissal is gone in reference mode');
});

test('Welcome: welcome.init without databases keeps the first-run copy', async t => {
  const { el } = await mount(t);
  init(false);
  await el.updateComplete;
  const text = el.shadowRoot!.textContent ?? '';
  assert.match(text, /Get started in three steps/);
  assert.match(text, /quick tour/);
  button(el, 'Maybe later');
});

test('Welcome: renders the installed extension version in the footer', async t => {
  const { el } = await mount(t);
  init(false, '0.9.6');
  await el.updateComplete;

  const footer = el.shadowRoot!.querySelector('.version-footer');
  assert.ok(footer, 'the version footer is rendered');
  assert.equal(footer.textContent?.trim(), 'Ditto Edge Studio v0.9.6');
});

test('Welcome: the footer sits below the learn-more strip', async t => {
  const { el } = await mount(t);
  init(false, '0.9.6');
  await el.updateComplete;

  const footer = el.shadowRoot!.querySelector('.version-footer');
  const learnMore = el.shadowRoot!.querySelector('.learn-more');
  assert.ok(footer && learnMore, 'both the learn-more strip and the footer render');
  // The footer is the last rendered block, so the version is always at the
  // bottom of the panel without scrolling.
  const blocks = [...el.shadowRoot!.children].filter(c => !(c as HTMLElement).tagName.includes('STYLE'));
  assert.equal(blocks[blocks.length - 1], footer, 'the version footer is the last element on the panel');
  assert.ok(
    blocks.indexOf(footer) > blocks.indexOf(learnMore),
    'the footer sits below the learn-more strip',
  );
});

test('Welcome: no footer is rendered before the host init arrives', async t => {
  const { el } = await mount(t);

  assert.equal(el.shadowRoot!.querySelector('.version-footer'), null,
    'the footer waits for the host rather than rendering an empty version');
});

test('Welcome: Register Database posts welcome.registerDatabase', async t => {
  const { el } = await mount(t);
  button(el, 'Register Database').click();
  await el.updateComplete;
  assert.deepEqual(posted, [{ type: 'welcome.registerDatabase' }], `saw ${postedTypes()}`);
});

test('Welcome: the secondary CTA posts welcome.close in both modes', async t => {
  const { el } = await mount(t);
  button(el, 'Maybe later').click();
  await el.updateComplete;
  assert.deepEqual(posted, [{ type: 'welcome.close' }], `saw ${postedTypes()}`);

  init(true);
  await el.updateComplete;
  posted.length = 0;
  button(el, 'Close').click();
  await el.updateComplete;
  assert.deepEqual(posted, [{ type: 'welcome.close' }], 'reference-mode Close posts the same message');
});

test('Welcome: Get Quickstarts posts welcome.getQuickstarts', async t => {
  const { el } = await mount(t);
  button(el, 'Get Quickstarts').click();
  await el.updateComplete;
  assert.deepEqual(posted, [{ type: 'welcome.getQuickstarts' }], `saw ${postedTypes()}`);
});

test('Welcome: renders all eight feature cards', async t => {
  const { el } = await mount(t);
  const cards = [...el.shadowRoot!.querySelectorAll('.feature')];
  assert.equal(cards.length, 8);
  const titles = cards.map(c => c.querySelector('.feature-title')?.textContent);
  assert.ok(titles.includes('Multiple connections'));
  assert.ok(titles.includes('DQL Query Editor'));
  assert.ok(titles.includes('Presence Graph'));
});

test('Welcome: links out to the docs and the quickstart repo', async t => {
  const { el } = await mount(t);
  const hrefs = new Set([...el.shadowRoot!.querySelectorAll('a')].map(a => a.getAttribute('href')));
  // Exact-match membership via Set.has — Array#includes with a URL literal
  // trips CodeQL's incomplete-URL-substring heuristic even though this is an
  // equality check, not sanitization.
  for (const url of [
    'https://docs.ditto.live/home/about-ditto',
    'https://github.com/getditto/quickstart',
    'https://docs.ditto.live/dql/dql',
  ]) {
    assert.ok(hrefs.has(url), `missing link ${url}`);
  }
});

test('Welcome: ignores host messages while detached and resumes on re-attach', async t => {
  // VS Code re-parents webview panels between editor groups: the element must
  // not process host messages while detached, and exactly one handler must
  // come back live on re-attach.
  const { host, el } = await mount(t);
  init(true);
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Adding another connection/);

  host.remove();
  await el.updateComplete;
  init(false);
  await new Promise(r => setTimeout(r, 0));
  assert.match(el.shadowRoot!.textContent ?? '', /Adding another connection/,
    'detached element must not process host messages');

  document.body.appendChild(host);
  await el.updateComplete;
  init(false);
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Get started in three steps/,
    'a dropped re-subscribe would leave the stale reference copy rendered');
});
