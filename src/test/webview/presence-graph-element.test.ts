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
import { drawConnectionLine, type ConnectionLineData } from '../../../webview-ui/presence-graph/connection-line.js';
import { CONNECTION_STYLES, type ConnectionTypeName } from '../../../webview-ui/presence-graph/colors.js';
import type { PresencePeerCardDetail } from '../../../webview-ui/presence-graph/peer-detail.js';
import {
  perpendicularControlPoint,
  outwardControlPoint,
} from '../../../src/presence/NetworkLayoutEngine.js';

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

test('PresenceGraphElement: background effects default on and can be disabled', async () => {
  const el = await mount();
  const canvas = el.shadowRoot.querySelector('canvas');
  const ctx = contextFor(canvas);
  const toggle = el.shadowRoot.querySelector('[aria-label="Background effects"]') as HTMLButtonElement;

  assert.equal(el.scene.backgroundEffectsEnabled, true);
  assert.equal(el.hasAttribute('data-background-effects-off'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');

  ctx.__reset();
  drawFrame();
  const enabledFills = ctx.__ops.filter(op => op.op === 'fill').length;
  assert.ok(enabledFills >= 160, `enabled background should paint the star field, got ${enabledFills} fills`);

  toggle.click();
  await el.updateComplete;

  assert.equal(el.scene.backgroundEffectsEnabled, false);
  assert.equal(el.hasAttribute('data-background-effects-off'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.match(toggle.title, /Turn on/);

  ctx.__reset();
  drawFrame();
  const disabledFills = ctx.__ops.filter(op => op.op === 'fill').length;
  assert.ok(disabledFills < enabledFills - 100, 'disabled background should skip the star field');
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

test('PresenceGraphElement: scaled canvas hit-testing opens a focused peer card', async () => {
  const el = await mountFocused();
  const canvas = el.shadowRoot.querySelector('canvas');
  const originalRect = canvas.getBoundingClientRect;
  canvas.getBoundingClientRect = () => ({
    left: 100, top: 50, width: 400, height: 300,
    right: 500, bottom: 350, x: 100, y: 50,
    toJSON: () => ({}),
  } as DOMRect);

  const at = focusScreenPos(el, 'beta');
  const scaled = { clientX: 100 + at.clientX / 2, clientY: 50 + at.clientY / 2 };
  canvas.dispatchEvent(mouse('mousemove', scaled));
  assert.equal(el.hoveringNode, true, 'scaled pointer position should be over beta');
  assert.equal(el.scene.hoveredPeerKey, 'beta');
  await el.updateComplete;
  assert.equal(canvas.classList.contains('hover-node'), true, 'peer hover uses the pointer cursor class');

  canvas.dispatchEvent(mouse('mousedown', { ...scaled, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { ...scaled, button: 0, buttons: 0 }));
  await el.updateComplete;
  assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Beta');

  canvas.getBoundingClientRect = originalRect;
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

test('PresenceGraphElement: full-mesh selection shows and exits focused node view', async () => {
  const el = await mount({
    directConnectedOnly: false,
    input: {
      ...structuredClone(INPUT),
      remotePeers: [
        { peerKey: 'alpha', deviceName: 'Alpha' },
        { peerKey: 'beta', deviceName: 'Beta' },
        { peerKey: 'gamma', deviceName: 'Gamma' },
      ],
      connections: [
        { from: 'local', to: 'alpha', type: 'AccessPoint' as const },
        { from: 'alpha', to: 'beta', type: 'Bluetooth' as const },
        { from: 'alpha', to: 'gamma', type: 'P2PWiFi' as const },
      ],
    },
  });
  clickPeer(el, 'alpha');
  await el.updateComplete;
  assert.equal(el.scene.isFocusedView, true);
  assert.ok(el.shadowRoot.querySelector('[aria-label="Exit focused node view and show full mesh"]'));

  el.scene.tick(performance.now() + 700, 0);
  const focusedAlpha = el.scene.focusAnimation.toPositions.get('alpha');
  assert.deepEqual(focusedAlpha, { x: 0, y: 0 });
  assert.equal(el.scene.focusAnimation.toPositions.has('beta'), true);
  assert.equal(el.scene.focusAnimation.toPositions.has('local'), true);

  el.shadowRoot.querySelector('[aria-label="Exit focused node view and show full mesh"]').click();
  await el.updateComplete;
  el.scene.tick(performance.now() + 700, 0);
  el.requestUpdate();
  await el.updateComplete;
  assert.equal(el.scene.isFocusedView, false);
  assert.equal(el.shadowRoot.querySelector('[aria-label="Exit focused node view and show full mesh"]'), null);
  el.remove();
});

test('PresenceGraphElement: zoom controls operate on the focused neighbourhood', async () => {
  const el = await mount({ directConnectedOnly: false });
  clickPeer(el, 'alpha');
  await el.updateComplete;

  const backgroundZoom = el.scene.zoom;
  const focusZoom = el.scene.activeZoom;
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(new (globalThis as any).WheelEvent('wheel', {
    deltaY: -120,
    bubbles: true,
    cancelable: true,
  }));
  await el.updateComplete;

  assert.ok(el.scene.activeZoom > focusZoom, 'wheel zooms the focused neighbourhood in');
  assert.equal(el.scene.zoom, backgroundZoom, 'background zoom remains unchanged');
  assert.equal(
    el.shadowRoot.querySelector('.zoom-label').textContent,
    `${Math.round(el.scene.activeZoom * 100)}%`,
  );
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

test('PresenceGraphElement: searchMatchKeys dims non-matching peers and lines on canvas', async () => {
  const el = await mount();
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));

  el.searchMatchKeys = new Set(['alpha']);
  await el.updateComplete;
  ctx.__reset();
  drawFrame();
  const alphas = fillAlphaByPeer(el, ctx);

  assert.equal(alphas.get('alpha'), 0.9, 'match keeps idle opacity');
  assert.ok(
    Math.abs(alphas.get('beta')! - 0.25 * 0.9) < 1e-9,
    `non-match dimmed to 0.225, got ${alphas.get('beta')}`,
  );
  assert.ok(
    Math.abs(alphas.get('local')! - 0.25 * 0.9) < 1e-9,
    'local peer dims too when it is not a match',
  );

  const strokes = ctx.__ops.filter(o => o.op === 'stroke');
  assert.ok(strokes.some(o => o.globalAlpha === 1), 'the matched peer\u2019s link stays full');
  assert.ok(strokes.some(o => o.globalAlpha < 0.1), 'the untouched link recedes');

  el.searchMatchKeys = undefined;
  await el.updateComplete;
  ctx.__reset();
  drawFrame();
  assert.equal(fillAlphaByPeer(el, ctx).get('beta'), 0.9, 'clearing the query restores opacity');
  el.remove();
});

test('PresenceGraphElement: focusPeer() selects like a full-mesh canvas click', async () => {
  const el = await mount({ directConnectedOnly: false });
  el.focusPeer('alpha');
  await el.updateComplete;

  assert.equal(el.scene.isFocusedView, true);
  assert.equal(el.scene.selectedPeerKey, 'alpha');
  assert.ok(el.shadowRoot.querySelector('.focus-banner'), 'focus banner is shown');
  el.remove();
});

test('PresenceGraphElement: focusPeer() out of Direct mode defers to the rebuilt input', async () => {
  const el = await mount();
  let modeEvent: boolean | undefined;
  el.addEventListener('direct-connected-only-change', (e: any) => { modeEvent = e.detail; });

  el.focusPeer('alpha');

  assert.equal(el.directConnectedOnly, false, 'flips Direct off like the checkbox does');
  assert.equal(modeEvent, false, 'and reports it through the same event');
  assert.equal(el.scene.isFocusedView, false, 'focus waits for the full-mesh input');

  // The parent's half of the contract: rebuild input for the new mode and
  // push it. Only then may the peer be focused — in Direct mode a searched
  // peer may not even exist in the scene.
  el.input = { ...structuredClone(INPUT) };
  await el.updateComplete;

  assert.equal(el.scene.selectedPeerKey, 'alpha');
  assert.equal(el.scene.isFocusedView, true);
  el.remove();
});

// ─── Peer detail card ───────────────────────────────────────────

/** Alpha's focus orbit is {alpha, local, beta}: local↔alpha and alpha↔beta. */
const FOCUS_INPUT = {
  localPeerKey: 'local',
  localDeviceName: 'Local device',
  isLocalConnectedToCloud: false,
  remotePeers: [
    { peerKey: 'alpha', deviceName: 'Alpha' },
    { peerKey: 'beta', deviceName: 'Beta' },
  ],
  connections: [
    { from: 'local', to: 'alpha', type: 'AccessPoint' as const },
    { from: 'alpha', to: 'beta', type: 'Bluetooth' as const },
  ],
};

function detailFixture(): Map<string, PresencePeerCardDetail> {
  return new Map<string, PresencePeerCardDetail>([
    ['local', {
      peerKey: 'local', displayName: 'Me', isLocal: true,
      os: 'macOS', sdkVersion: '5.1.0', cloudLink: true, isCompatible: undefined,
      peerMetadataKeyCount: 0, identityMetadataKeyCount: 0,
      isDirectlyConnected: false,
    }],
    ['alpha', {
      peerKey: 'alpha', displayName: 'Alpha', isLocal: false,
      os: 'iOS', sdkVersion: '5.0.0', cloudLink: false, isCompatible: true,
      peerMetadataKeyCount: 2, identityMetadataKeyCount: 0,
      isDirectlyConnected: true, syncedUpToLocalCommitId: 42,
      lastUpdateReceivedTime: Date.now() - 120_000,
    }],
    ['beta', {
      peerKey: 'beta', displayName: 'Beta', isLocal: false,
      os: 'Android', sdkVersion: '5.1.2', cloudLink: true, isCompatible: false,
      peerMetadataKeyCount: 3, identityMetadataKeyCount: 1,
      isDirectlyConnected: false,
    }],
  ]);
}

/** Mounts in the full mesh with card data and focuses alpha. */
async function mountFocused(): Promise<any> {
  const el = await mount({
    directConnectedOnly: false,
    input: structuredClone(FOCUS_INPUT),
    peerDetails: detailFixture(),
  });
  clickPeer(el, 'alpha');
  await el.updateComplete;
  return el;
}

/** Screen coords of a peer's FOCUSED-orbit position (the mesh `peers[].position`
 *  still holds the background layout while focus view is up). */
function focusScreenPos(el: any, key: string): { clientX: number; clientY: number } {
  const p = el.scene.focusAnimation.toPositions.get(key);
  const zoom = el.scene.activeZoom;
  return { clientX: 800 / 2 + p.x * zoom, clientY: 600 / 2 + p.y * zoom };
}

function clickPeerInFocus(el: any, key: string): void {
  const canvas = el.shadowRoot.querySelector('canvas');
  const at = focusScreenPos(el, key);
  canvas.dispatchEvent(mouse('mousedown', { ...at, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
}

function clickCanvas(el: any): void {
  const canvas = el.shadowRoot.querySelector('canvas');
  canvas.dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { button: 0, buttons: 0 }));
}

function detailCard(el: any): any {
  return el.shadowRoot.querySelector('.peer-detail-card');
}

/** Read the foreground pill's painted location, independently of hit-testing. */
function paintedFocusPeer(el: any, label: string): { clientX: number; clientY: number } {
  const ctx = contextFor(el.shadowRoot.querySelector('canvas'));
  // Settle this scene without advancing the shared RAF clock for later tests.
  el.scene.tick(performance.now() + 700, 0);
  ctx.__reset();
  el.renderScene();
  const text = ctx.__ops.filter(op => op.op === 'fillText' && op.args[0] === label).at(-1);
  assert.ok(text, `the focused layer paints ${label}`);
  return { clientX: text.tx, clientY: text.ty };
}

function clickAt(el: any, at: { clientX: number; clientY: number }): void {
  el.shadowRoot.querySelector('canvas').dispatchEvent(mouse('mousedown', { ...at, button: 0, buttons: 1 }));
  window.dispatchEvent(mouse('mouseup', { ...at, button: 0, buttons: 0 }));
}

test('PresenceGraphElement: rendered focus peers open their cards after panning and zooming the mesh', async () => {
  const el = await mount({
    directConnectedOnly: false,
    input: structuredClone(FOCUS_INPUT),
    peerDetails: detailFixture(),
  });
  try {
    el.scene.setZoom(0.75);
    el.scene.panBy(145, -85);
    const backgroundCamera = { ...el.scene.camera };
    clickPeer(el, 'alpha');
    await el.updateComplete;

    for (const [key, label] of [['beta', 'Beta'], ['alpha', 'Alpha'], ['local', 'Me']] as const) {
      const at = paintedFocusPeer(el, label);
      el.shadowRoot.querySelector('canvas').dispatchEvent(mouse('mousemove', { ...at, buttons: 0 }));
      assert.equal(el.scene.hoveredPeerKey, key, 'hover follows the painted pill');
      clickAt(el, at);
      await el.updateComplete;
      assert.equal(detailCard(el)?.getAttribute('aria-label'), `Details for ${label}`);
      assert.equal(el.scene.focusedKey, 'alpha', 'inspection preserves focus');
      el.closeDetail();
      await el.updateComplete;
    }

    el.shadowRoot.querySelector('[aria-label="Exit focused node view and show full mesh"]').click();
    await el.updateComplete;
    assert.deepEqual(el.scene.camera, backgroundCamera, 'inspection preserves the full-mesh camera');
    assert.equal(el.scene.activeZoom, 0.75);
  } finally {
    el.remove();
  }
});

test('PresenceGraphElement: panning focus moves the visible peers and keeps their cards clickable', async () => {
  const el = await mountFocused();
  try {
    const backgroundCamera = { ...el.scene.camera };
    const before = paintedFocusPeer(el, 'Beta');
    const canvas = el.shadowRoot.querySelector('canvas');
    canvas.dispatchEvent(mouse('mousedown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }));
    window.dispatchEvent(mouse('mousemove', { clientX: 65, clientY: 30, buttons: 1 }));
    window.dispatchEvent(mouse('mouseup', { clientX: 65, clientY: 30, button: 0, buttons: 0 }));
    const after = paintedFocusPeer(el, 'Beta');
    assert.ok(Math.abs(after.clientX - before.clientX - 60) < 1e-6, 'visible focus pans horizontally');
    assert.ok(Math.abs(after.clientY - before.clientY - 25) < 1e-6, 'visible focus pans vertically');
    assert.deepEqual(el.scene.camera, backgroundCamera, 'focus panning preserves the background camera');
    clickAt(el, after);
    await el.updateComplete;
    assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Beta');
    el.closeDetail();
    await el.updateComplete;
    el.shadowRoot.querySelector('[aria-label="Reset zoom and center local device"]').click();
    await el.updateComplete;
    const centred = paintedFocusPeer(el, 'Alpha');
    assert.deepEqual(centred, { clientX: 400, clientY: 300 }, 'reset recentres the focused peer');
    assert.equal(el.scene.activeZoom, 1);
    clickAt(el, centred);
    await el.updateComplete;
    assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Alpha');
    assert.deepEqual(el.scene.camera, backgroundCamera);
  } finally {
    el.remove();
  }
});

function rowValue(card: any, label: string): { text: string | null; missing: boolean } {
  const row = [...card.querySelectorAll('.peer-detail-row')]
    .find((r: any) => r.querySelector('.label')?.textContent === label);
  const v = row?.querySelector('.value');
  return { text: v?.textContent ?? null, missing: !!v && v.classList.contains('missing') };
}

test('PresenceGraphElement: tapping an orbit peer opens and closes its detail card (accordion)', async () => {
  const el = await mountFocused();
  assert.equal(detailCard(el), null);

  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Beta');

  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  assert.equal(detailCard(el), null, 're-tap closes the card');

  // The tap never steals focus from the mesh view it belongs to.
  assert.equal(el.scene.isFocusedView, true);
  assert.equal(el.scene.focusedKey, 'alpha', 'tapping a peer shows its card; it does not refocus');
  el.remove();
});

test('PresenceGraphElement: tapping another orbit peer swaps the open card', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  clickPeerInFocus(el, 'local');
  await el.updateComplete;

  const card = detailCard(el);
  assert.equal(card?.getAttribute('aria-label'), 'Details for Me', 'accordion: the other card replaces');
  assert.ok(card.textContent.includes('This device'), 'the local device gets its sync-free section');
  el.remove();
});

test('PresenceGraphElement: a canvas tap dismisses the card but keeps focus; the next tap exits focus', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;

  clickCanvas(el);
  await el.updateComplete;
  assert.equal(detailCard(el), null, 'card dismissed');
  assert.equal(el.scene.isFocusedView, true, 'focus kept — closing an inspector is not backing out');

  clickCanvas(el);
  await el.updateComplete;
  assert.equal(el.scene.isFocusedView, false, 'with no card up, the canvas tap exits focus');
  el.remove();
});

test('PresenceGraphElement: exiting focus via the banner takes the card with it', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;

  el.shadowRoot.querySelector('[aria-label="Exit focused node view and show full mesh"]').click();
  await el.updateComplete;
  assert.equal(el.scene.isFocusedView, false);
  assert.equal(detailCard(el), null, 'the card belongs to the focus session that ended');
  el.remove();
});

test('PresenceGraphElement: the card closes when its peer leaves the mesh', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;

  const remaining = detailFixture();
  remaining.delete('beta');
  el.peerDetails = remaining;
  await el.updateComplete;

  assert.equal(detailCard(el), null, 'a card anchored to a vanished peer must not survive it');
  el.remove();
});

test('PresenceGraphElement: the card shows presence facts, metadata counts, and explicit missing copy', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  const card = detailCard(el);

  assert.deepEqual(rowValue(card, 'OS'), { text: 'Android', missing: false });
  assert.deepEqual(rowValue(card, 'Ditto SDK'), { text: '5.1.2', missing: false });
  assert.deepEqual(rowValue(card, 'Cloud link'), { text: 'Connected', missing: false });
  assert.deepEqual(rowValue(card, 'Compatible'), { text: 'No', missing: false });
  assert.deepEqual(rowValue(card, 'Peer metadata'), { text: '3 keys', missing: false });
  assert.deepEqual(rowValue(card, 'Identity metadata'), { text: '1 key', missing: false });
  assert.ok(card.textContent.includes('No sync session — not directly connected'),
    'an indirect peer says why there are no sync rows');
  el.remove();
});

test('PresenceGraphElement: a directly connected peer gets sync rows with placeholders and relative time', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'alpha');
  await el.updateComplete;
  const card = detailCard(el);

  assert.deepEqual(rowValue(card, 'Synced to commit'), { text: '42', missing: false });
  const lastUpdate = rowValue(card, 'Last update');
  assert.equal(lastUpdate.missing, false);
  assert.match(lastUpdate.text!, /^\d+ min ago$/, `relative time, got ${lastUpdate.text}`);

  // The focused peer itself gets no "Focus this peer" action…
  assert.equal(card.querySelector('.peer-detail-focus'), null);
  el.remove();
});

test('PresenceGraphElement: the copy icon copies the entire peer key and confirms without closing the card', async t => {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (key: string) => { writes.push(key); } },
  });
  t.after(() => {
    if (original) { Object.defineProperty(navigator, 'clipboard', original); }
    else { Reflect.deleteProperty(navigator, 'clipboard'); }
  });
  const key = 'abcdef0123456789'.repeat(8);
  const el = await mountFocused();
  t.after(() => el.remove());
  // Keep the graph key and card record consistent, as a real snapshot does.
  el.input = {
    ...structuredClone(FOCUS_INPUT),
    remotePeers: [{ peerKey: 'alpha', deviceName: 'Alpha' }, { peerKey: key, deviceName: 'Beta' }],
    connections: [{ from: 'local', to: 'alpha', type: 'AccessPoint' }, { from: 'alpha', to: key, type: 'Bluetooth' }],
  };
  const details = detailFixture();
  details.set(key, { ...details.get('beta')!, peerKey: key });
  details.delete('beta');
  el.peerDetails = details;
  await el.updateComplete;
  clickPeerInFocus(el, key);
  await el.updateComplete;
  assert.equal(rowValue(detailCard(el), 'Peer key').text, key);
  detailCard(el).querySelector('[aria-label="Copy peer key"]').click();
  await Promise.resolve();
  await el.updateComplete;
  assert.deepEqual(writes, [key]);
  assert.equal(detailCard(el).querySelector('[role="status"]').textContent, 'Copied');
  assert.equal(el.scene.focusedKey, 'alpha');
  el.closeDetail();
  await el.updateComplete;
  clickPeerInFocus(el, key);
  await el.updateComplete;
  assert.equal(detailCard(el).querySelector('[role="status"]').textContent, '', 'reopening clears feedback');
});

test('PresenceGraphElement: clipboard errors are visible and a late result cannot change another peer card', async t => {
  let rejectCopy!: (reason: Error) => void;
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: () => new Promise<void>((_resolve, reject) => { rejectCopy = reject; }) },
  });
  t.after(() => {
    if (original) { Object.defineProperty(navigator, 'clipboard', original); }
    else { Reflect.deleteProperty(navigator, 'clipboard'); }
  });
  const el = await mountFocused();
  t.after(() => el.remove());
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  detailCard(el).querySelector('[aria-label="Copy peer key"]').click();
  clickPeerInFocus(el, 'local');
  await el.updateComplete;
  rejectCopy(new Error('Clipboard denied'));
  await Promise.resolve();
  await el.updateComplete;
  assert.equal(detailCard(el).querySelector('[role="status"]').textContent, '', 'old request is ignored');
  detailCard(el).querySelector('[aria-label="Copy peer key"]').click();
  rejectCopy(new Error('Clipboard denied'));
  await Promise.resolve();
  await el.updateComplete;
  assert.match(detailCard(el).querySelector('[role="status"]').textContent, /Could not copy/);
  assert.equal(rowValue(detailCard(el), 'Peer key').text, 'local', 'key remains available to select manually');
});

