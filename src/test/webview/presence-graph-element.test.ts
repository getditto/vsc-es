import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

(globalThis as any).ResizeObserver = TestResizeObserver;
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).cancelAnimationFrame = () => {};

await import('../../../webview-ui/presence-graph/presence-graph-element.js');

async function mount(): Promise<any> {
  const el = document.createElement('ditto-presence-graph') as any;
  el.input = {
    localPeerKey: 'local',
    localDeviceName: 'Local device',
    isLocalConnectedToCloud: false,
    remotePeers: [{ peerKey: 'remote', deviceName: 'Remote device' }],
    connections: [{ from: 'local', to: 'remote', type: 'AccessPoint' }],
  };
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

test('PresenceGraphElement: eye removes optional overlays and can restore them', async () => {
  const el = await mount();
  assert.ok(el.shadowRoot.querySelector('.legend'));
  assert.ok(el.shadowRoot.querySelector('.direct-control'));
  assert.ok(el.shadowRoot.querySelector('[aria-label="Zoom controls"]'));

  const hide = el.shadowRoot.querySelector('[aria-label="Hide graph controls"]') as HTMLButtonElement;
  hide.click();
  await el.updateComplete;

  assert.equal(el.shadowRoot.querySelector('.legend'), null);
  assert.equal(el.shadowRoot.querySelector('.direct-control'), null);
  assert.equal(el.shadowRoot.querySelector('[aria-label="Zoom controls"]'), null);
  assert.ok(el.shadowRoot.querySelector('[aria-label="Reset zoom and center local device"]'));
  const show = el.shadowRoot.querySelector('[aria-label="Show graph controls"]') as HTMLButtonElement;
  assert.ok(show);
  assert.equal(show.getAttribute('aria-pressed'), 'true');

  show.click();
  await el.updateComplete;
  assert.ok(el.shadowRoot.querySelector('.legend'));
  el.remove();
});

test('PresenceGraphElement: center action resets zoom label and camera', async () => {
  const el = await mount();
  el.scene.setPeerPosition('local', { x: 20, y: 35 });
  el.scene.setZoom(1.7);
  el.zoomLabel = '170%';
  await el.updateComplete;

  el.shadowRoot.querySelector('[aria-label="Reset zoom and center local device"]').click();
  await el.updateComplete;

  assert.equal(el.scene.zoom, 1);
  assert.deepEqual(el.scene.camera, { x: -20, y: -35 });
  assert.equal(el.shadowRoot.querySelector('.zoom-label').textContent, '100%');
  el.remove();
});

test('PresenceGraphElement: Direct control emits the requested mode', async () => {
  const el = await mount();
  let requested: boolean | undefined;
  el.addEventListener('direct-connected-only-change', (event: Event) => {
    requested = (event as CustomEvent<boolean>).detail;
  });
  const toggle = el.shadowRoot.querySelector('.direct-control input') as HTMLInputElement;
  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(requested, false);
  el.remove();
});
