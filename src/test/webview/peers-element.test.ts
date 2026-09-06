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

function tabButtons(el: any): HTMLButtonElement[] {
  return [...el.shadowRoot.querySelectorAll('.tabs button')];
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

// ─── Graph peer search ─────────────────────────────────────────

function searchInput(el: any): HTMLInputElement {
  return el.shadowRoot.querySelector('.graph-search input');
}

function typeSearch(el: any, value: string): void {
  const input = searchInput(el);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function pressSearchKey(el: any, key: string): void {
  // composed: true matches real-browser keydown (Chromium marks it composed)
  // so the event crosses the shadow boundary exactly as in production — and
  // can reach the panel-wide Escape listener on window. jsdom defaults
  // keydown to composed: false.
  searchInput(el).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
}

test('PeerListing: the search lives in the tab bar on the graph tab; the list tab has none', async t => {
  const el = await mountGraphTab(t);
  const tabs = el.shadowRoot.querySelector('.tabs');
  const search = el.shadowRoot.querySelector('.graph-search');
  assert.ok(search, 'search present on the graph tab');
  assert.ok(tabs.contains(search), 'the search rides in the tab bar, costing the canvas no row');

  // It follows the tab buttons (right-aligned via margin-left: auto).
  const lastTab = [...tabs.querySelectorAll('button')].pop()!;
  assert.ok(search.compareDocumentPosition(lastTab) & 0x02 /* PRECEDING */,
    'search sits after the tab buttons in the bar');

  assert.ok(el.shadowRoot.querySelector('.graph-host'), 'canvas still fills the area below');

  tabButtons(el).find(b => b.textContent?.includes('Connected Peers'))!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.graph-search'), null, 'no search UI on the list tab');
});

test('PeerListing: searching filters the results card case-insensitively and highlights matches in the scene', async t => {
  const el = await mountGraphTab(t);

  typeSearch(el, 'alp');
  await el.updateComplete;

  const results = [...el.shadowRoot.querySelectorAll('.search-results .search-result')] as HTMLElement[];
  assert.deepEqual(
    results.map(r => r.querySelector('.search-result-name')!.textContent.trim()),
    ['ALPHA'],
  );
  assert.deepEqual([...graph(el).searchMatchKeys], ['alpha'], 'match keys flow into the graph element');
  assert.deepEqual(graph(el).scene.focusForPeer('alpha'), { selected: false, alpha: 1 });
  assert.deepEqual(graph(el).scene.focusForPeer('beta'), { selected: false, alpha: 0.25 });

  // Peer keys are searchable too, and the match survives upper/lowercase.
  typeSearch(el, 'BETA');
  await el.updateComplete;
  assert.deepEqual(
    [...el.shadowRoot.querySelectorAll('.search-results .search-result')].map(r =>
      (r as HTMLElement).querySelector('.search-result-name')!.textContent.trim()),
    ['BETA'],
  );
});

test('PeerListing: the local device is listed but cannot be focused from search', async t => {
  const el = await mountGraphTab(t);
  typeSearch(el, 'local');
  await el.updateComplete;

  const rows = [...el.shadowRoot.querySelectorAll('.search-results .search-result')] as HTMLElement[];
  assert.equal(rows.length, 1, 'only the local peer matches');
  assert.equal(rows[0]!.tagName, 'DIV', 'local row is not clickable — the scene rejects local selection');
  assert.equal(rows[0]!.getAttribute('title'), 'The local device cannot be focused');
  assert.ok(rows[0]!.textContent.includes('this device'));

  // Enter has nothing actionable to focus.
  pressSearchKey(el, 'Enter');
  await el.updateComplete;
  await graph(el).updateComplete;
  assert.equal(graph(el).scene.selectedPeerKey, undefined);

  // With a query that also matches remotes, Enter takes the first actionable
  // hit — remote peers are listed first, the local device last.
  typeSearch(el, 'a');
  await el.updateComplete;
  pressSearchKey(el, 'Enter');
  await el.updateComplete;
  await graph(el).updateComplete;
  await graph(el).updateComplete;
  assert.equal(graph(el).scene.selectedPeerKey, 'alpha');
});

test('PeerListing: a zero-hit search dims the whole graph and says so', async t => {
  const el = await mountGraphTab(t);
  typeSearch(el, 'zzz');
  await el.updateComplete;

  assert.ok(el.shadowRoot.querySelector('.search-result-empty'), 'empty-state row rendered');
  const keys = graph(el).searchMatchKeys;
  assert.ok(keys instanceof Set && keys.size === 0, 'an empty set, not undefined, marks search active');
  assert.deepEqual(graph(el).scene.focusForPeer('alpha'), { selected: false, alpha: 0.25 });

  pressSearchKey(el, 'Escape');
  await el.updateComplete;
  assert.equal(el.graphSearch, '');
  assert.equal(el.shadowRoot.querySelector('.search-results'), null, 'card dismissed');
  assert.equal(graph(el).searchMatchKeys, undefined, 'dimming released');
  assert.deepEqual(graph(el).scene.focusForPeer('alpha'), { selected: false, alpha: 1 });
});

test('PeerListing: Escape works wherever focus is — a mouse pick does not strand the search', async t => {
  const el = await mountGraphTab(t);
  typeSearch(el, 'alp');
  await el.updateComplete;

  // Simulate "focus is anywhere but the input" (post-click the DOM focus is
  // on the result button): dispatch on the body, not the box.
  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await el.updateComplete;

  assert.equal(el.graphSearch, '', 'panel-wide Escape cleared the query');
  assert.equal(graph(el).searchMatchKeys, undefined, 'dimming released');
});

test('PeerListing: Escape unwinds the innermost context — an open card first, then the search', async t => {
  const el = await mountGraphTab(t);
  const g = graph(el);
  typeSearch(el, 'alp');
  g.detailPeerKey = 'alpha'; // card state is element-owned; stage it directly
  await el.updateComplete;
  assert.equal(g.shadowRoot.querySelector('.peer-detail-card') === null, false, 'card showing');

  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await el.updateComplete;
  assert.equal(g.detailOpen, false, 'first Escape closed the card');
  assert.equal(el.graphSearch, 'alp', '…and deliberately kept the query');

  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.graphSearch, '', 'second Escape clears the query');
});

test('PeerListing: Escape on the list tab touches nothing', async t => {
  const el = await mountGraphTab(t);
  typeSearch(el, 'alp');
  await el.updateComplete;
  tabButtons(el).find(b => b.textContent?.includes('Connected Peers'))!.click();
  await el.updateComplete;

  document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await el.updateComplete;
  assert.equal(el.graphSearch, 'alp', 'the query is a graph-tab concern');
});

test('PeerListing: picking a result flips Direct off and focuses the peer like a full-mesh click', async t => {
  const el = await mountGraphTab(t);
  // Bring in the full presence graph with a multi-hop peer: gamma is only
  // reachable through alpha, so it is invisible to a Direct-mode input but
  // must still be findable.
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'peer.state',
      snapshot: {
        local: LOCAL,
        remote: [
          remotePeer('alpha'),
          remotePeer('beta'),
          { ...remotePeer('gamma'), connections: [{ peer1: 'alpha', peer2: 'gamma', connectionType: 'P2PWiFi' }] },
        ],
        presenceGraph: {
          remotePeers: [
            { peerKey: 'alpha', deviceName: 'ALPHA', isConnectedToDittoServer: false, peerMetadataKeyCount: 0, identityMetadataKeyCount: 0 },
            { peerKey: 'beta', deviceName: 'BETA', isConnectedToDittoServer: false, peerMetadataKeyCount: 0, identityMetadataKeyCount: 0 },
            { peerKey: 'gamma', deviceName: 'GAMMA', isConnectedToDittoServer: false, peerMetadataKeyCount: 0, identityMetadataKeyCount: 0 },
          ],
          connections: [
            { peer1: 'local', peer2: 'alpha', connectionType: 'AccessPoint' },
            { peer1: 'local', peer2: 'beta', connectionType: 'AccessPoint' },
            { peer1: 'alpha', peer2: 'gamma', connectionType: 'P2PWiFi' },
          ],
        },
      },
      sync: undefined,
    },
  }));
  await el.updateComplete;

  assert.equal(el.directConnectedOnly, true, 'still in Direct mode');
  assert.equal(graph(el).scene.searchMatchKeys, undefined, 'no search yet');
  assert.ok(!graph(el).scene.peers.has('gamma'), 'multi-hop peer not in the Direct-mode scene');

  typeSearch(el, 'gamma');
  await el.updateComplete;
  assert.deepEqual(graph(el).scene.focusForPeer('alpha'), { selected: false, alpha: 0.25 },
    'an off-screen match dims every visible peer');

  (el.shadowRoot.querySelector('button.search-result') as HTMLButtonElement).click();
  await el.updateComplete;
  await graph(el).updateComplete;
  await graph(el).updateComplete;

  assert.equal(el.directConnectedOnly, false, 'Direct flipped off through the parent');
  assert.equal(graph(el).scene.selectedPeerKey, 'gamma');
  assert.equal(graph(el).scene.isFocusedView, true);
  assert.ok(graph(el).shadowRoot.querySelector('.focus-banner')?.textContent?.includes('GAMMA'));
  assert.equal(searchInput(el).value, 'gamma', 'query kept so another result can be picked');
});

