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

// Track host-message subscriptions so the re-attach test can assert that
// exactly one handler is live rather than inferring it from side effects.
const messageListeners = new Set<unknown>();
{
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  (window as any).addEventListener = (type: string, fn: any, opts: any): void => {
    if (type === 'message') { messageListeners.add(fn); }
    origAdd(type, fn, opts);
  };
  (window as any).removeEventListener = (type: string, fn: any, opts: any): void => {
    if (type === 'message') { messageListeners.delete(fn); }
    origRemove(type, fn, opts);
  };
}

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

test('PeerListing: toggling Direct lays the graph out exactly once', async t => {
  const el = await mountGraphTab(t);
  const scene = graph(el).scene;

  // The owner rebuilds `input` for the new mode, so the element must wait for
  // that push rather than also applying the old, differently-filtered one —
  // otherwise the toggle plays two overlapping 500ms layout transitions.
  const applied: boolean[] = [];
  const realApply = scene.applyInput.bind(scene);
  scene.applyInput = (input: any) => {
    const r = realApply(input);
    applied.push(r.topologyChanged);
    return r;
  };

  graph(el).shadowRoot.querySelector('.direct-control input').checked = false;
  graph(el).shadowRoot.querySelector('.direct-control input')
    .dispatchEvent(new window.Event('change', { bubbles: true }));
  await el.updateComplete;
  await graph(el).updateComplete;

  assert.equal(applied.length, 1, `one applyInput per toggle, got ${applied.length}`);
  assert.equal(graph(el).scene.showDirectConnectedOnly, false, 'and the mode still took effect');
});

test('PeerListing: re-attaching does not double-register the host message handler', async t => {
  const el = await mountGraphTab(t);
  assert.equal(messageListeners.size, 1, 'one handler after the initial mount');

  // VS Code moves webview panels between editor groups, which re-runs
  // connectedCallback on the same element.
  el.remove();
  assert.equal(messageListeners.size, 0, 'disconnect releases the handler');

  document.body.appendChild(el);
  await el.updateComplete;
  assert.equal(messageListeners.size, 1, 'a re-attach registers exactly one, not two');

  // And the re-attached element still receives host messages.
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'peer.state', snapshot: { local: LOCAL, remote: [remotePeer('alpha')] }, sync: undefined },
  }));
  await el.updateComplete;
  assert.equal(el.snapshot.remote.length, 1);
});
