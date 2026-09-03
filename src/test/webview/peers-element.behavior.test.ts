import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

/** Recorded webview→host traffic. The stub must exist before the element
 *  module runs — `messaging.ts` calls acquireVsCodeApi() at import time
 *  and holds the result. */
const posted: any[] = [];
(globalThis as any).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

// The presence-graph child constructs a ResizeObserver and parks a RAF loop;
// jsdom has neither. Local stubs only — the shared setup stays untouched.
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = TestResizeObserver;
(globalThis as any).requestAnimationFrame = (): number => 1;
(globalThis as any).cancelAnimationFrame = (): void => {};

await import('../../../webview-ui/peers/peers-element.js');

/**
 * The Presence panel wrapper: list-tab rendering (local/remote/interface
 * cards, status and time formatting, copy-to-clipboard), the sync toggle,
 * the transport-configuration popover lifecycle, and the graph-input
 * builder (placeholder, cloud detection, edge dedupe, the unfiltered
 * presence graph). The tab-switch/graph-controls contract and the
 * re-attach subscription dance live in peers-element.test.ts.
 */

const LOCAL = {
  peerKey: 'local',
  deviceName: 'Local device',
  sdkLanguage: 'js',
  sdkPlatform: 'web',
  sdkVersion: '5.1.0',
};

let peerSeq = 0;
function peer(over: Record<string, unknown> = {}): Record<string, unknown> {
  peerSeq += 1;
  return {
    id: `peer-${peerSeq}`,
    isDittoServer: false,
    deviceName: `Device ${peerSeq}`,
    connections: [],
    syncSessionStatus: 'Connected',
    ...over,
  };
}

/** Mounts the panel; teardown removes the element so connectedCallback's
 *  30s tick interval cannot keep the process alive. */
async function mount(t: { after(fn: () => void): void }): Promise<any> {
  const el = document.createElement('ditto-peer-listing') as any;
  t.after(() => el.remove());
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function fromHost(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function sendState(snapshot: unknown, sync: 'active' | 'idle' = 'idle'): void {
  fromHost({ type: 'peer.state', snapshot, sync });
}

function lastPosted(type: string): any {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i]?.type === type) { return posted[i]; }
  }
  return undefined;
}

function cards(el: any): HTMLElement[] {
  return [...el.shadowRoot.querySelectorAll('.card')] as HTMLElement[];
}

function cardText(card: HTMLElement): string {
  return (card.textContent ?? '').replace(/\s+/g, ' ');
}

async function switchToGraphTab(el: any): Promise<void> {
  const tab = [...el.shadowRoot.querySelectorAll('.tabs button')]
    .find(b => (b as HTMLElement).textContent?.includes('Presence Graph')) as HTMLButtonElement;
  tab.click();
  await el.updateComplete;
}

// ─── Sync header ────────────────────────────────────────────────

test('PeerListing: the sync dot, label and button follow peer.state sync', async t => {
  const el = await mount(t);
  assert.match(el.shadowRoot.textContent, /Sync Idle/);
  assert.match(el.shadowRoot.textContent, /▶ Start Sync/);
  assert.ok(el.shadowRoot.querySelector('.dot.idle'));

  sendState({ local: null, remote: [] }, 'active');
  await el.updateComplete;
  assert.match(el.shadowRoot.textContent, /Sync Active/);
  assert.match(el.shadowRoot.textContent, /⏸ Stop Sync/);
  assert.ok(el.shadowRoot.querySelector('.dot.active'));
  assert.equal(el.shadowRoot.querySelector('.header .page-title')?.textContent, 'Presence');
  assert.ok(el.shadowRoot.querySelector('.header-leading .sync-status'));
  assert.ok(el.shadowRoot.querySelector('.header-actions .toolbar-button'));
  assert.ok(el.shadowRoot.querySelector('.header-actions .toolbar-icon-button'));

  posted.length = 0;
  const button = [...el.shadowRoot.querySelectorAll('.header button')]
    .find(b => b.textContent?.includes('Stop Sync')) as HTMLButtonElement;
  button.click();
  assert.deepEqual(posted, [{ type: 'peer.toggleSync' }]);
});

