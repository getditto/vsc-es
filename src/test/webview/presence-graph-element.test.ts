import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { contextFor, type RecordingContext2D } from './setup.js';
import { html, render } from 'lit';

class TestResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = TestResizeObserver;

// Manual frame driver. The element's RAF loop reschedules itself every
// frame, so the shared setTimeout-based rAF from setup.ts would spin for
// the life of the process. Queueing the callbacks lets each test render an
// exact number of frames and assert on what was painted.
const frameQueue: FrameRequestCallback[] = [];
let nextFrameHandle = 1;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
  frameQueue.push(cb);
  return nextFrameHandle++;
};
(globalThis as any).cancelAnimationFrame = (): void => { frameQueue.length = 0; };

let frameClock = 0;
function drawFrame(): void {
  frameClock += 16;
  for (const cb of frameQueue.splice(0)) { cb(frameClock); }
}

await import('../../../webview-ui/presence-graph/presence-graph-element.js');

const INPUT = {
  localPeerKey: 'local',
  localDeviceName: 'Local device',
  isLocalConnectedToCloud: false,
  remotePeers: [
    { peerKey: 'alpha', deviceName: 'Alpha' },
    { peerKey: 'beta', deviceName: 'Beta' },
  ],
  connections: [
    { from: 'local', to: 'alpha', type: 'AccessPoint' as const },
    { from: 'local', to: 'beta', type: 'AccessPoint' as const },
  ],
};

/** Peers spawn at the origin and only reach their laid-out positions by
 *  easing over 500ms of frames. Snap them there so hit-testing is exact and
 *  independent of the animation clock. */
function settleLayout(el: any): void {
  const positions = el.scene.layout?.positions;
  if (!positions) { return; }
  for (const [key, pos] of positions) { el.scene.setPeerPosition(key, { ...pos }); }
  el.scene.transitions.clear();
}

async function mount(overrides: Record<string, unknown> = {}): Promise<any> {
  const el = document.createElement('ditto-presence-graph') as any;
  el.input = structuredClone(INPUT);
  Object.assign(el, overrides);
  document.body.appendChild(el);
  await el.updateComplete;
  // Canvas has no layout in jsdom; give the scene a viewport so world
  // coordinates and hit-testing are meaningful.
  el.scene.setSize(800, 600);
  settleLayout(el);
  return el;
}

/** Screen coords for a peer's current world position. */
function screenPos(el: any, key: string): { clientX: number; clientY: number } {
  const p = el.scene.peers.get(key).position;
  const zoom = el.scene.zoom;
  const cam = el.scene.camera;
  return {
    clientX: 800 / 2 + (p.x + cam.x) * zoom,
    clientY: 600 / 2 + (p.y + cam.y) * zoom,
  };
}

function mouse(type: string, init: Record<string, unknown>): MouseEvent {
  return new (globalThis as any).MouseEvent(type, { bubbles: true, ...init });
}

/** Full press → (optional move) → release on a peer. */
function clickPeer(el: any, key: string, dx = 0, dy = 0): void {
  const canvas = el.shadowRoot.querySelector('canvas');
  const at = screenPos(el, key);
  canvas.dispatchEvent(mouse('mousedown', { ...at, button: 0, buttons: 1 }));
  if (dx !== 0 || dy !== 0) {
    window.dispatchEvent(mouse('mousemove', {
      clientX: at.clientX + dx, clientY: at.clientY + dy, buttons: 1,
    }));
  }
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
}

// ─── Controls ────────────────────────────────────────────────────

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
  // A flipping accessible name must not also carry a pressed state.
  assert.equal(show.hasAttribute('aria-pressed'), false);

  show.click();
  await el.updateComplete;
  assert.ok(el.shadowRoot.querySelector('.legend'));
  el.remove();
});

test('PresenceGraphElement: eye reports visibility so the owner can persist it', async () => {
  const el = await mount();
  const seen: boolean[] = [];
  el.addEventListener('controls-visible-change', (e: Event) => {
    seen.push((e as CustomEvent<boolean>).detail);
  });

  el.shadowRoot.querySelector('[aria-label="Hide graph controls"]').click();
  await el.updateComplete;
  el.shadowRoot.querySelector('[aria-label="Show graph controls"]').click();
  await el.updateComplete;

  assert.deepEqual(seen, [false, true]);
  el.remove();
});

