// webview-ui/presence-graph/scene.ts
//
// Owns the per-canvas state for one presence graph: peer nodes, edges,
// camera transform, the floating-stars background, and the per-frame
// render. Renders are explicit — `render()` paints one frame from the
// current state into the supplied 2d context. Animations and the RAF
// loop come in the next commit.

import {
  calculateLayout,
  type ConnectionInfo,
  type LayoutResult,
  type Point,
} from '../../src/presence/NetworkLayoutEngine.js';
import {
  drawPeerNode,
  invalidatePillWidth,
  pillContainsPoint,
  type PeerNodeData,
} from './peer-node.js';
import {
  drawConnectionLine,
  type ConnectionLineData,
} from './connection-line.js';
import { FloatingStars } from './floating-stars.js';
import type { ConnectionTypeName } from './colors.js';

/** Wire-shape input: peers + edges from the host. The scene rebuilds
 *  its node + line maps from this on every update. */
export interface PresenceGraphInput {
  localPeerKey: string;
  localDeviceName: string;
  isLocalConnectedToCloud: boolean;
  remotePeers: { peerKey: string; deviceName: string }[];
  /** Undirected edges. Cloud edges are NOT included here — the scene
   *  synthesises the cloud peer + its single edge from
   *  isLocalConnectedToCloud. */
  connections: { from: string; to: string; type: ConnectionTypeName }[];
}

const CLOUD_KEY = 'ditto-cloud-node';

/** Ring radius multiplier applied when "Direct Connected only" is OFF.
 *  At 1.0 (default), peers cluster tightly enough that a fully-meshed
 *  ring-1 looks like a ball of yarn. At 1.75 the ring breathes enough
 *  that ring-1↔ring-1 chords stop overlapping the centre, while still
 *  fitting comfortably inside a typical panel viewport at zoom 100%. */
const EXPANDED_RADIUS_SCALE = 1.75;
const UNRELATED_PEER_ALPHA = 0.25;
// Keep unrelated links barely visible for topology context while making
// the selected peer's links visually dominant. Connection colours are
// intentionally bright, so a stronger reduction than peer dimming is
// needed for the focus treatment to read clearly.
const UNRELATED_LINE_ALPHA = 0.08;

export interface SceneOptions {
  /** Initial scale (1.0 = 100%). Clamped 0.5–2.0 by zoom helpers. */
  zoom?: number;
  /** Camera offset in world coordinates. (0,0) puts local at canvas centre. */
  cameraOffset?: Point;
  /** When true, only draw connections that involve the local peer
   *  directly. Mirrors SwiftUI's showDirectConnectedOnly. Filtering
   *  also affects layout because peer-to-peer edges feed BFS. */
  showDirectConnectedOnly?: boolean;
}

export class PresenceGraphScene {
  /** Canvas size in CSS pixels. Set externally on resize. */
  width = 800;
  height = 600;

  /** Current zoom factor (camera scale). 1.0 is "natural" size. */
  zoom: number;
  /** Camera offset — (0,0) puts the world origin at canvas centre. */
  camera: Point;
  showDirectConnectedOnly: boolean;

  /** Node + edge state, keyed for fast updates from a fresh input. */
  readonly peers = new Map<string, PeerNodeData>();
  readonly lines = new Map<string, ConnectionLineData>();
  /** The most-recent layout result; used by the RAF loop in the next
   *  commit to drive position transitions. */
  layout: LayoutResult | undefined;
  localKey = '';
  /** Persistent click selection. Hover remains transient and independent. */
  selectedPeerKey: string | undefined;
  /** Transient pointer focus. Used for the same dimming treatment until
   *  a click selection takes precedence. */
  hoveredPeerKey: string | undefined;
  /** Drives scale/alpha for newly-added peers — rendered by drawPeer. */

  /** Star field is owned here so the same RAF loop ticks both. */
  readonly stars: FloatingStars;

