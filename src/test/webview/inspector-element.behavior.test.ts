import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. postMessage is
 *  recorded so tab clicks can be asserted against the exact IPC payload. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/inspector/inspector-element.js');

/**
 * Behavior coverage for the Inspector router beyond the HostMessages
 * attach/detach contract (inspector-element.test.ts): every content kind,
 * every query/observer tab body, tab-click IPC, the helpUri merge, the
 * preferences pass-through, and the collectMetrics gate (including the
 * forced History flip when metrics is switched off under the user's feet).
 */

interface Element extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function mount(t: { after(fn: () => void): void }): Promise<{ host: HTMLElement; el: Element }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-inspector></ditto-inspector>`, host);
  const el = host.querySelector('ditto-inspector') as unknown as Element;
  await el.updateComplete;
  return { host, el };
}

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function pushContent(content: Record<string, unknown>): void {
  send({ type: 'inspector.contentChanged', content });
}

function tabs(el: Element): HTMLElement[] {
  return [...el.shadowRoot!.querySelectorAll<HTMLElement>('.tabs .tab')];
}

test('Inspector: every help-based content kind renders help-content-element with its pushed uri', async t => {
  const { el } = await mount(t);
  const kinds: Array<[string, string]> = [
    ['subscriptions', 'subscription'],
    ['peers', 'presence'],
    ['metrics', 'metrics'],
    ['databaseMetrics', 'databaseMetrics'],
    ['logAnalyzer', 'logAnalyzer'],
    ['patternEditor', 'patternEditor'],
  ];
  // Push two help uris up front so the spread-merge is observable: pushes
  // for later kinds must not drop these.
  send({ type: 'inspector.helpHtml', kind: 'subscription', uri: 'https://docs/sub' });
  send({ type: 'inspector.helpHtml', kind: 'presence', uri: 'https://docs/presence' });
  const expected: Record<string, string> = {
    subscription: 'https://docs/sub',
    presence: 'https://docs/presence',
  };
  for (const [kind, uriKey] of kinds) {
    if (!(uriKey in expected)) {
      send({ type: 'inspector.helpHtml', kind: uriKey, uri: `https://docs/${uriKey}` });
      expected[uriKey] = `https://docs/${uriKey}`;
    }
    pushContent({ kind, databaseId: 'db1' });
    await el.updateComplete;
    const help = el.shadowRoot!.querySelector('help-content-element') as unknown as { uri: string };
    assert.ok(help, `kind ${kind} renders a help-content-element`);
    assert.equal(help.uri, expected[uriKey], `kind ${kind} uses helpUris.${uriKey}`);
  }
  // The merge retained the earliest pushes.
  pushContent({ kind: 'subscriptions', databaseId: 'db1' });
  await el.updateComplete;
  assert.equal(
    (el.shadowRoot!.querySelector('help-content-element') as unknown as { uri: string }).uri,
    'https://docs/sub',
    'a later helpHtml push for another kind does not clobber earlier entries',
  );
});

test('Inspector: help-based kinds fall back to an empty uri before any helpHtml push', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'patternEditor' });
  await el.updateComplete;
  const help = el.shadowRoot!.querySelector('help-content-element') as unknown as { uri: string };
  assert.ok(help);
  assert.equal(help.uri, '', 'no helpHtml pushed yet → ?? "" branch');
});

test('Inspector: query content renders all five tabs with codicons when metrics collection is on', async t => {
  const { el } = await mount(t);
  send({ type: 'inspector.settings', collectMetrics: true });
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;

  const buttons = tabs(el);
  assert.equal(buttons.length, 5, 'history favorites json metrics help');
  assert.deepEqual(buttons.map(b => b.title), ['history', 'favorites', 'json', 'metrics', 'help']);
  const icons = buttons.map(b => b.querySelector('.codicon')!.className);
  assert.ok(icons.some(c => c.includes('codicon-history')));
  assert.ok(icons.some(c => c.includes('codicon-star')));
  assert.ok(icons.some(c => c.includes('codicon-json')));
  assert.ok(icons.some(c => c.includes('codicon-dashboard')));
  assert.ok(icons.some(c => c.includes('codicon-question')));

  const selected = buttons.filter(b => b.getAttribute('aria-selected') === 'true');
  assert.deepEqual(selected.map(b => b.title), ['history'], 'only the active tab is selected');
});

