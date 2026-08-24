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
const frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const handle = nextFrameHandle++;
  frameQueue.set(handle, cb);
  return handle;
};
// Honour the handle: clearing the whole queue would let one element's
// teardown permanently starve another mounted element's loop.
(globalThis as any).cancelAnimationFrame = (handle: number): void => {
  frameQueue.delete(handle);
};

// Anchored to the real clock on first use: position transitions stamp
// `tStart` from performance.now(), so a frame timestamp starting at 0 would
// make every transition read as not-yet-started.
let frameClock = 0;
function drawFrame(advanceMs = 16): void {
  frameClock = Math.max(frameClock, performance.now()) + advanceMs;
  const due = [...frameQueue.entries()];
  frameQueue.clear();
  for (const [, cb] of due) { cb(frameClock); }
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
  // `as any` is load-bearing: the test reaches for the element's own
  // properties and its shadow root, neither of which is on `Element`.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
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

test('PresenceGraphElement: re-attaching the element recreates the scene and keeps painting', async () => {
  // VS Code reparents webview panels when they move between editor groups:
  // connectedCallback re-runs on the same element, but firstUpdated does
  // not — so a scene torn down in disconnectedCallback must be recreated
  // here or the canvas stays blank for the rest of the panel's life.
  const el = await mount();
  const firstScene = el.scene;

  el.remove();
  assert.equal(el.scene, undefined, 'scene torn down on disconnect');

  document.body.appendChild(el);
  await el.updateComplete;
  assert.ok(el.scene, 'scene recreated on re-attach');
  assert.notEqual(el.scene, firstScene);
  assert.ok(el.resizeObserver, 'resize observer recreated');

  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  ctx.__reset();
  drawFrame();
  assert.ok(ctx.__ops.some(o => o.op === 'fillText' && o.args[0] === 'Me'), 'paints after re-attach');
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

/** Per-peer record of how the pill was painted, keyed by peer.
 *
 *  Peers are drawn last, one `fill` → `stroke` → `fillText` triple each, in
 *  `scene.peers` insertion order — so the i-th label op IS the i-th peer.
 *  Resolving by label text instead would silently mis-attribute when two
 *  devices share a name, which is entirely ordinary. */
interface PaintedPeer { fillAlpha: number; strokeWidth: number; x: number; y: number }
function paintedPeers(el: any, ctx: RecordingContext2D): Map<string, PaintedPeer> {
  const keys = [...el.scene.peers.keys()];
  const out = new Map<string, PaintedPeer>();
  const textIndices = ctx.__ops
    .map((o, i) => (o.op === 'fillText' ? i : -1))
    .filter(i => i >= 0);
  assert.equal(textIndices.length, keys.length, 'one label painted per peer');

  textIndices.forEach((opIndex, i) => {
    let fillAlpha = NaN;
    let strokeWidth = NaN;
    for (let j = opIndex - 1; j >= 0; j -= 1) {
      const op = ctx.__ops[j];
      if (op?.op === 'stroke' && Number.isNaN(strokeWidth)) {
        strokeWidth = op.lineWidth;
      } else if (op?.op === 'fill') {
        fillAlpha = op.globalAlpha;
        break;
      }
    }
    out.set(keys[i], {
      fillAlpha,
      strokeWidth,
      x: ctx.__ops[opIndex]?.tx ?? NaN,
      y: ctx.__ops[opIndex]?.ty ?? NaN,
    });
  });
  return out;
}

function fillAlphaByPeer(el: any, ctx: RecordingContext2D): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, p] of paintedPeers(el, ctx)) { out.set(k, p.fillAlpha); }
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

test('PresenceGraphElement: a swallowed mouseup does not fire a phantom click', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousedown', { ...screenPos(el, 'alpha'), button: 0, buttons: 1 }));

  // Released somewhere we never saw; the pointer later wanders back in.
  window.dispatchEvent(mouse('mousemove', { clientX: 5, clientY: 5, buttons: 0 }));

  assert.equal(el.scene.selectedPeerKey, undefined, 'the abandoned press must not select');
  el.remove();
});