  /** In-flight position transitions keyed by peer. tick() interpolates
   *  toward the target with an ease-in-out curve over 500ms, matching
   *  SwiftUI's recalculateLayout move duration. */
  private transitions = new Map<string, { from: Point; to: Point; tStart: number; duration: number }>();
  /** Pinned peers — set when the user drags a node. The animation
   *  loop won't move pinned peers until they're unpinned. */
  private pinnedKeys = new Set<string>();
  /** Set when topology changed during a drag/pan; we rerun layout the
   *  moment the interaction ends. Mirrors SwiftUI's
   *  needsLayoutAfterInteraction. */
  needsLayoutAfterInteraction = false;
  /** True while a drag or pan is in progress. tick() defers anything
   *  that would yank the world out from under the user. */
  isUserInteracting = false;

  constructor(opts: SceneOptions = {}) {
    this.zoom = opts.zoom ?? 1.0;
    this.camera = opts.cameraOffset ?? { x: 0, y: 0 };
    this.showDirectConnectedOnly = opts.showDirectConnectedOnly ?? true;
    this.stars = new FloatingStars();
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  /**
   * Rebuild peer + line state from a fresh input snapshot. Re-runs
   * layout when the topology actually changed (peer set or connection
   * set differs from last time); otherwise keeps existing positions.
   */
  applyInput(input: PresenceGraphInput): { topologyChanged: boolean } {
    const newKeys = this.computeKeys(input);
    const topologyChanged = !this.sameKeys(newKeys);
    this.upsertPeers(input);
    this.handleCloudPeer(input);
    this.upsertLines(input);
    this.localKey = input.localPeerKey;
    if (this.selectedPeerKey && !this.peers.has(this.selectedPeerKey)) {
      this.selectedPeerKey = undefined;
    }
    if (this.hoveredPeerKey && !this.peers.has(this.hoveredPeerKey)) {
      this.hoveredPeerKey = undefined;
    }
    // Line highlighting is derived from the hovered peer, never stored across
    // updates: upsertLines rebuilds the map from scratch on every presence
    // tick. Carrying the flag over instead would both strand a stale `true`
    // once hover was cleared without a pointer event, and miss links that
    // appeared while the peer stayed hovered.
    this.setHovered(this.hoveredPeerKey ? this.peers.get(this.hoveredPeerKey) : undefined);
    if (topologyChanged) {
      this.recalculateLayout();
    }
    return { topologyChanged };
  }

  private computeKeys(input: PresenceGraphInput): {
    peerKeys: Set<string>;
    connKeys: Set<string>;
  } {
    const peerKeys = new Set<string>([input.localPeerKey, ...input.remotePeers.map(p => p.peerKey)]);
    if (input.isLocalConnectedToCloud) { peerKeys.add(CLOUD_KEY); }
    const connKeys = new Set<string>();
    for (const c of input.connections) {
      if (this.showDirectConnectedOnly && c.from !== input.localPeerKey && c.to !== input.localPeerKey) {
        continue;
      }
      const pair = [c.from, c.to].sort().join('|');
      connKeys.add(`${pair}|${c.type}`);
    }
    if (input.isLocalConnectedToCloud) {
      connKeys.add(`cloud|${input.localPeerKey}`);
    }
    return { peerKeys, connKeys };
  }

  private sameKeys(keys: { peerKeys: Set<string>; connKeys: Set<string> }): boolean {
    if (keys.peerKeys.size !== this.peers.size) { return false; }
    for (const k of keys.peerKeys) { if (!this.peers.has(k)) { return false; } }
    if (keys.connKeys.size !== this.lines.size) { return false; }
    for (const k of keys.connKeys) { if (!this.lines.has(k)) { return false; } }
    return true;
  }

  private upsertPeers(input: PresenceGraphInput): void {
    const seen = new Set<string>();
    seen.add(input.localPeerKey);
    const localExisting = this.peers.get(input.localPeerKey);
    if (localExisting) {
      if (localExisting.label !== input.localDeviceName) {
        invalidatePillWidth(input.localPeerKey);
        localExisting.label = input.localDeviceName;
      }
    } else {
      invalidatePillWidth(input.localPeerKey);
      this.peers.set(input.localPeerKey, {
        key: input.localPeerKey,
        label: input.localDeviceName,
        isLocal: true,
        position: { x: 0, y: 0 },
        alpha: 1,
        scale: 1,
      });
    }
    for (const r of input.remotePeers) {
      seen.add(r.peerKey);
      const existing = this.peers.get(r.peerKey);
      if (existing) {
        if (existing.label !== r.deviceName) {
          invalidatePillWidth(r.peerKey);
          existing.label = r.deviceName;
        }
      } else {
        // The width cache is module-global and outlives any one scene, so a
        // peer first seen by *this* scene may still have a width cached from
        // a previous one (the graph tab rebuilds the scene on every switch).
        // Without this, a device renamed while the tab was hidden keeps the
        // old pill width — overflowing text and a wrong hit box — for the
        // rest of the session.
        invalidatePillWidth(r.peerKey);
        this.peers.set(r.peerKey, {
          key: r.peerKey,
          label: r.deviceName,
          isLocal: false,
          // Spawn at origin — the layout pass will move them outward
          // and the appear animation (next commit) will fade them in.
          position: { x: 0, y: 0 },
          alpha: 1,
          scale: 1,
        });
      }
    }
    if (input.isLocalConnectedToCloud) {
      seen.add(CLOUD_KEY);
      if (!this.peers.has(CLOUD_KEY)) {
        this.peers.set(CLOUD_KEY, {
          key: CLOUD_KEY,
          label: 'Ditto Cloud',
          isLocal: false,
          position: { x: 0, y: 0 },
          alpha: 1,
          scale: 1,
        });
      }
    }
    // Drop peers that vanished from the input (and forget their pill width).
    for (const k of [...this.peers.keys()]) {
      if (!seen.has(k)) {
        this.peers.delete(k);
        invalidatePillWidth(k);
      }
    }
  }

  private handleCloudPeer(input: PresenceGraphInput): void {
    if (!input.isLocalConnectedToCloud && this.peers.has(CLOUD_KEY)) {
      this.peers.delete(CLOUD_KEY);
      invalidatePillWidth(CLOUD_KEY);
    }
  }

  private upsertLines(input: PresenceGraphInput): void {
    // The only place the lines map is rebuilt, so the only place the focus
    // neighbour cache can go stale in a way the focus key won't reveal.
    this.linesEpoch += 1;
    const next = new Map<string, ConnectionLineData>();

    // Group connections by sorted-pair so multi-type pairs share an offset bucket.
    const groups = new Map<string, { type: ConnectionTypeName; from: string; to: string }[]>();
    for (const c of input.connections) {
      if (this.showDirectConnectedOnly && c.from !== input.localPeerKey && c.to !== input.localPeerKey) {
        continue;
      }
      const pair = [c.from, c.to].sort().join('|');
      let bucket = groups.get(pair);
      if (!bucket) { bucket = []; groups.set(pair, bucket); }
      // De-dup A→B and B→A of the same type — SDK emits both.
      if (!bucket.some(x => x.type === c.type)) {
        bucket.push({ type: c.type, from: c.from, to: c.to });
      }
    }

    // For each group, compute per-line offsets so multiple parallel
    // connections between the same pair stay visible.
    for (const [, bucket] of groups) {
      const count = bucket.length;
      const baseOffset = 10;
      bucket.forEach((c, idx) => {
        let offset = 0;
        if (count === 2) {
          offset = idx === 0 ? baseOffset : -baseOffset;
        } else if (count > 2) {
          const step = (baseOffset * 2) / (count - 1);
          offset = baseOffset - step * idx;
        }
        const isPeerToPeer = c.from !== input.localPeerKey && c.to !== input.localPeerKey;
        const pair = [c.from, c.to].sort().join('|');
        const id = `${pair}|${c.type}`;
        next.set(id, {
          fromKey: c.from,
          toKey: c.to,
          type: c.type,
          isCloud: false,
          offset,
          arcOutward: isPeerToPeer,
          alpha: this.lines.get(id)?.alpha ?? 1,
        });
      });
    }

    // Synthetic cloud edge.
    if (input.isLocalConnectedToCloud) {
      const id = `cloud|${input.localPeerKey}`;
      next.set(id, {
        fromKey: input.localPeerKey,
        toKey: CLOUD_KEY,
        type: 'Cloud',
        isCloud: true,
        offset: 0,
        arcOutward: false,
        alpha: this.lines.get(id)?.alpha ?? 1,
      });
    }

    this.lines.clear();
    for (const [k, v] of next) { this.lines.set(k, v); }
  }

  private recalculateLayout(): void {
    if (!this.localKey) { return; }
    if (this.isUserInteracting) {
      // Don't yank the world while the user is dragging — let the
      // tick that ends the interaction run layout instead.
      this.needsLayoutAfterInteraction = true;
      return;
    }
    const allKeys = [...this.peers.keys()];
    const cs: ConnectionInfo[] = [];
    for (const line of this.lines.values()) {
      cs.push({ fromPeer: line.fromKey, toPeer: line.toKey });
    }
    // Spread rings wider in full-mesh mode so chord lines have room to
    // arc around the cluster instead of stabbing through it. The 500ms
    // transitions below animate the change in/out smoothly when the
    // user toggles "Direct Connected only".
    const scale = this.showDirectConnectedOnly ? 1 : EXPANDED_RADIUS_SCALE;
    const result = calculateLayout(this.localKey, allKeys, cs, scale);
    this.layout = result;
    // Animate every peer to its new position over 500ms, except the
    // ones the user has pinned (drag holds the position).
    const now = performance.now();
    for (const [key, target] of result.positions) {
      if (this.pinnedKeys.has(key)) { continue; }
      const node = this.peers.get(key);
      if (!node) { continue; }
      this.transitions.set(key, { from: { ...node.position }, to: target, tStart: now, duration: 500 });
    }
  }

  // ─── Animation tick ─────────────────────────────────────────

  /**
   * Advance every animated piece by one frame.
   *
   * - Floating stars are ticked while the caller keeps the loop alive; the
   *   Lit element freezes them after an idle period (they are pure ambient
   *   decoration, so a static field is fine — they do NOT count as
   *   in-flight animation for the return value).
   * - Position transitions ease-in-out over their duration; finished
   *   ones drop out of the map.
   *
   * Returns true while any graph animation is still in flight (position
   *   transitions, or a user interaction that must not freeze mid-drag).
   * The caller uses that to keep the RAF loop awake and to settle it once
   * everything is still.
   */
  tick(now: number, dt: number): boolean {
    this.stars.tick(now, dt);

    for (const [key, anim] of [...this.transitions]) {
      const node = this.peers.get(key);
      if (!node) { this.transitions.delete(key); continue; }
      const elapsed = now - anim.tStart;
      const t = Math.min(elapsed / anim.duration, 1);
      // Cubic ease-in-out — matches SpriteKit's .easeInEaseOut feel.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      node.position = {
        x: anim.from.x + (anim.to.x - anim.from.x) * eased,
        y: anim.from.y + (anim.to.y - anim.from.y) * eased,
      };
      if (t >= 1) {
        this.transitions.delete(key);
      }
    }
    // Stars deliberately do not keep the loop alive — the element freezes
    // them after a short idle window so a visible-but-idle panel doesn't
    // repaint at 60fps forever.
    return this.transitions.size > 0 || this.isUserInteracting;
  }