test('Inspector: each query tab renders its body element with the routed state', async t => {
  const { el } = await mount(t);
  send({ type: 'inspector.historyChanged', entries: [{ id: 'h1', dql: 'SELECT 1' }] });
  send({ type: 'inspector.favoritesChanged', entries: [{ id: 'f1', dql: 'SELECT 2' }] });
  send({ type: 'inspector.preferences', hideLimitHint: true });
  send({ type: 'inspector.helpHtml', kind: 'query', uri: 'https://docs/query' });

  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  const history = el.shadowRoot!.querySelector('query-history-element') as unknown as { entries: unknown[] };
  assert.ok(history, 'history tab body');
  assert.equal(history.entries.length, 1, 'historyChanged entries flow to the body');

  pushContent({ kind: 'query', databaseId: 'db1', tab: 'favorites' });
  await el.updateComplete;
  const favorites = el.shadowRoot!.querySelector('query-favorites-element') as unknown as { entries: unknown[] };
  assert.ok(favorites, 'favorites tab body');
  assert.equal(favorites.entries.length, 1, 'favoritesChanged entries flow to the body');

  pushContent({ kind: 'query', databaseId: 'db1', tab: 'json', selectedRowJson: '{"a":1}' });
  await el.updateComplete;
  const json = el.shadowRoot!.querySelector('query-json-element') as unknown as { json: string };
  assert.ok(json, 'json tab body');
  assert.equal(json.json, '{"a":1}', 'selectedRowJson is passed through');

  const metadata = { dql: 'SELECT 1', durationMs: 3 };
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'metrics', lastResultMetadata: metadata });
  await el.updateComplete;
  const metrics = el.shadowRoot!.querySelector('query-metrics-element') as unknown as {
    metadata: unknown; hideLimitHint: boolean;
  };
  assert.ok(metrics, 'metrics tab body');
  assert.deepEqual(metrics.metadata, metadata, 'lastResultMetadata is passed through');
  assert.equal(metrics.hideLimitHint, true, 'preferences.hideLimitHint is passed through');

  pushContent({ kind: 'query', databaseId: 'db1', tab: 'help' });
  await el.updateComplete;
  const help = el.shadowRoot!.querySelector('help-content-element') as unknown as { uri: string };
  assert.ok(help, 'help tab body');
  assert.equal(help.uri, 'https://docs/query');
});

test('Inspector: history/favorites pushes with no entries field fall back to empty arrays', async t => {
  const { el } = await mount(t);
  send({ type: 'inspector.historyChanged', entries: [{ id: 'h1' }] });
  send({ type: 'inspector.historyChanged' });
  send({ type: 'inspector.favoritesChanged' });
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  const history = el.shadowRoot!.querySelector('query-history-element') as unknown as { entries: unknown[] };
  assert.deepEqual(history.entries, [], 'entries ?? [] on a missing entries field');

  pushContent({ kind: 'query', databaseId: 'db1', tab: 'favorites' });
  await el.updateComplete;
  const favorites = el.shadowRoot!.querySelector('query-favorites-element') as unknown as { entries: unknown[] };
  assert.deepEqual(favorites.entries, []);
});

test('Inspector: clicking a tab posts inspector.tabSelected with that tab', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  posted.length = 0;

  const jsonTab = tabs(el).find(b => b.title === 'json')!;
  jsonTab.click();
  assert.deepEqual(posted, [{ type: 'inspector.tabSelected', tab: 'json' }]);

  const helpTab = tabs(el).find(b => b.title === 'help')!;
  helpTab.click();
  assert.deepEqual(posted, [
    { type: 'inspector.tabSelected', tab: 'json' },
    { type: 'inspector.tabSelected', tab: 'help' },
  ]);
});

test('Inspector: turning metrics off removes the tab; turning it back on restores it', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  assert.equal(tabs(el).length, 5, 'default settings collect metrics');

  send({ type: 'inspector.settings', collectMetrics: false });
  await el.updateComplete;
  assert.deepEqual(tabs(el).map(b => b.title), ['history', 'favorites', 'json', 'help'],
    'metrics tab filtered out');

  send({ type: 'inspector.settings', collectMetrics: true });
  await el.updateComplete;
  assert.equal(tabs(el).length, 5, 'metrics tab restored');
});