test('PresenceGraphElement: controlsVisible is owner-driven', async () => {
  const el = await mount({ controlsVisible: false });
  assert.equal(el.shadowRoot.querySelector('.legend'), null);
  assert.ok(el.shadowRoot.querySelector('[aria-label="Show graph controls"]'));
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

// ─── Direct-mode round trip ──────────────────────────────────────

test('PresenceGraphElement: Direct control emits and applies both directions', async () => {
  const el = await mount();
  const seen: boolean[] = [];
  el.addEventListener('direct-connected-only-change', (e: Event) => {
    seen.push((e as CustomEvent<boolean>).detail);
  });
  const toggle = () => el.shadowRoot.querySelector('.direct-control input') as HTMLInputElement;

  toggle().checked = false;
  toggle().dispatchEvent(new window.Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.equal(el.directConnectedOnly, false, 'element stays consistent with its own control');
  assert.equal(el.scene.showDirectConnectedOnly, false, 'scene follows the control');

  toggle().checked = true;
  toggle().dispatchEvent(new window.Event('change', { bubbles: true }));
  await el.updateComplete;
  assert.equal(el.directConnectedOnly, true);
  assert.equal(el.scene.showDirectConnectedOnly, true);

  assert.deepEqual(seen, [false, true], 'owner is notified in both directions');
  el.remove();
});

test('PresenceGraphElement: an owner binding false reaches the property and the scene', async () => {
  // Regression: `?direct-connected-only=${false}` on a freshly-created
  // element committed removeAttribute() on an element that never had the
  // attribute, so no callback fired and the `true` default silently won.
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    html`<ditto-presence-graph .directConnectedOnly=${false} .input=${structuredClone(INPUT)}></ditto-presence-graph>`,
    host,
  );
  const el = host.querySelector('ditto-presence-graph') as any;
  await el.updateComplete;

  assert.equal(el.directConnectedOnly, false);
  assert.equal(el.scene.showDirectConnectedOnly, false);
  assert.equal(el.shadowRoot.querySelector('.direct-control input').checked, false);
  host.remove();
});

// ─── Pointer: click vs drag ──────────────────────────────────────

test('PresenceGraphElement: a click under the drag threshold selects a peer', async () => {
  const el = await mount();
  clickPeer(el, 'alpha', 3, 0);
  assert.equal(el.scene.selectedPeerKey, 'alpha');

  // Clicking it again clears the selection.
  clickPeer(el, 'alpha');
  assert.equal(el.scene.selectedPeerKey, undefined);
  el.remove();
});

test('PresenceGraphElement: a drag past the threshold does not select', async () => {
  const el = await mount();
  clickPeer(el, 'alpha', 5, 0);
  assert.equal(el.scene.selectedPeerKey, undefined, '5px exceeds the 4px threshold');

  // And a large drag — the case the threshold exists for — also must not.
  clickPeer(el, 'beta', 120, 60);
  assert.equal(el.scene.selectedPeerKey, undefined);
  el.remove();
});

test('PresenceGraphElement: clicking empty canvas clears the selection', async () => {
  const el = await mount();
  clickPeer(el, 'alpha');
  assert.equal(el.scene.selectedPeerKey, 'alpha');

  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
  assert.equal(el.scene.selectedPeerKey, undefined);
  el.remove();
});

test('PresenceGraphElement: the local peer is not selectable', async () => {
  const el = await mount();
  clickPeer(el, 'local');
  assert.equal(el.scene.selectedPeerKey, undefined);
  el.remove();
});

test('PresenceGraphElement: a non-primary release does not end an in-flight drag', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  const at = screenPos(el, 'alpha');
  canvas.dispatchEvent(mouse('mousedown', { ...at, button: 0, buttons: 1 }));

  // Right button released while the left is still held.
  window.dispatchEvent(mouse('mouseup', { button: 2, buttons: 1 }));
  assert.equal(el.scene.selectedPeerKey, undefined, 'no selection toggled');
  assert.equal(el.scene.isUserInteracting, true, 'drag is still live');

  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
  assert.equal(el.scene.selectedPeerKey, 'alpha');
  el.remove();
});

test('PresenceGraphElement: a swallowed mouseup is recovered from on the next move', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  const at = screenPos(el, 'alpha');
  canvas.dispatchEvent(mouse('mousedown', { ...at, button: 0, buttons: 1 }));
  assert.equal(el.scene.isUserInteracting, true);

  // Release happened outside the window; the next move reports no buttons.
  window.dispatchEvent(mouse('mousemove', {
    clientX: at.clientX + 40, clientY: at.clientY, buttons: 0,
  }));

  assert.equal(el.scene.isUserInteracting, false, 'interaction released');
  assert.equal(el.scene.pinnedKeys.size, 0, 'no pin leaked');
  el.remove();
});

test('PresenceGraphElement: leaving the canvas releases hover focus', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousemove', screenPos(el, 'alpha')));
  assert.equal(el.scene.hoveredPeerKey, 'alpha');

  canvas.dispatchEvent(mouse('mouseout', {}));
  assert.equal(el.scene.hoveredPeerKey, undefined, 'graph must not stay dimmed');
  el.remove();
});