test('PeerListing: with no local peer, no remotes and no interfaces the list tab is an empty state', async t => {
  const el = await mount(t);
  assert.match(el.shadowRoot.textContent, /No sync status available\. Connect to see peers\./);

  // A bare interfaces push is enough to leave the empty state.
  fromHost({ type: 'peer.localNetwork', interfaces: [{ name: 'en0', kind: 'lan', ipv4: [], ipv6: [] }] });
  await el.updateComplete;
  assert.ok(!el.shadowRoot.textContent.includes('No sync status available'));
  assert.match(el.shadowRoot.textContent, /Local Network/);
});

// ─── Local card ─────────────────────────────────────────────────

test('PeerListing: the local card renders device and SDK fields with em-dash fallbacks', async t => {
  const el = await mount(t);
  sendState({ local: LOCAL, remote: [] });
  await el.updateComplete;

  const card = cards(el).find(c => c.classList.contains('local-card'))!;
  assert.ok(card);
  const text = cardText(card);
  assert.match(text, /Local Peer/);
  // Adjacent label/value spans have no whitespace between them.
  assert.match(text, /Device Name ?Local device/);
  assert.match(text, /SDK Language ?js/);
  assert.match(text, /SDK Platform ?web/);
  assert.match(text, /SDK Version ?5\.1\.0/);

  sendState({ local: { peerKey: 'local', deviceName: '', sdkLanguage: '', sdkPlatform: '', sdkVersion: '' }, remote: [] });
  await el.updateComplete;
  const blank = cards(el).find(c => c.classList.contains('local-card'))!;
  assert.match(cardText(blank), /\(unnamed\)/, 'empty device name falls back');
  const dashes = blank.querySelectorAll('.card-body .value');
  assert.deepEqual([...dashes].map(d => d.textContent), ['', '—', '—', '—']);
});

// ─── Remote cards ───────────────────────────────────────────────

test('PeerListing: remote cards paint the dominant-connection gradient with the right priority', async t => {
  const el = await mount(t);
  const conn = (type: string) => ({ id: 'c', connectionType: type, peer1: 'local', peer2: 'x' });
  sendState({
    local: null,
    remote: [
      peer({ isDittoServer: true, deviceName: '', connections: [conn('WebSocket')] }),   // cloud wins over type
      peer({ connections: [conn('Bluetooth'), conn('WebSocket')] }),                     // WebSocket before Bluetooth
      peer({ connections: [conn('AccessPoint')] }),
      peer({ connections: [conn('Bluetooth'), conn('P2PWiFi')] }),                       // P2PWiFi before Bluetooth
      peer({ connections: [conn('Bluetooth')] }),
      peer(),                                                                            // unknown
    ],
  });
  await el.updateComplete;

  const styles = cards(el).map(c => c.getAttribute('style') ?? '');
  assert.match(styles[0]!, /rgb\(115, 38, 184\)/, 'Ditto Server → cloud gradient');
  assert.match(styles[1]!, /rgb\(217, 122, 0\)/, 'WebSocket outranks Bluetooth');
  assert.match(styles[2]!, /rgb\(13, 133, 64\)/, 'AccessPoint');
  assert.match(styles[3]!, /rgb\(199, 26, 56\)/, 'P2PWiFi outranks Bluetooth');
  assert.match(styles[4]!, /rgb\(0, 102, 217\)/, 'Bluetooth');
  assert.match(styles[5]!, /rgb\(89, 89, 102\)/, 'no connections → unknown');

  assert.match(cardText(cards(el)[0]!), /Ditto Server/, 'an unnamed server gets the server fallback name');
});

test('PeerListing: OS icons and display names cover the known platforms and the fallback', async t => {
  const el = await mount(t);
  sendState({
    local: null,
    remote: [
      peer({ os: 'iOS' }),
      peer({ os: 'Windows' }),
      peer({ os: 'tvOS' }),
      peer({ os: 'Linux' }),
      peer({ os: 'Android' }),
      peer({ os: undefined }),
    ],
  });
  await el.updateComplete;

  const icons = cards(el).map(c => c.querySelector('.card-os .codicon')!.className);
  assert.ok(icons[0]!.includes('codicon-device-mobile'), 'iOS');
  assert.ok(icons[1]!.includes('codicon-terminal'), 'Windows');
  assert.ok(icons[2]!.includes('codicon-terminal'), 'tvOS');
  assert.ok(icons[3]!.includes('codicon-terminal'), 'Linux');
  assert.ok(icons[4]!.includes('codicon-device-mobile'), 'Android');
  assert.ok(icons[5]!.includes('codicon-question'), 'unknown OS');

  const labels = cards(el).map(c => c.querySelector('.card-os span')!.textContent);
  assert.equal(labels[5], 'Unknown', 'undefined OS displays as Unknown');
});