test('PresenceGraphElement: "Focus this peer" refocuses the scene and closes the card', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;

  detailCard(el).querySelector('.peer-detail-focus').click();
  await el.updateComplete;

  assert.equal(detailCard(el), null);
  assert.equal(el.scene.focusedKey, 'beta');
  assert.equal(el.scene.isFocusedView, true);
  el.remove();
});

test('PresenceGraphElement: detailOpen/closeDetail — the panel Escape-routing API', async () => {
  const el = await mountFocused();
  assert.equal(el.detailOpen, false);

  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  assert.equal(el.detailOpen, true);

  el.closeDetail();
  await el.updateComplete;
  assert.equal(el.detailOpen, false);
  assert.equal(detailCard(el), null);
  el.remove();
});

test('PresenceGraphElement: re-picking the FOCUSED peer via search exits focus and takes the card with it', async () => {
  // Regression: focusPeer was the only focus-exit path without flip
  // bookkeeping, so a kept-open search result re-click left the detail card
  // orphaned over the unfocused mesh.
  const el = await mountFocused();
  clickPeerInFocus(el, 'beta');
  await el.updateComplete;
  assert.ok(detailCard(el), 'card open before the toggle');

  el.focusPeer('alpha'); // search re-pick of the focused peer == click toggle-off
  await el.updateComplete;

  assert.equal(el.scene.isFocusedView, false, 'the re-pick exited focus');
  assert.equal(detailCard(el), null, 'and the card went with the focus session');
  el.remove();
});