test('PeerListing: the search query and its dimming survive a tab switch', async t => {
  const el = await mountGraphTab(t);
  typeSearch(el, 'alp');
  await el.updateComplete;

  await roundTripTabs(el);

  assert.equal(searchInput(el).value, 'alp', 'query is parent-owned');
  assert.ok(el.shadowRoot.querySelector('.search-results'), 'results card re-rendered');
  assert.deepEqual(graph(el).scene.focusForPeer('beta'), { selected: false, alpha: 0.25 },
    'the fresh scene got the search matches re-applied');
});

// ─── Peer detail card data ─────────────────────────────────────

test('PeerListing: detail card data merges presence-graph facts with direct-peer sync rows', async t => {
  const el = await mountGraphTab(t);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'peer.state',
      snapshot: {
        local: {
          ...LOCAL, os: 'macOS', isConnectedToDittoServer: true,
          peerMetadataKeyCount: 1, identityMetadataKeyCount: 0,
        },
        remote: [
          { ...remotePeer('alpha'), syncedUpToLocalCommitId: 7, lastUpdateReceivedTime: 111 },
          remotePeer('beta'),
          { ...remotePeer('cloud-peer'), isDittoServer: true, connections: [] },
        ],
        presenceGraph: {
          remotePeers: [
            {
              peerKey: 'alpha', deviceName: 'ALPHA', os: 'iOS', dittoSdkVersion: '5.0.0',
              isConnectedToDittoServer: true, isCompatible: true,
              peerMetadataKeyCount: 2, identityMetadataKeyCount: 0,
            },
            {
              peerKey: 'beta', deviceName: 'BETA', os: 'Android', dittoSdkVersion: '4.9.0',
              isConnectedToDittoServer: false,
              peerMetadataKeyCount: 0, identityMetadataKeyCount: 0,
            },
            {
              peerKey: 'gamma', deviceName: 'GAMMA', os: 'Linux', dittoSdkVersion: '5.1.0',
              isConnectedToDittoServer: false, isCompatible: undefined,
              peerMetadataKeyCount: 0, identityMetadataKeyCount: 1,
            },
          ],
          connections: [
            { peer1: 'local', peer2: 'alpha', connectionType: 'AccessPoint' },
            { peer1: 'local', peer2: 'beta', connectionType: 'AccessPoint' },
            { peer1: 'alpha', peer2: 'gamma', connectionType: 'P2PWiFi' },
          ],
        },
      },
      sync: undefined,
    },
  }));
  await el.updateComplete;

  const details = graph(el).peerDetails;
  const alpha = details.get('alpha');
  assert.equal(alpha.displayName, 'ALPHA');
  assert.equal(alpha.os, 'iOS', 'presence-graph fact');
  assert.equal(alpha.cloudLink, true);
  assert.equal(alpha.isCompatible, true);
  assert.equal(alpha.peerMetadataKeyCount, 2);
  assert.equal(alpha.identityMetadataKeyCount, 0, 'empty metadata ships as zero keys');
  assert.equal(alpha.isDirectlyConnected, true);
  assert.equal(alpha.syncedUpToLocalCommitId, 7, 'direct rows overlay the sync session');
  assert.equal(alpha.lastUpdateReceivedTime, 111);

  const gamma = details.get('gamma');
  assert.equal(gamma.os, 'Linux', 'multi-hop peers carry presence facts too — that is the point of the card');
  assert.equal(gamma.isDirectlyConnected, false);
  assert.equal(gamma.syncedUpToLocalCommitId, undefined);
  assert.equal(gamma.identityMetadataKeyCount, 1);

  const me = details.get('local');
  assert.equal(me.displayName, 'Me');
  assert.equal(me.isLocal, true);
  assert.equal(me.os, 'macOS', 'stamped onto local info by the host');
  assert.equal(me.cloudLink, true);
  assert.equal(me.peerMetadataKeyCount, 1);

  assert.equal(details.has('cloud-peer'), false, 'the synthetic cloud peer gets no card');
  assert.equal(details.has('ditto-cloud-node'), false);
});

test('PeerListing: without a presence graph the card falls back to the direct peer rows', async t => {
  const el = await mountGraphTab(t); // default snapshot: no presenceGraph

  const details = graph(el).peerDetails;
  const alpha = details.get('alpha');
  assert.equal(alpha.displayName, 'ALPHA');
  assert.equal(alpha.isDirectlyConnected, true);
  assert.equal(alpha.os, undefined, 'merged rows carry no presence-only facts here');
  assert.equal(alpha.peerMetadataKeyCount, 0);
  assert.equal(details.get('local').displayName, 'Me');
  assert.equal(details.get('local').isLocal, true);
});