test('PeerListing: status pills colour all three sync session states', async t => {
  const el = await mount(t);
  sendState({
    local: null,
    remote: [
      peer({ syncSessionStatus: 'Connected' }),
      peer({ syncSessionStatus: 'Connecting' }),
      peer({ syncSessionStatus: 'Disconnected' }),
    ],
  });
  await el.updateComplete;

  const dots = cards(el).map(c => c.querySelector('.status .dot')!.getAttribute('style') ?? '');
  assert.match(dots[0]!, /charts-green/);
  assert.match(dots[1]!, /charts-orange/);
  assert.match(dots[2]!, /charts-red/);
  assert.match(cardText(cards(el)[2]!), /Disconnected/);
});

test('PeerListing: a fully-loaded remote card renders version, metadata, connections, commit and time', async t => {
  const el = await mount(t);
  const longId = 'z'.repeat(40);
  sendState({
    local: null,
    remote: [peer({
      id: longId,
      dittoSdkVersion: '5.1.0',
      identityMetadata: { appId: 'app-1' },
      peerMetadata: { role: 'reader' },
      connections: [
        { id: 'c1', connectionType: 'Bluetooth', peer1: 'local', peer2: longId },
        { id: 'c2', connectionType: 'AccessPoint', peer1: 'local', peer2: longId },
        { id: 'c3', connectionType: 'P2PWiFi', peer1: 'local', peer2: longId },
        { id: 'c4', connectionType: 'WebSocket', peer1: 'local', peer2: longId },
      ],
      syncedUpToLocalCommitId: 42,
      lastUpdateReceivedTime: Date.now(),
    })],
  });
  await el.updateComplete;

  const card = cards(el)[0]!;
  const text = cardText(card);
  assert.match(text, /Ditto SDK: 5\.1\.0/);
  assert.match(text, /Identity Metadata/);
  assert.match(text, /"appId": "app-1"/);
  assert.match(text, /Peer Metadata/);
  assert.match(text, /Active Connections \(4\)/);
  assert.deepEqual(
    [...card.querySelectorAll('.badge span:last-child')].map(b => b.textContent),
    ['Bluetooth', 'WiFi AP', 'P2P WiFi', 'WebSocket'],
  );
  assert.match(text, /Synced to commit: 42/);
  assert.match(text, /Last update: just now/);

  const idEl = card.querySelector('.card-id')!;
  assert.equal(idEl.textContent?.trim(), 'z'.repeat(32) + '…', 'long ids truncate at 32 chars');
  assert.match(idEl.getAttribute('title') ?? '', new RegExp(`copy: ${longId}`));
});