test('PresenceGraphElement: a swallowed pan does not clear an existing selection', async () => {
  const el = await mount();
  clickPeer(el, 'alpha');
  assert.equal(el.scene.selectedPeerKey, 'alpha');

  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 6, clientY: 6, buttons: 0 }));

  assert.equal(el.scene.selectedPeerKey, 'alpha', 'selection survives an abandoned pan');
  el.remove();
});

test('PresenceGraphElement: a drag ending off-canvas releases hover', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousemove', screenPos(el, 'alpha')));
  assert.equal(el.scene.hoveredPeerKey, 'alpha');

  canvas.dispatchEvent(mouse('mousedown', { ...screenPos(el, 'alpha'), button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mousemove', { clientX: 900, clientY: 900, buttons: 1 }));
  canvas.dispatchEvent(mouse('mouseout', {}));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));

  assert.equal(el.scene.hoveredPeerKey, undefined, 'graph must not stay dimmed after the drag');
  el.remove();
});

test('PresenceGraphElement: hover is kept while dragging across the canvas edge', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousemove', screenPos(el, 'alpha')));
  canvas.dispatchEvent(mouse('mousedown', { ...screenPos(el, 'alpha'), button: 0, buttons: 1 }));

  canvas.dispatchEvent(mouse('mouseout', {}));
  assert.equal(el.scene.hoveredPeerKey, 'alpha', 'the dragged peer keeps its highlight');

  // Dragged back in and released over the canvas — hover stays. The release
  // carries real coordinates, as a browser's mouseup always does: hover is
  // recomputed from the release point, not restored from before the drag.
  canvas.dispatchEvent(mouse('mousemove', { ...screenPos(el, 'alpha'), buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { ...screenPos(el, 'alpha'), button: 0, buttons: 0 }));
  assert.equal(el.scene.hoveredPeerKey, 'alpha');
  el.remove();
});

test('PresenceGraphElement: releasing a press recomputes hover from the release point', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  // Press on empty canvas, then release over a peer with no intervening
  // move — hover updates are suppressed while the press is active, so
  // without a recompute the peer under the pointer would stay un-hovered
  // (and the cursor un-pointered) until the next mousemove.
  canvas.dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { ...screenPos(el, 'alpha'), button: 0, buttons: 0 }));

  assert.equal(el.scene.hoveredPeerKey, 'alpha');
  assert.equal(el.hoveringNode, true, 'cursor affordance matches');
  el.remove();
});

// ─── Geometry: camera, zoom, layout animation ────────────────────

test('PresenceGraphElement: peers are painted at their laid-out positions', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  ctx.__reset();
  drawFrame();
  const painted = paintedPeers(el, ctx);

  for (const [key, node] of el.scene.peers) {
    assert.ok(
      Math.abs(painted.get(key)!.x - (400 + node.position.x)) < 1e-6
      && Math.abs(painted.get(key)!.y - (300 + node.position.y)) < 1e-6,
      `${key} painted at its world position`,
    );
  }
  // And they are not all stacked on one another.
  const ys = [...painted.values()].map(p => p.y);
  assert.ok(new Set(ys).size > 1, 'peers occupy distinct positions');
  el.remove();
});

test('PresenceGraphElement: camera pan and zoom move what is painted', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  ctx.__reset();
  drawFrame();
  const before = paintedPeers(el, ctx).get('alpha')!;

  el.scene.panBy(60, 25);
  ctx.__reset();
  drawFrame();
  const panned = paintedPeers(el, ctx).get('alpha')!;
  assert.ok(Math.abs(panned.x - (before.x + 60)) < 1e-6, 'pan shifts x by the delta');
  assert.ok(Math.abs(panned.y - (before.y + 25)) < 1e-6, 'pan shifts y by the delta');

  el.scene.setZoom(2);
  ctx.__reset();
  drawFrame();
  const zoomed = paintedPeers(el, ctx).get('alpha')!;
  // screen = centre + zoom * (world + camera)
  const cam = el.scene.camera;
  const world = el.scene.peers.get('alpha').position;
  assert.ok(Math.abs(zoomed.x - (400 + 2 * (world.x + cam.x))) < 1e-6, 'zoom scales about the centre');
  el.remove();
});