test('PresenceGraphElement: disconnect detaches window drag listeners', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');

  // Track the listeners directly; asserting "no throw" would pass even with
  // the handlers still attached, since they early-return once scene is gone.
  const live = new Set<unknown>();
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  (window as any).addEventListener = (type: string, fn: any, opts: any): void => {
    if (type === 'mousemove' || type === 'mouseup') { live.add(fn); }
    origAdd(type, fn, opts);
  };
  (window as any).removeEventListener = (type: string, fn: any, opts: any): void => {
    if (type === 'mousemove' || type === 'mouseup') { live.delete(fn); }
    origRemove(type, fn, opts);
  };

  try {
    canvas.dispatchEvent(mouse('mousedown', { ...screenPos(el, 'alpha'), button: 0, buttons: 1 }));
    assert.equal(live.size, 2, 'drag listeners attached on mousedown');

    // Panel closed mid-drag — the mouseup never arrives.
    el.remove();
    assert.equal(live.size, 0, 'both detached on disconnect');
  } finally {
    (window as any).addEventListener = origAdd;
    (window as any).removeEventListener = origRemove;
  }

  assert.equal(el.scene, undefined);
});

// ─── Rendering ───────────────────────────────────────────────────

/** Alpha of the pill fill for a peer, read off the recorded draw calls.
 *  Nodes are painted after lines, one fill + stroke + fillText each, in
 *  scene peer-map order. */
function fillAlphaByPeer(el: any, ctx: RecordingContext2D): Map<string, number> {
  const keys = [...el.scene.peers.keys()];
  const labels = keys.map(k => (el.scene.peers.get(k).isLocal ? 'Me' : el.scene.peers.get(k).label));
  const out = new Map<string, number>();
  const texts = ctx.__ops.filter(o => o.op === 'fillText');
  for (let i = 0; i < texts.length; i += 1) {
    const idx = labels.indexOf(String(texts[i].args[0]));
    if (idx >= 0) {
      // The fill immediately preceding this label is the pill body.
      const opIndex = ctx.__ops.indexOf(texts[i]);
      for (let j = opIndex - 1; j >= 0; j -= 1) {
        if (ctx.__ops[j].op === 'fill') { out.set(keys[idx], ctx.__ops[j].globalAlpha); break; }
      }
    }
  }
  return out;
}

test('PresenceGraphElement: the render loop actually paints the scene', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  ctx.__reset();
  drawFrame();

  assert.ok(ctx.__ops.some(o => o.op === 'fillText' && o.args[0] === 'Me'), 'local pill drawn');
  assert.ok(ctx.__ops.some(o => o.op === 'fillText' && o.args[0] === 'Alpha'), 'remote pill drawn');
  assert.ok(ctx.__ops.some(o => o.op === 'stroke'), 'connections drawn');
  el.remove();
});

test('PresenceGraphElement: selecting a peer dims unrelated peers and lines on canvas', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));

  ctx.__reset();
  drawFrame();
  const before = fillAlphaByPeer(el, ctx);
  assert.equal(before.get('alpha'), 0.9, 'idle fill alpha');
  assert.equal(before.get('beta'), 0.9);

  clickPeer(el, 'alpha');
  ctx.__reset();
  drawFrame();
  const after = fillAlphaByPeer(el, ctx);

  // Fill alpha is focus × the 0.9 idle factor (1.0 when selected/hovered).
  assert.equal(after.get('alpha'), 1, 'selected peer at full opacity');
  assert.equal(after.get('local'), 0.9, 'neighbour of the selection is not dimmed');
  assert.ok(
    Math.abs(after.get('beta')! - 0.25 * 0.9) < 1e-9,
    `unrelated peer dimmed to 0.225, got ${after.get('beta')}`,
  );

  // The selected peer's link keeps full alpha and the emphasized stroke;
  // the unrelated link is pushed well back.
  const strokes = ctx.__ops.filter(o => o.op === 'stroke');
  assert.ok(strokes.some(o => o.globalAlpha === 1 && o.lineWidth === 3), 'selected link emphasized');
  assert.ok(strokes.some(o => o.globalAlpha < 0.1 && o.lineWidth === 2), 'unrelated link receded');
  el.remove();
});

test('PresenceGraphElement: a stale hover does not out-emphasize the selection', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  const ctx = contextFor(canvas);

  clickPeer(el, 'alpha');
  // Hover beta — its link is highlighted, but it is not the focus.
  canvas.dispatchEvent(mouse('mousemove', screenPos(el, 'beta')));
  ctx.__reset();
  drawFrame();

  const receded = ctx.__ops.filter(o => o.op === 'stroke' && o.globalAlpha < 0.1);
  assert.ok(receded.length > 0, 'the hovered-but-unfocused link is still dimmed');
  assert.ok(receded.every(o => o.lineWidth === 2), 'and is not given the 3px emphasis');
  el.remove();
});