test('PresenceGraphElement: the local device card has no focus action and explains its missing sync rows', async () => {
  const el = await mountFocused();
  clickPeerInFocus(el, 'local');
  await el.updateComplete;
  const card = detailCard(el);

  assert.ok(card.textContent.includes('This device'));
  assert.ok(card.textContent.includes('Sync progress is tracked per remote peer'));
  assert.equal(card.querySelector('.peer-detail-focus'), null);
  el.remove();
});

test('PresenceGraphElement: Direct-mode selection opens, swaps, and dismisses peer cards', async t => {
  const el = await mount({ peerDetails: detailFixture() });
  t.after(() => el.remove());
  clickPeer(el, 'alpha');
  await el.updateComplete;

  assert.equal(el.scene.selectedPeerKey, 'alpha', 'direct selection still works');
  assert.equal(el.scene.isFocusedView, false, 'stays in Direct mode');
  assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Alpha');
  assert.equal(rowValue(detailCard(el), 'Synced to commit').text, '42');
  assert.ok(detailCard(el).querySelector('[aria-label="Copy peer key"]'));
  clickPeer(el, 'beta');
  await el.updateComplete;
  assert.equal(el.scene.selectedPeerKey, 'beta');
  assert.equal(detailCard(el)?.getAttribute('aria-label'), 'Details for Beta');
  clickPeer(el, 'beta');
  await el.updateComplete;
  assert.equal(el.scene.selectedPeerKey, undefined);
  assert.equal(detailCard(el), null, 'clicking the selected peer again dismisses its card');
  clickPeer(el, 'alpha');
  await el.updateComplete;
  clickCanvas(el);
  await el.updateComplete;
  assert.equal(el.scene.selectedPeerKey, undefined);
  assert.equal(detailCard(el), null, 'empty canvas clears the card and selection');
  clickPeer(el, 'alpha', 20, 0);
  await el.updateComplete;
  assert.equal(detailCard(el), null, 'dragging does not open a card');
});