test('PresenceGraphElement: zoom buttons and the wheel move zoom the right way', async () => {
  const el = await mount();
  const buttons = [...el.shadowRoot.querySelectorAll('[aria-label="Zoom controls"] button')];
  const zoomOut = buttons[0] as HTMLButtonElement;
  const zoomIn = buttons[1] as HTMLButtonElement;

  zoomIn.click();
  await el.updateComplete;
  assert.ok(el.scene.zoom > 1, `zoom in increases zoom, got ${el.scene.zoom}`);
  assert.equal(el.shadowRoot.querySelector('.zoom-label').textContent, '110%');

  zoomOut.click();
  zoomOut.click();
  await el.updateComplete;
  assert.ok(el.scene.zoom < 1, `zoom out decreases zoom, got ${el.scene.zoom}`);

  const canvas = el.shadowRoot.querySelector('canvas');
  const at = el.scene.zoom;
  // Wheel is deliberately inverted vs the web default: down = zoom out.
  canvas.dispatchEvent(new (globalThis as any).WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  assert.ok(el.scene.zoom < at, 'wheel down zooms out');
  el.remove();
});

test('PresenceGraphElement: layout transitions ease peers away from the origin', async () => {
  // Deliberately does NOT call settleLayout: this is the animation path that
  // strands peers on top of Me when it regresses.
  const el = document.createElement('ditto-presence-graph') as any;
  el.input = structuredClone(INPUT);
  document.body.appendChild(el);
  await el.updateComplete;
  el.scene.setSize(800, 600);

  const target = el.scene.layout.positions.get('alpha');
  assert.ok(Math.abs(target.y) > 50, 'layout puts alpha well off the origin');
  assert.deepEqual(el.scene.peers.get('alpha').position, { x: 0, y: 0 }, 'spawns at the origin');

  // Half the 500ms transition, then past the end.
  drawFrame(250);
  const mid = { ...el.scene.peers.get('alpha').position };
  assert.ok(Math.abs(mid.y) > 1, 'peer has started moving');
  assert.ok(Math.abs(mid.y) < Math.abs(target.y), 'and has not arrived yet');

  drawFrame(400);
  const end = el.scene.peers.get('alpha').position;
  assert.ok(Math.abs(end.y - target.y) < 1e-6, 'peer settles exactly on its target');
  el.remove();
});

test('PresenceGraphElement: the pill hit area covers the pill, not just its centre', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  const node = el.scene.peers.get('alpha');
  const halfWidth = ctx.measureText(node.label).width / 2 + 11.25;

  // Just inside the right edge selects; comfortably outside does not.
  const centre = screenPos(el, 'alpha');
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousedown', {
    clientX: centre.clientX + halfWidth - 2, clientY: centre.clientY, button: 0, buttons: 1,
  }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
  assert.equal(el.scene.selectedPeerKey, 'alpha', 'a click near the pill edge still hits');

  canvas.dispatchEvent(mouse('mousedown', {
    clientX: centre.clientX + halfWidth + 20, clientY: centre.clientY, button: 0, buttons: 1,
  }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
  assert.equal(el.scene.selectedPeerKey, undefined, 'a click past the pill misses');
  el.remove();
});

test('PresenceGraphElement: the star field is painted behind the graph', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  ctx.__reset();
  drawFrame();

  // Only stars and peer pills emit `fill` for this input (cloud circles are
  // the sole other source and there is no cloud peer here), and stars are
  // painted first — so any fill beyond one-per-peer is a star.
  const peerCount = el.scene.peers.size;
  const starsOf = (): string => {
    const fills = ctx.__ops.filter(o => o.op === 'fill');
    assert.ok(fills.length > peerCount, `star field drawn, got ${fills.length} fills for ${peerCount} peers`);
    return fills.slice(0, fills.length - peerCount).map(o => `${o.tx},${o.ty}`).join('|');
  };

  const before = starsOf();
  ctx.__reset();
  drawFrame(100);
  assert.notEqual(starsOf(), before, 'star field advances between frames');
  el.remove();
});