test('Inspector: turning metrics off while the metrics tab is selected flips back to history', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'metrics' });
  await el.updateComplete;
  posted.length = 0;

  send({ type: 'inspector.settings', collectMetrics: false });
  await el.updateComplete;
  assert.deepEqual(posted, [{ type: 'inspector.tabSelected', tab: 'history' }],
    'the doomed tab is vacated via the normal tabSelected IPC');

  // The host answers tabSelected with a contentChanged echo — simulate it,
  // then a redundant settings push must not flip again.
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  posted.length = 0;
  send({ type: 'inspector.settings', collectMetrics: false });
  await el.updateComplete;
  assert.deepEqual(posted, [], 'already off the metrics tab → no redundant flip');

  // Metrics ON while sitting on the metrics tab: nothing to flip.
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'metrics' });
  await el.updateComplete;
  send({ type: 'inspector.settings', collectMetrics: true });
  await el.updateComplete;
  assert.deepEqual(posted, [], 'enabling metrics never forces a tab switch');
});

test('Inspector: metrics-off does not flip a non-query content kind', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'peers', databaseId: 'db1' });
  await el.updateComplete;
  posted.length = 0;
  send({ type: 'inspector.settings', collectMetrics: false });
  await el.updateComplete;
  assert.deepEqual(posted, [], 'no query tab selected → nothing to vacate');
  assert.ok(el.shadowRoot!.querySelector('help-content-element'), 'peers body still rendered');
});

test('Inspector: observers content renders its json/help tabs and posts observer tab selections', async t => {
  const { el } = await mount(t);
  send({ type: 'inspector.helpHtml', kind: 'observers', uri: 'https://docs/observers' });
  pushContent({ kind: 'observers', databaseId: 'db1', observerId: 'ob1', tab: 'json', selectedRowJson: '{"ev":1}' });
  await el.updateComplete;

  const buttons = tabs(el);
  assert.deepEqual(buttons.map(b => b.title), ['json', 'help']);
  const json = el.shadowRoot!.querySelector('query-json-element') as unknown as { json: string };
  assert.ok(json, 'observers json tab body');
  assert.equal(json.json, '{"ev":1}');

  posted.length = 0;
  buttons.find(b => b.title === 'help')!.click();
  assert.deepEqual(posted, [{ type: 'inspector.tabSelected', tab: 'help' }]);

  pushContent({ kind: 'observers', databaseId: 'db1', observerId: 'ob1', tab: 'help' });
  await el.updateComplete;
  const help = el.shadowRoot!.querySelector('help-content-element') as unknown as { uri: string };
  assert.ok(help, 'observers help tab body');
  assert.equal(help.uri, 'https://docs/observers');
});

test('Inspector: an unknown query tab renders an empty body without throwing', async t => {
  const { el } = await mount(t);
  // Not reachable through typed InspectorContent — exercises renderTab's
  // default branch so a future tab added to the type but not the switch
  // fails loudly here instead of rendering a mystery blank.
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'bogus' });
  await el.updateComplete;
  const body = el.shadowRoot!.querySelector('.body')!;
  assert.equal(body.children.length, 0, 'default branch renders nothing');
  assert.equal(tabs(el).length, 5, 'the tab row itself still renders');
});

test('Inspector: an unknown observers tab renders an empty body without throwing', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'observers', databaseId: 'db1', observerId: 'ob1', tab: 'bogus' });
  await el.updateComplete;
  const body = el.shadowRoot!.querySelector('.body')!;
  assert.equal(body.children.length, 0, 'renderObserverTab default branch renders nothing');
});

test('Inspector: attachment lifecycle messages are accepted without touching router state', async t => {
  const { el } = await mount(t);
  pushContent({ kind: 'query', databaseId: 'db1', tab: 'history' });
  await el.updateComplete;
  const before = el.shadowRoot!.innerHTML;
  send({ type: 'inspector.attachmentProgress', token: 'tok', receivedBytes: 1, totalBytes: 2 });
  send({ type: 'inspector.attachmentLoaded', token: 'tok', metadata: {} });
  send({ type: 'inspector.attachmentSaved', token: 'tok', path: '/tmp/f' });
  send({ type: 'inspector.attachmentError', token: 'tok', error: 'boom' });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.innerHTML, before,
    'the router deliberately no-ops attachment messages — <query-json-element> owns them');
});

test('Inspector: undefined host messages are dropped silently', async t => {
  const { el } = await mount(t);
  window.dispatchEvent(new MessageEvent('message', { data: undefined }));
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /No active database/,
    'an empty message does not disturb the initial state');
});
