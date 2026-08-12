import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

(globalThis as any).acquireVsCodeApi = () => ({
  postMessage() {},
  getState() { return undefined; },
  setState() {},
});

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = TestResizeObserver;
// The graph element's RAF loop reschedules itself forever; keep it parked.
(globalThis as any).requestAnimationFrame = (): number => 1;
(globalThis as any).cancelAnimationFrame = (): void => {};

await import('../../../webview-ui/peers/peers-element.js');

const LOCAL = {
  peerKey: 'local',
  deviceName: 'Local device',
  sdkLanguage: 'js',
  sdkPlatform: 'web',
  sdkVersion: '5.1.0',
};

function remotePeer(id: string) {
  return {
    id,
    isDittoServer: false,
    deviceName: id.toUpperCase(),
    connections: [{ peer1: 'local', peer2: id, connectionType: 'AccessPoint' }],
    syncSessionStatus: 'Connected',
  };
}

/** Mounts the panel on the graph tab. Teardown is registered on the test
 *  context because connectedCallback starts a 30s interval that would
 *  otherwise keep the process alive after the suite finishes. */
async function mountGraphTab(t: { after(fn: () => void): void }): Promise<any> {
  const el = document.createElement('ditto-peer-listing') as any;
  t.after(() => el.remove());
  document.body.appendChild(el);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'peer.state',
      snapshot: { local: LOCAL, remote: [remotePeer('alpha'), remotePeer('beta')] },
      sync: undefined,
    },
  }));
  await el.updateComplete;

  const graphTab = [...el.shadowRoot.querySelectorAll('.tabs button')]
    .find(b => (b as HTMLElement).textContent?.includes('Presence Graph')) as HTMLButtonElement;
  graphTab.click();
  await el.updateComplete;
  return el;
}

function graph(el: any): any {
  return el.shadowRoot.querySelector('ditto-presence-graph');
}

/** Flip to the peer list and back, which destroys and rebuilds the graph. */
async function roundTripTabs(el: any): Promise<void> {
  const buttons = [...el.shadowRoot.querySelectorAll('.tabs button')] as HTMLButtonElement[];
  const list = buttons.find(b => b.textContent?.includes('Connected Peers'))!;
  const graphTab = buttons.find(b => b.textContent?.includes('Presence Graph'))!;
  list.click();
  await el.updateComplete;
  graphTab.click();
  await el.updateComplete;
}

test('PeerListing: the graph tab receives the host Direct-mode state', async t => {
  const el = await mountGraphTab(t);
  assert.ok(graph(el), 'graph element mounted');
  assert.equal(graph(el).directConnectedOnly, true);
});

test('PeerListing: the graph Direct toggle round-trips through the host', async t => {
  const el = await mountGraphTab(t);

  graph(el).dispatchEvent(new window.CustomEvent('direct-connected-only-change', {
    detail: false, bubbles: true, composed: true,
  }));
  await el.updateComplete;

  assert.equal(el.directConnectedOnly, false, 'host state follows the child event');
  assert.equal(graph(el).directConnectedOnly, false, 'and is bound back down');
});

test('PeerListing: Direct mode survives a tab switch', async t => {
  // Regression: `?direct-connected-only=${false}` could not deliver false to
  // the rebuilt element, so the graph silently reverted to Direct-only while
  // the checkbox claimed otherwise.
  const el = await mountGraphTab(t);
  graph(el).dispatchEvent(new window.CustomEvent('direct-connected-only-change', {
    detail: false, bubbles: true, composed: true,
  }));
  await el.updateComplete;

  const before = graph(el);
  await roundTripTabs(el);
  assert.notEqual(graph(el), before, 'the graph element really is rebuilt');

  assert.equal(graph(el).directConnectedOnly, false);
  assert.equal(graph(el).shadowRoot.querySelector('.direct-control input').checked, false);
});

test('PeerListing: hidden graph controls survive a tab switch', async t => {
  const el = await mountGraphTab(t);
  graph(el).shadowRoot.querySelector('[aria-label="Hide graph controls"]').click();
  await el.updateComplete;

  await roundTripTabs(el);

  assert.equal(graph(el).controlsVisible, false);
  assert.ok(graph(el).shadowRoot.querySelector('[aria-label="Show graph controls"]'));
});

test('PeerListing: Direct mode off feeds the unfiltered presence graph', async t => {
  const el = await mountGraphTab(t);
  assert.equal(el.directConnectedOnly, true);

  graph(el).dispatchEvent(new window.CustomEvent('direct-connected-only-change', {
    detail: false, bubbles: true, composed: true,
  }));
  await el.updateComplete;

  // With no presenceGraph on the snapshot the host has nothing unfiltered to
  // show; the contract is that it stops claiming a direct-only view.
  assert.equal(graph(el).directConnectedOnly, false);
  assert.equal(graph(el).scene.showDirectConnectedOnly, false);
});