  // ─── Interaction API ────────────────────────────────────────

  /** Convert canvas-local CSS pixel coordinates to world coordinates
   *  using the current camera transform. The Lit element calls this
   *  before hit-testing or pinning so the user clicks land where
   *  they look. */
  canvasToWorld(canvasX: number, canvasY: number): Point {
    const cx = canvasX - this.width / 2;
    const cy = canvasY - this.height / 2;
    return {
      x: cx / this.zoom - this.camera.x,
      y: cy / this.zoom - this.camera.y,
    };
  }

  /** Top-most peer at a world point, or undefined if the click missed.
   *  Iterates in reverse insertion order so visually-stacked nodes
   *  return the front-most one. */
  nodeAt(ctx: CanvasRenderingContext2D, world: Point): PeerNodeData | undefined {
    const list = [...this.peers.values()];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const n = list[i];
      if (n && pillContainsPoint(ctx, n, world)) { return n; }
    }
    return undefined;
  }

  /** Set hover state on at-most one node. The previously-hovered node
   *  (if any) is un-highlighted. Returns true if hover changed. */
  setHovered(node: PeerNodeData | undefined): boolean {
    let changed = this.hoveredPeerKey !== node?.key;
    this.hoveredPeerKey = node?.key;
    for (const n of this.peers.values()) {
      const wantHighlighted = n === node;
      if (!!n.highlighted !== wantHighlighted) {
        n.highlighted = wantHighlighted;
        changed = true;
      }
    }
    // Line emphasis is skipped for the local peer in Direct mode: every
    // line touches it there, so highlighting its lines would thicken every
    // stroke at once — the same glitch the selectPeer guard rejects for
    // clicks. In full-mesh mode its spokes are a minority of the graph and
    // worth emphasizing, same as any other peer's. The pill itself still
    // gets the hover fill above.
    const skipLineFocus = node?.key === this.localKey && this.showDirectConnectedOnly;
    const lineFocusKey = node && !skipLineFocus ? node.key : undefined;
    for (const line of this.lines.values()) {
      const want = lineFocusKey !== undefined
        && (line.fromKey === lineFocusKey || line.toKey === lineFocusKey);
      if (!!line.highlighted !== want) {
        line.highlighted = want;
        changed = true;
      }
    }
    return changed;
  }

  /** Enable/disable Direct mode and discard focus when it is not applicable. */
  setShowDirectConnectedOnly(value: boolean): void {
    this.showDirectConnectedOnly = value;
    if (!value) {
      this.selectedPeerKey = undefined;
      // Goes through setHovered rather than clearing the key directly so the
      // node/line `highlighted` flags are reset too — otherwise the previously
      // hovered peer keeps its emphasized stroke until the next input push.
      this.setHovered(undefined);
    }
  }

  /** Toggle persistent peer focus. Selection is intentionally Direct-mode only.
   *
   *  The local peer is not selectable: in Direct mode every line touches it by
   *  construction, so focusing it would exempt the whole graph from dimming
   *  and only thicken every stroke at once — which reads as a glitch, not a
   *  focus treatment. */
  selectPeer(key: string | undefined): void {
    const invalid = key !== undefined && (!this.peers.has(key) || key === this.localKey);
    if (!this.showDirectConnectedOnly || invalid) {
      this.selectedPeerKey = undefined;
      return;
    }
    this.selectedPeerKey = this.selectedPeerKey === key ? undefined : key;
  }

  /** Reset magnification and place the actual local-node position at canvas centre. */
  resetViewToLocal(): void {
    this.zoom = 1;
    const local = this.peers.get(this.localKey)?.position ?? { x: 0, y: 0 };
    this.camera = { x: -local.x, y: -local.y };
  }

  /** Bumped whenever the lines map is rebuilt. Together with the focus key it
   *  is the full cache key for the neighbour set below: line objects are
   *  mutated in place for `highlighted`, but from/to keys only ever change
   *  when upsertLines replaces the map. */
  private linesEpoch = 0;
  private neighbourCache: { key: string; epoch: number; neighbours: Set<string> } | undefined;

  /** Keys directly connected to `focused`.
   *
   *  Cached because render() asks the focus question once per peer per frame:
   *  scanning every line for every peer made painting O(peers x lines) at
   *  60 fps, which on a busy mesh is the dominant cost of the whole graph.
   *  One scan per (focus, topology) pair instead. */
  private neighboursOf(focused: string): Set<string> {
    const cached = this.neighbourCache;
    if (cached && cached.key === focused && cached.epoch === this.linesEpoch) {
      return cached.neighbours;
    }
    const neighbours = new Set<string>();
    for (const line of this.lines.values()) {
      if (line.fromKey === focused) { neighbours.add(line.toKey); }
      else if (line.toKey === focused) { neighbours.add(line.fromKey); }
    }
    this.neighbourCache = { key: focused, epoch: this.linesEpoch, neighbours };
    return neighbours;
  }

  /** Exposed for focused tests and renderer decisions. */
  focusForPeer(key: string): { selected: boolean; alpha: number } {
    const focused = this.activeFocusKey();
    if (!focused) { return { selected: false, alpha: 1 }; }
    if (key === focused) {
      return { selected: this.selectedPeerKey === key, alpha: 1 };
    }
    if (this.neighboursOf(focused).has(key)) {
      return { selected: false, alpha: 1 };
    }
    return { selected: false, alpha: UNRELATED_PEER_ALPHA };
  }

  /** Exposed for focused tests and renderer decisions. */
  focusForLine(line: ConnectionLineData): { selected: boolean; alpha: number } {
    const focused = this.activeFocusKey();
    if (!focused) { return { selected: false, alpha: 1 }; }
    const touchesFocus = line.fromKey === focused || line.toKey === focused;
    return {
      selected: touchesFocus && this.selectedPeerKey === focused,
      alpha: touchesFocus ? 1 : UNRELATED_LINE_ALPHA,
    };
  }

  /** A click selection is sticky and wins over incidental hover. */
  private activeFocusKey(): string | undefined {
    if (!this.showDirectConnectedOnly) { return undefined; }
    if (this.selectedPeerKey) { return this.selectedPeerKey; }
    // Hovering the local peer is not a focus: every line touches it in
    // Direct mode, so it would exempt the whole graph from dimming.
    return this.hoveredPeerKey === this.localKey ? undefined : this.hoveredPeerKey;
  }

  /** Pin a peer's position (drag start) so transitions can't move it. */
  pin(key: string): void {
    this.pinnedKeys.add(key);
    this.transitions.delete(key);
  }

  /** Unpin a peer and re-run layout if the topology changed during the drag. */
  unpin(key: string): void {
    this.pinnedKeys.delete(key);
  }

  /** Set the position of a peer directly (drag move). */
  setPeerPosition(key: string, pos: Point): void {
    const node = this.peers.get(key);
    if (node) { node.position = pos; }
  }

  /** Clamp helper for zoom changes — same 0.5–2.0 range as SwiftUI. */
  setZoom(z: number): void {
    // Round to whole percents: the 0.1/0.05 zoom steps accumulate binary
    // float error (1 − 0.1 × 5 = 0.5000000000000001), which defeats the
    // exact-boundary disabled state on the zoom buttons and shows up as a
    // dead final click.
    this.zoom = Math.round(Math.max(0.5, Math.min(2.0, z)) * 100) / 100;
  }

  /** Pan the camera by a delta in canvas (CSS) pixels. Adjust by zoom
   *  so panning feels 1:1 at any zoom level. */
  panBy(dxCanvas: number, dyCanvas: number): void {
    this.camera = {
      x: this.camera.x + dxCanvas / this.zoom,
      y: this.camera.y + dyCanvas / this.zoom,
    };
  }

  /** Mark the user as interacting; suspends layout transitions. */
  beginInteraction(): void {
    this.isUserInteracting = true;
  }

  /** End the interaction; re-runs deferred layout if topology changed. */
  endInteraction(): void {
    this.isUserInteracting = false;
    if (this.needsLayoutAfterInteraction) {
      this.needsLayoutAfterInteraction = false;
      this.recalculateLayout();
    }
  }

  /**
   * Paint one frame. Caller (Lit element) is responsible for clearing
   * the backing store and calling this whenever a render is needed.
   */
  render(ctx: CanvasRenderingContext2D): void {
    ctx.save();

    // Camera: translate to canvas centre, then apply zoom and pan.
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(this.camera.x, this.camera.y);

    // Background star field first (deepest z).
    this.stars.draw(ctx);

    // Connections under nodes.
    for (const line of this.lines.values()) {
      const from = this.peers.get(line.fromKey)?.position;
      const to = this.peers.get(line.toKey)?.position;
      if (!from || !to) { continue; }
      const focus = this.focusForLine(line);
      drawConnectionLine(ctx, line, from, to, focus.alpha, focus.selected);
    }

    // Nodes on top.
    for (const node of this.peers.values()) {
      const focus = this.focusForPeer(node.key);
      drawPeerNode(ctx, node, focus.alpha, focus.selected);
    }

    ctx.restore();
  }
}