// ─── RAF loop settle/wake ─────────────────────────────────────

test('PresenceGraphElement: the loop settles after an idle period and wakes on new input', async () => {
  // The star field is ambient decoration — a visible-but-idle panel must not
  // repaint at 60fps for its whole life. After a short idle window the loop
  // paints a final static frame and goes dark until something changes.
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));

  // Shrink the idle window (its 3s default is tuned for humans) and restart it.
  el.starIdleMs = 20;
  el.wake();
  drawFrame();
  assert.notEqual(el.rafHandle, undefined, 'loop running after wake');

  // Real time passes with no interaction and no host traffic…
  await new Promise(r => setTimeout(r, 60));
  // …the running frame paints the final static frame and stops.
  drawFrame();
  assert.equal(el.rafHandle, undefined, 'loop settled after the idle window');
  assert.equal(frameQueue.size, 0, 'no further frame queued');

  // A host push (peer.state → input property) wakes the loop and paints.
  ctx.__reset();
  el.input = structuredClone(INPUT);
  await el.updateComplete;
  assert.notEqual(el.rafHandle, undefined, 'loop restarted by a host push');
  drawFrame();
  assert.ok(ctx.__ops.some(o => o.op === 'fillText' && o.args[0] === 'Me'), 'paints after wake');
  el.remove();
});

test('PresenceGraphElement: pointer interaction wakes a settled loop and repaints', async () => {
  const el = await mount();
  el.starIdleMs = 20;
  el.wake();
  await new Promise(r => setTimeout(r, 60));
  drawFrame();
  assert.equal(el.rafHandle, undefined, 'loop settled');

  const canvas = el.shadowRoot.querySelector('canvas');
  const ctx = contextFor(canvas);
  ctx.__reset();
  canvas.dispatchEvent(mouse('mousemove', screenPos(el, 'alpha')));
  assert.notEqual(el.rafHandle, undefined, 'hover wakes the loop');
  assert.equal(el.scene.hoveredPeerKey, 'alpha');
  drawFrame();
  assert.ok(ctx.__ops.some(o => o.op === 'fillText'), 'repaint reflects the interaction');
  el.remove();
});

test('PresenceGraphElement: a renamed peer gets a fresh pill width in a new scene', async () => {
  // The pill-width cache is module-global and outlives a scene, but the graph
  // tab rebuilds the scene on every switch. A device renamed while the tab was
  // hidden used to keep the old width — wrong text bounds and a wrong hit box.
  const first = await mount();
  const shortHalfWidth = contextFor(first.shadowRoot.querySelector('canvas'))
    .measureText('Alpha').width / 2 + 11.25;
  first.remove();

  const longName = 'Alpha With A Very Much Longer Device Name';
  const el = document.createElement('ditto-presence-graph') as any;
  el.input = {
    ...structuredClone(INPUT),
    remotePeers: [{ peerKey: 'alpha', deviceName: longName }, { peerKey: 'beta', deviceName: 'Beta' }],
  };
  document.body.appendChild(el);
  await el.updateComplete;
  el.scene.setSize(800, 600);
  settleLayout(el);

  const canvas = el.shadowRoot.querySelector('canvas');
  const longHalfWidth = contextFor(canvas).measureText(longName).width / 2 + 11.25;
  assert.ok(longHalfWidth > shortHalfWidth + 40, 'the fixture names differ enough to matter');

  // A point inside the renamed pill but well outside the stale one.
  const centre = screenPos(el, 'alpha');
  canvas.dispatchEvent(mouse('mousedown', {
    clientX: centre.clientX + shortHalfWidth + 20, clientY: centre.clientY, button: 0, buttons: 1,
  }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));

  assert.equal(el.scene.selectedPeerKey, 'alpha', 'hit box reflects the new name');
  el.remove();
});