test('PresenceGraphElement: Direct-mode cards close on a mode switch or selected peer removal', async t => {
  const el = await mount({ peerDetails: detailFixture() });
  t.after(() => el.remove());
  clickPeer(el, 'alpha');
  await el.updateComplete;
  el.shadowRoot.querySelector('.direct-control input').click();
  await el.updateComplete;
  assert.equal(detailCard(el), null, 'a mode change clears the selection card');
  assert.equal(el.scene.selectedPeerKey, undefined);
  el.directConnectedOnly = true;
  el.input = structuredClone(INPUT);
  await el.updateComplete;
  settleLayout(el);
  clickPeer(el, 'alpha');
  await el.updateComplete;
  assert.ok(detailCard(el));
  // A peer may leave the visible Direct graph before its detail data expires.
  el.input = { ...structuredClone(INPUT), remotePeers: [], connections: [] };
  await el.updateComplete;
  await el.updateComplete; // input is applied in updated(); card dismissal renders next
  assert.equal(detailCard(el), null);
  assert.equal(el.scene.selectedPeerKey, undefined);
});

test('PresenceGraphElement: a peer with no card data (the cloud node) stays a canvas tap', async () => {
  const el = await mount({
    directConnectedOnly: false,
    input: { ...structuredClone(FOCUS_INPUT), isLocalConnectedToCloud: true },
    peerDetails: detailFixture(),
  });
  // Focus the cloud node from the unfocused mesh, then re-tap it: with no
  // card data the tap falls through to the dismiss-or-exit canvas path.
  clickPeer(el, 'ditto-cloud-node');
  await el.updateComplete;
  assert.equal(el.scene.focusedKey, 'ditto-cloud-node');

  clickPeerInFocus(el, 'ditto-cloud-node');
  await el.updateComplete;
  assert.equal(el.scene.isFocusedView, false, 'canvas-tap semantics: no card was open, so focus exits');
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

// ─── connection-line unit tests ────────────────────────────────
// The scene tests above drive drawConnectionLine only along the happy
// path (AccessPoint spokes, offset 0, no cloud edge). These tests call
// it directly with a context that ALSO records path-building calls
// (the shared canvas stub drops moveTo/quadraticCurveTo/arc as noise),
// so the offset maths, control-point flavour, alpha clamping, and the
// cloud-circle decoration are assertable rather than merely reached.

interface PathOp {
  op: string;
  args: unknown[];
  globalAlpha: number;
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

function createPathContext(): { ctx: CanvasRenderingContext2D; ops: PathOp[] } {
  const ops: PathOp[] = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    save(): void {},
    restore(): void {},
    beginPath(): void {},
  } as Record<string, unknown>;
  const record = (op: string) => (...args: unknown[]): void => {
    ops.push({
      op,
      args,
      globalAlpha: ctx.globalAlpha as number,
      strokeStyle: ctx.strokeStyle as string,
      fillStyle: ctx.fillStyle as string,
      lineWidth: ctx.lineWidth as number,
    });
  };
  for (const name of ['moveTo', 'quadraticCurveTo', 'arc', 'stroke', 'fill', 'setLineDash']) {
    ctx[name] = record(name);
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

function makeLine(partial: Partial<ConnectionLineData> = {}): ConnectionLineData {
  return {
    fromKey: 'a', toKey: 'b', type: 'AccessPoint',
    isCloud: false, offset: 0, arcOutward: false, alpha: 1,
    ...partial,
  };
}

function closeTo(actual: unknown, expected: number, label: string): void {
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-9,
    `${label}: expected ${expected}, got ${String(actual)}`,
  );
}

test('ConnectionLine: every connection type strokes with its table colour and dash, then resets the dash', () => {
  for (const [type, style] of Object.entries(CONNECTION_STYLES)) {
    const { ctx, ops } = createPathContext();
    drawConnectionLine(
      ctx,
      makeLine({ type: type as ConnectionTypeName, isCloud: type === 'Cloud' }),
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    );
    const stroke = ops.find(o => o.op === 'stroke');
    assert.ok(stroke, `${type} strokes a path`);
    assert.equal(stroke.strokeStyle, style.color, `${type} colour`);
    const dashes = ops.filter(o => o.op === 'setLineDash');
    assert.deepEqual(dashes[0]!.args[0], style.dash, `${type} dash pattern`);
    assert.deepEqual(dashes[dashes.length - 1]!.args[0], [], `${type} dash reset after the stroke`);
  }
});

test('ConnectionLine: only a selected line or a full-opacity hover gets the emphasized stroke', () => {
  const widthFor = (line: Partial<ConnectionLineData>, focusAlpha = 1, selected = false): number => {
    const { ctx, ops } = createPathContext();
    drawConnectionLine(ctx, makeLine(line), { x: 0, y: 0 }, { x: 100, y: 0 }, focusAlpha, selected);
    return ops.find(o => o.op === 'stroke')!.lineWidth;
  };

  assert.equal(widthFor({}), 2, 'plain line');
  assert.equal(widthFor({}, 1, true), 3, 'selected peer line');
  assert.equal(widthFor({ highlighted: true }), 3, 'full-opacity hovered line');
  assert.equal(widthFor({ highlighted: true }, 0.4), 2,
    'a stale/transient hover must not compete with persistent peer focus');
});

test('ConnectionLine: alpha is clamped to [0,1] and multiplied by focusAlpha', () => {
  const alphaFor = (alpha: number, focusAlpha = 1): number => {
    const { ctx, ops } = createPathContext();
    drawConnectionLine(ctx, makeLine({ alpha }), { x: 0, y: 0 }, { x: 100, y: 0 }, focusAlpha);
    return ops.find(o => o.op === 'stroke')!.globalAlpha;
  };

  assert.equal(alphaFor(1.4), 1, 'over-full alpha clamps to 1');
  assert.equal(alphaFor(-0.2), 0, 'negative alpha clamps to 0');
  assert.equal(alphaFor(0.5, 0.5), 0.25, 'line alpha × focus alpha');
});

test('ConnectionLine: a non-zero offset shifts the whole path perpendicular to the chord', () => {
  const { ctx, ops } = createPathContext();
  // Horizontal chord: the perpendicular is vertical, so a +10 offset
  // moves both endpoints to y=10 and the control point follows.
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 0 };
  drawConnectionLine(ctx, makeLine({ offset: 10 }), from, to);

  const move = ops.find(o => o.op === 'moveTo')!;
  closeTo(move.args[0], 0, 'offset from.x');
  closeTo(move.args[1], 10, 'offset from.y');
  const curve = ops.find(o => o.op === 'quadraticCurveTo')!;
  const expectedControl = perpendicularControlPoint({ x: 0, y: 10 }, { x: 100, y: 10 });
  closeTo(curve.args[0], expectedControl.x, 'control.x follows the offset');
  closeTo(curve.args[1], expectedControl.y, 'control.y follows the offset');
  closeTo(curve.args[2], 100, 'offset to.x');
  closeTo(curve.args[3], 10, 'offset to.y');
});

test('ConnectionLine: the offset is skipped for a degenerate near-zero-length chord', () => {
  const { ctx, ops } = createPathContext();
  const from = { x: 0, y: 0 };
  const to = { x: 0.05, y: 0 };
  drawConnectionLine(ctx, makeLine({ offset: 10 }), from, to);

  const move = ops.find(o => o.op === 'moveTo')!;
  closeTo(move.args[0], from.x, 'unshifted from.x');
  closeTo(move.args[1], from.y, 'unshifted from.y');
  const curve = ops.find(o => o.op === 'quadraticCurveTo')!;
  const expected = perpendicularControlPoint(from, to);
  closeTo(curve.args[0], expected.x, 'control.x');
  closeTo(curve.args[1], expected.y, 'control.y');
});

test('ConnectionLine: arcOutward picks the radial control point; spokes pick the perpendicular one', () => {
  const from = { x: 100, y: 0 };
  const to = { x: 0, y: 100 };

  const outward = createPathContext();
  drawConnectionLine(outward.ctx, makeLine({ arcOutward: true }), from, to);
  const outwardCurve = outward.ops.find(o => o.op === 'quadraticCurveTo')!;
  const expectedOutward = outwardControlPoint(from, to);
  closeTo(outwardCurve.args[0], expectedOutward.x, 'arcOutward control.x');
  closeTo(outwardCurve.args[1], expectedOutward.y, 'arcOutward control.y');

  const spoke = createPathContext();
  drawConnectionLine(spoke.ctx, makeLine({ arcOutward: false }), from, to);
  const spokeCurve = spoke.ops.find(o => o.op === 'quadraticCurveTo')!;
  const expectedPerp = perpendicularControlPoint(from, to);
  closeTo(spokeCurve.args[0], expectedPerp.x, 'spoke control.x');
  closeTo(spokeCurve.args[1], expectedPerp.y, 'spoke control.y');

  assert.notDeepEqual(
    outwardCurve.args.slice(0, 2), spokeCurve.args.slice(0, 2),
    'the two flavours genuinely disagree on this chord',
  );
});

test('ConnectionLine: a cloud line draws evenly spaced circles along the Bézier', () => {
  const { ctx, ops } = createPathContext();
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 0 };
  drawConnectionLine(ctx, makeLine({ type: 'Cloud', isCloud: true }), from, to);

  const fills = ops.filter(o => o.op === 'fill');
  // 200px chord → floor(200/40) = 5 slots → circles at s = 1/5 … 4/5.
  assert.equal(fills.length, 4, 'one circle per interior 40px slot');
  const control = perpendicularControlPoint(from, to);
  for (let i = 1; i <= 4; i += 1) {
    const s = i / 5;
    const u = 1 - s;
    const expectedX = u * u * from.x + 2 * u * s * control.x + s * s * to.x;
    const expectedY = u * u * from.y + 2 * u * s * control.y + s * s * to.y;
    const arc = ops.filter(o => o.op === 'arc')[i - 1]!;
    closeTo(arc.args[0], expectedX, `circle ${i} sits on the curve (x)`);
    closeTo(arc.args[1], expectedY, `circle ${i} sits on the curve (y)`);
    assert.equal(arc.args[2], 3, 'circle radius');
  }
  const cloudColor = CONNECTION_STYLES.Cloud.color;
  assert.ok(fills.every(f => f.fillStyle === cloudColor), 'circles use the Cloud colour');
  assert.ok(fills.every(f => Math.abs(f.globalAlpha - 0.8) < 1e-9),
    'circles render at 80% of the line alpha');
});

test('ConnectionLine: cloud-circle alpha inherits the faded line alpha', () => {
  const { ctx, ops } = createPathContext();
  drawConnectionLine(
    ctx,
    makeLine({ type: 'Cloud', isCloud: true, alpha: 0.5 }),
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  );
  const fills = ops.filter(o => o.op === 'fill');
  assert.ok(fills.length > 0);
  assert.ok(fills.every(f => Math.abs(f.globalAlpha - 0.4) < 1e-9), '0.5 line alpha → 0.4 circle alpha');
});

test('ConnectionLine: short cloud lines draw no circles but still stroke', () => {
  // 50px → floor(50/40) = 1 slot, which the interior-only loop skips.
  const short = createPathContext();
  drawConnectionLine(short.ctx, makeLine({ type: 'Cloud', isCloud: true }), { x: 0, y: 0 }, { x: 50, y: 0 });
  assert.equal(short.ops.filter(o => o.op === 'fill').length, 0, '1 slot → no interior circles');
  assert.ok(short.ops.some(o => o.op === 'stroke'), 'the line itself still paints');

  // 30px → 0 slots → the decoration block is skipped entirely.
  const tiny = createPathContext();
  drawConnectionLine(tiny.ctx, makeLine({ type: 'Cloud', isCloud: true }), { x: 0, y: 0 }, { x: 30, y: 0 });
  assert.equal(tiny.ops.filter(o => o.op === 'fill').length, 0);
  assert.ok(tiny.ops.some(o => o.op === 'stroke'));
});

test('ConnectionLine: a non-cloud line never draws circles', () => {
  const { ctx, ops } = createPathContext();
  drawConnectionLine(ctx, makeLine({ type: 'Bluetooth' }), { x: 0, y: 0 }, { x: 400, y: 0 });
  assert.equal(ops.filter(o => o.op === 'fill').length, 0);
  assert.equal(ops.find(o => o.op === 'stroke')!.strokeStyle, CONNECTION_STYLES.Bluetooth.color);
});