test('PeerListing: last-update formats Never, just now, same-day time and cross-day date', async t => {
  const el = await mount(t);
  // Pin the clock so "same day" cannot flake around midnight.
  const realNow = Date.now;
  const fixed = new Date(2026, 5, 9, 14, 0, 0).getTime(); // local time, mid-day
  Date.now = () => fixed;
  try {
    sendState({
      local: null,
      remote: [
        peer({ lastUpdateReceivedTime: undefined }),
        peer({ lastUpdateReceivedTime: fixed - 30_000 }),
        peer({ lastUpdateReceivedTime: fixed - 120_000 }),
        peer({ lastUpdateReceivedTime: fixed - 3 * 86_400_000 }),
      ],
    });
    await el.updateComplete;

    const rows = cards(el).map(c =>
      [...c.querySelectorAll('.card-row')].find(r => r.textContent?.includes('Last update'))?.textContent?.trim());
    assert.match(rows[0]!, /Last update: Never/);
    assert.match(rows[1]!, /Last update: just now/);
    assert.match(rows[2]!, new RegExp(new Date(fixed - 120_000)
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(rows[3]!, /Last update: /);
    assert.match(rows[3]!, new RegExp(
      new Date(fixed - 3 * 86_400_000)
        .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    Date.now = realNow;
  }
});

test('PeerListing: a newer peer.state snapshot replaces the rendered cards', async t => {
  const el = await mount(t);
  sendState({ local: LOCAL, remote: [peer({ deviceName: 'Alpha' }), peer({ deviceName: 'Beta' })] });
  await el.updateComplete;
  assert.match(el.shadowRoot.textContent, /Alpha/);
  assert.match(el.shadowRoot.textContent, /Beta/);

  sendState({ local: LOCAL, remote: [peer({ deviceName: 'Gamma' })] });
  await el.updateComplete;
  assert.ok(!el.shadowRoot.textContent.includes('Alpha'), 'dropped peer disappears');
  assert.match(el.shadowRoot.textContent, /Gamma/);
});

// ─── Copy to clipboard ──────────────────────────────────────────

/** Node's global `navigator` is a getter-only accessor; overriding it takes
 *  defineProperty, and restoring takes the original descriptor. Local to
 *  these two tests — the shared setup stays untouched. */
function withClipboard(writeText: (s: string) => Promise<void>): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) { Object.defineProperty(globalThis, 'navigator', original); }
  };
}

test('PeerListing: double-clicking a card id copies it and flashes the copied state', async t => {
  const writes: string[] = [];
  const restore = withClipboard(async (s: string) => { writes.push(s); });
  try {
    const el = await mount(t);
    sendState({ local: null, remote: [peer({ id: 'id-a' }), peer({ id: 'id-b' })] });
    await el.updateComplete;

    const idEls = cards(el).map(c => c.querySelector('.card-id') as HTMLElement);
    idEls[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(writes, ['id-a']);
    assert.ok(cards(el)[0]!.querySelector('.card-id')!.classList.contains('copied'));

    // 1s later, copy the second id: id-a's timer (fires at 1.5s) must not
    // clear id-b's copied state (which expires at 2.5s).
    await new Promise(r => setTimeout(r, 1000));
    cards(el)[1]!.querySelector<HTMLElement>('.card-id')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(writes, ['id-a', 'id-b']);
    assert.ok(cards(el)[1]!.querySelector('.card-id')!.classList.contains('copied'));

    await new Promise(r => setTimeout(r, 800)); // t≈1.8s: id-a's timer has fired
    await el.updateComplete;
    assert.ok(cards(el)[1]!.querySelector('.card-id')!.classList.contains('copied'),
      'the stale timer from id-a must not clear id-b\'s copied state');

    await new Promise(r => setTimeout(r, 1000)); // t≈2.8s: id-b's timer has fired
    await el.updateComplete;
    assert.equal(el.shadowRoot.querySelector('.card-id.copied'), null, 'id-b\'s own timer clears it');
  } finally {
    restore();
  }
});

test('PeerListing: a clipboard failure is swallowed without the copied flash', async t => {
  const restore = withClipboard(async () => { throw new Error('denied'); });
  try {
    const el = await mount(t);
    sendState({ local: null, remote: [peer({ id: 'id-x' })] });
    await el.updateComplete;

    cards(el)[0]!.querySelector<HTMLElement>('.card-id')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    await el.updateComplete;
    await new Promise(r => setTimeout(r, 0));
    assert.equal(el.shadowRoot.querySelector('.card-id.copied'), null);
  } finally {
    restore();
  }
});

// ─── Local network section ──────────────────────────────────────

test('PeerListing: interface cards render per-kind labels and only the addresses they have', async t => {
  const el = await mount(t);
  fromHost({
    type: 'peer.localNetwork',
    interfaces: [
      {
        name: 'en0', kind: 'lan', mac: 'aa:bb:cc:dd:ee:ff',
        ipv4: [{ address: '192.168.1.5', cidr: '192.168.1.5/24' }],
        ipv6: [
          { address: '2601:db8::1', cidr: '2601:db8::1/64' },
          { address: 'fe80::abcd', cidr: 'fe80::abcd/64' },
        ],
      },
      { name: 'lo0', kind: 'loopback', ipv4: [{ address: '127.0.0.1', cidr: '127.0.0.1/8' }], ipv6: [] },
      { name: 'utun3', kind: 'other', ipv4: [], ipv6: [{ address: 'fe80::1', cidr: 'fe80::1/64' }] },
    ],
  });
  await el.updateComplete;

  const grid = cards(el);
  assert.equal(grid.length, 3);

  const lan = cardText(grid[0]!);
  assert.match(lan, /LAN/);
  assert.match(lan, /en0/);
  assert.match(lan, /MAC ?aa:bb:cc:dd:ee:ff/);
  assert.match(lan, /IPv4 ?192\.168\.1\.5\/24/);
  assert.match(lan, /IPv6 ?2601:db8::1/);
  assert.match(lan, /IPv6 link-local ?fe80::abcd/);
  assert.ok(grid[0]!.querySelector('.codicon-globe'));
  assert.match(grid[0]!.getAttribute('style') ?? '', /rgb\(13, 133, 64\)/);

  const loop = cardText(grid[1]!);
  assert.match(loop, /Loopback/);
  assert.match(loop, /IPv4 ?127\.0\.0\.1\/8/);
  assert.ok(!/MAC/.test(loop), 'no MAC row without a mac');
  assert.ok(!/IPv6/.test(loop), 'no IPv6 rows without v6 addresses');
  assert.ok(grid[1]!.querySelector('.codicon-circle-slash'));

  const other = cardText(grid[2]!);
  assert.match(other, /Network/);
  assert.ok(!/MAC|IPv4/.test(other));
  assert.match(other, /IPv6 link-local ?fe80::1/);
  assert.ok(grid[2]!.querySelector('.codicon-symbol-misc'));

  posted.length = 0;
  (el.shadowRoot.querySelector('.local-net-refresh') as HTMLButtonElement).click();
  assert.deepEqual(posted, [{ type: 'peer.refreshLocalNetwork' }]);
});

// ─── Transport configuration popover ────────────────────────────

const PLATFORM_INIT = {
  type: 'peer.platformInit',
  platform: 'macos',
  support: { lan: true, bluetoothLE: true, awdl: false },
  current: { isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false },
};

async function mountWithPlatform(t: { after(fn: () => void): void }): Promise<any> {
  const el = await mount(t);
  fromHost(PLATFORM_INIT);
  await el.updateComplete;
  return el;
}

function gear(el: any): HTMLButtonElement {
  return el.shadowRoot.querySelector('button[aria-label="Transport Configuration"]');
}

function popover(el: any): HTMLElement | null {
  return el.shadowRoot.querySelector('.popover');
}

function applyButton(el: any): HTMLButtonElement {
  return popover(el)!.querySelector('.popover-actions .primary')!;
}

function banner(el: any): HTMLElement | null {
  return popover(el)?.querySelector('.banner') ?? null;
}

test('PeerListing: the transport gear stays disabled until peer.platformInit arrives', async t => {
  const el = await mount(t);
  assert.equal(gear(el).disabled, true, 'disabled before the platform push');

  fromHost(PLATFORM_INIT);
  await el.updateComplete;
  assert.equal(gear(el).disabled, false);
});

test('PeerListing: the popover lists one row per supported transport and toggling posts an apply', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;

  const rows = [...popover(el)!.querySelectorAll('.transport-row')];
  assert.equal(rows.length, 2, 'awdl unsupported → no AWDL row');
  assert.match(cardText(rows[0] as HTMLElement), /Bluetooth LE/);
  assert.match(cardText(rows[1] as HTMLElement), /Local Area Network/);
  assert.match(banner(el)!.className, /warning/, 'the untouched form warns about the sync restart');
  assert.equal(applyButton(el).disabled, true, 'nothing dirty → Apply disabled');

  posted.length = 0;
  const bleToggle = rows[0]!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  bleToggle.checked = true;
  bleToggle.dispatchEvent(new Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.equal(applyButton(el).disabled, false, 'a dirty form enables Apply');

  applyButton(el).click();
  await el.updateComplete;
  assert.deepEqual(lastPosted('peer.applyTransportConfig'), {
    type: 'peer.applyTransportConfig',
    isLanEnabled: true,
    isBluetoothLeEnabled: true,
    isAwdlEnabled: false,
  });
  assert.match(banner(el)!.className, /info/, 'in-progress banner once the apply starts');
  assert.match(banner(el)!.textContent ?? '', /Applying transport changes/);
  assert.equal(applyButton(el).disabled, true, 'Apply locks while the host works');
  const inputs = [...popover(el)!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.ok(inputs.every(i => i.disabled), 'all toggles lock while applying');

  fromHost({ type: 'peer.transportApplyStatus', step: 'applyingConfig' });
  await el.updateComplete;
  assert.match(banner(el)!.className, /info/);

  fromHost({ type: 'peer.transportApplyStatus', step: 'complete' });
  await el.updateComplete;
  assert.match(banner(el)!.className, /success/);
  assert.match(banner(el)!.textContent ?? '', /Configuration applied successfully/);

  // Reopening after a completed apply clears the terminal state back to the
  // idle warning (and the form resets to the baseline).
  (popover(el)!.querySelector('.popover-close') as HTMLButtonElement).click();
  await el.updateComplete;
  gear(el).click();
  await el.updateComplete;
  assert.match(banner(el)!.className, /warning/, 'the stale success state is cleared on reopen');
  assert.equal(applyButton(el).disabled, true, 'form back at baseline — nothing dirty');
});

test('PeerListing: apply errors render the host message in the error banner', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;
  toggleChange(popover(el)!, 1, false); // LAN off — a dirty change
  await el.updateComplete;
  assert.equal(applyButton(el).disabled, false);
  applyButton(el).click();
  await el.updateComplete;
  assert.ok(lastPosted('peer.applyTransportConfig'), 'the apply went out');

  fromHost({ type: 'peer.transportApplyError', message: 'sync failed to restart' });
  await el.updateComplete;
  assert.match(banner(el)!.className, /error/);
  assert.match(banner(el)!.textContent ?? '', /sync failed to restart/);
  assert.equal(applyButton(el).disabled, false, 'a failed apply re-arms the form');
});

test('PeerListing: the success banner auto-clears to idle and a repeated complete restarts the timer', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;
  toggleChange(popover(el)!, 1, false); // LAN off — a dirty change
  await el.updateComplete;
  applyButton(el).click();
  await el.updateComplete;

  fromHost({ type: 'peer.transportApplyStatus', step: 'complete' });
  await el.updateComplete;
  assert.match(banner(el)!.className, /success/);

  // A second 'complete' before the timer fires must replace the pending
  // clear, not leave the first one armed.
  await new Promise(r => setTimeout(r, 900));
  fromHost({ type: 'peer.transportApplyStatus', step: 'complete' });
  await el.updateComplete;

  await new Promise(r => setTimeout(r, 900));
  await el.updateComplete;
  assert.match(banner(el)!.className, /success/,
    '1.8s after the first complete — the stale timer would have fired by now');

  await new Promise(r => setTimeout(r, 800));
  await el.updateComplete;
  assert.match(banner(el)!.className, /warning/, 'the restarted timer fires 1.5s after the second complete');
});

test('PeerListing: cancel closes the popover and reopening resets both form and stale apply state', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;
  toggleChange(popover(el)!, 1, false); // LAN off — dirty
  await el.updateComplete;
  assert.equal(applyButton(el).disabled, false, 'dirty form enables Apply');

  (popover(el)!.querySelector('.popover-actions .secondary') as HTMLButtonElement).click();
  await el.updateComplete;
  assert.equal(popover(el), null, 'cancel closes');

  // Reopen: the form is back at baseline, so nothing is dirty.
  gear(el).click();
  await el.updateComplete;
  const inputs = [...popover(el)!.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.equal(inputs[1]!.checked, true, 'LAN toggle back at the baseline value');
  assert.equal(applyButton(el).disabled, true);

  // Drive an apply to a terminal state, close via the X, reopen: the
  // terminal banner must not survive the reopen.
  toggleChange(popover(el)!, 1, false);
  await el.updateComplete;
  applyButton(el).click();
  await el.updateComplete;
  fromHost({ type: 'peer.transportApplyError', message: 'boom' });
  await el.updateComplete;
  assert.match(banner(el)!.className, /error/);

  (popover(el)!.querySelector('.popover-close') as HTMLButtonElement).click();
  await el.updateComplete;
  assert.equal(popover(el), null, 'the X closes too');

  gear(el).click();
  await el.updateComplete;
  assert.match(banner(el)!.className, /warning/, 'reopening clears the stale error state');
});

function toggleChange(pop: HTMLElement, index: number, checked: boolean): void {
  const input = pop.querySelectorAll('input[type="checkbox"]')[index] as HTMLInputElement;
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('PeerListing: clicking the gear again toggles the popover closed', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;
  assert.ok(popover(el));
  gear(el).click();
  await el.updateComplete;
  assert.equal(popover(el), null);
});

test('PeerListing: the apply guard refuses a clean form even if invoked directly', async t => {
  const el = await mountWithPlatform(t);
  gear(el).click();
  await el.updateComplete;

  // The Apply button is disabled in this state; the in-code guard is the
  // second line of defence (e.g. a stale Enter key handler).
  posted.length = 0;
  el.applyTransportConfig();
  await el.updateComplete;
  assert.equal(posted.length, 0, 'nothing posted for a clean form');
  assert.match(banner(el)!.className, /warning/, 'still on the idle warning');
});

// ─── Graph tab input building ───────────────────────────────────

test('PeerListing: the graph tab shows a placeholder until a local peer exists', async t => {
  const el = await mount(t);
  sendState({ local: null, remote: [peer()] });
  await el.updateComplete;
  await switchToGraphTab(el);
  assert.match(el.shadowRoot.textContent, /Waiting for presence — connect to see the graph\./);
  assert.equal(el.shadowRoot.querySelector('ditto-presence-graph'), null);
});

test('PeerListing: the graph input flags the cloud and dedupes direct connections', async t => {
  const el = await mount(t);
  const serverConn = { id: 'c0', connectionType: 'WebSocket', peer1: 'local', peer2: 'cloud' };
  const shared = { id: 'c1', connectionType: 'AccessPoint', peer1: 'local', peer2: 'alpha' };
  sendState({
    local: LOCAL,
    remote: [
      peer({ id: 'cloud', isDittoServer: true, deviceName: '', connections: [serverConn] }),
      peer({ id: 'alpha', connections: [shared] }),
      peer({ id: 'beta', connections: [{ ...shared, id: 'c2' }] }), // duplicate pair+type
    ],
  });
  await el.updateComplete;
  await switchToGraphTab(el);

  const graph = el.shadowRoot.querySelector('ditto-presence-graph');
  assert.equal(graph.input.isLocalConnectedToCloud, true, 'a Ditto Server peer flags the cloud edge');
  assert.deepEqual(graph.input.remotePeers.map((p: any) => p.peerKey), ['alpha', 'beta'],
    'the cloud peer itself is not a remote node — the scene synthesises it');
  assert.equal(graph.input.connections.length, 2, 'the duplicate alpha edge collapses; the cloud edge stays');
  assert.deepEqual(
    graph.input.connections.map((c: any) => `${c.from}>${c.to}:${c.type}`).sort(),
    ['local>alpha:AccessPoint', 'local>cloud:WebSocket'],
  );
  assert.equal(graph.input.localPeerKey, 'local');
  assert.equal(graph.input.localDeviceName, 'Local device');
});

test('PeerListing: with Direct off the graph consumes the unfiltered presenceGraph', async t => {
  const el = await mount(t);
  sendState({
    local: LOCAL,
    remote: [peer({ id: 'alpha', connections: [{ id: 'c1', connectionType: 'AccessPoint', peer1: 'local', peer2: 'alpha' }] })],
    presenceGraph: {
      remotePeers: [
        { peerKey: 'alpha', deviceName: 'Alpha' },
        { peerKey: 'hop', deviceName: 'Multi-hop' },
      ],
      connections: [
        { peer1: 'local', peer2: 'alpha', connectionType: 'AccessPoint' },
        { peer1: 'alpha', peer2: 'hop', connectionType: 'Bluetooth' },
      ],
    },
  });
  await el.updateComplete;
  await switchToGraphTab(el);

  const graph = el.shadowRoot.querySelector('ditto-presence-graph');
  assert.equal(graph.input.remotePeers.length, 1, 'direct mode shows only the filtered snapshot remotes');

  graph.dispatchEvent(new CustomEvent('direct-connected-only-change', {
    detail: false, bubbles: true, composed: true,
  }));
  await el.updateComplete;

  const after = el.shadowRoot.querySelector('ditto-presence-graph');
  assert.deepEqual(after.input.remotePeers.map((p: any) => p.peerKey), ['alpha', 'hop'],
    'multi-hop peers arrive with Direct off');
  assert.deepEqual(
    after.input.connections.map((c: any) => `${c.from}>${c.to}:${c.type}`),
    ['local>alpha:AccessPoint', 'alpha>hop:Bluetooth'],
    'peer↔peer chord edges survive in the unfiltered view',
  );
  assert.equal(after.input.isLocalConnectedToCloud, false, 'no server in this snapshot');
});
