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
  measurePillWidth,
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

export const MIN_GRAPH_ZOOM = 0.25;
export const MAX_GRAPH_ZOOM = 2.0;

const CLOUD_KEY = 'ditto-cloud-node';

/** Ring radius multiplier applied when "Direct Connected only" is OFF.
 *  Expanded layout also packs crowded BFS layers into progressively larger
 *  visual rings, keeping a large full mesh readable instead of stacking every
 *  peer on one circumference. */
const EXPANDED_RADIUS_SCALE = 1.75;
const UNRELATED_PEER_ALPHA = 0.25;
const FOCUS_ZOOM = 1.25;
const FOCUS_ANIMATION_MS = 140;
const FOCUS_CONTEXT_ALPHA = 0.08;
const FOCUS_CONTEXT_LINE_ALPHA = 0.04;
const FOCUS_CONTEXT_BLUR_PX = 2;
const FOCUS_RING_GAP = 24;
const FOCUS_NODE_HEIGHT = 22.5;
const FOCUS_NODE_PADDING = 22.5;
const FOCUS_ESTIMATED_CHAR_WIDTH = 7;
const DIRECT_RING_GAP = 24;
const DIRECT_VIEW_PADDING = 48;
// Keep unrelated links barely visible for topology context while making
// the selected peer's links visually dominant. Connection colours are
// intentionally bright, so a stronger reduction than peer dimming is
// needed for the focus treatment to read clearly.
const UNRELATED_LINE_ALPHA = 0.08;

export interface SceneOptions {
  /** Initial scale (1.0 = 100%). Clamped 0.25–2.0 by zoom helpers. */
  zoom?: number;
  /** Camera offset in world coordinates. (0,0) puts local at canvas centre. */
  cameraOffset?: Point;
  /** When true, only draw connections that involve the local peer
   *  directly. Mirrors SwiftUI's showDirectConnectedOnly. Filtering
   *  also affects layout because peer-to-peer edges feed BFS. */
  showDirectConnectedOnly?: boolean;
  /** Whether the ambient gradient and floating-star field are rendered. */
  backgroundEffectsEnabled?: boolean;
}

interface FocusAnimation {
  key: string;
  amount: number;
  fromAmount: number;
  toAmount: number;
  tStart: number;
  duration: number;
  fromCamera: Point;
  toCamera: Point;
  fromZoom: number;
  toZoom: number;
  fromPositions: Map<string, Point>;
  toPositions: Map<string, Point>;
  animating: boolean;
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
  /** Ambient gradient/stars are opt-out because they are decorative. */
  backgroundEffectsEnabled: boolean;
  /** Canvas used to measure the renderer's actual pill font before layout. */
  private measurementContext: CanvasRenderingContext2D | undefined;

  /** Node + edge state, keyed for fast updates from a fresh input. */
  readonly peers = new Map<string, PeerNodeData>();
  readonly lines = new Map<string, ConnectionLineData>();
  /** The most-recent layout result; used by the RAF loop in the next
   *  commit to drive position transitions. */
  layout: LayoutResult | undefined;
  localKey = '';
  /** Persistent click selection. Hover remains transient and independent. */
  selectedPeerKey: string | undefined;
  /** The peer whose directly connected neighbourhood is being isolated. */
  private focusedPeerKey: string | undefined;
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
  /** Focused-neighbourhood layout plus its lightweight opacity animation. */
  private focusAnimation: FocusAnimation | undefined;
  /** Set when entering Direct mode so the first rebuilt layout can fit the
   *  newly compacted graph without inheriting an unsafe full-mesh zoom. */
  private fitDirectLayoutOnNextRecalculate = false;
  /** Mode changes can require a layout even when the filtered key sets are
   *  identical (for example, a mesh made entirely of direct peers). */
  private layoutDirty = false;
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
    this.backgroundEffectsEnabled = opts.backgroundEffectsEnabled ?? true;
    this.stars = new FloatingStars();
  }

  get isFocusedView(): boolean { return this.focusedPeerKey !== undefined; }

  get focusedPeerLabel(): string | undefined {
    const key = this.focusedPeerKey;
    return key ? this.peers.get(key)?.label : undefined;
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  setBackgroundEffectsEnabled(value: boolean): void {
    this.backgroundEffectsEnabled = value;
  }

  /** Provide the renderer context so layout can use the exact pill widths.
   *  Tests and non-DOM callers may omit it and use the conservative estimate. */
  setMeasurementContext(ctx: CanvasRenderingContext2D | undefined): void {
    if (this.measurementContext === ctx) { return; }
    this.measurementContext = ctx;
    this.layoutDirty = true;
  }

  /**
   * Rebuild peer + line state from a fresh input snapshot. Re-runs
   * layout when the topology or displayed labels actually changed (or when
   * the renderer's measurement context changed); otherwise keeps positions.
   */
  applyInput(input: PresenceGraphInput): { topologyChanged: boolean } {
    const newKeys = this.computeKeys(input);
    const topologyChanged = !this.sameKeys(newKeys);
    const labelsChanged = this.upsertPeers(input);
    this.handleCloudPeer(input);
    this.upsertLines(input);
    this.localKey = input.localPeerKey;
    if (this.selectedPeerKey && !this.peers.has(this.selectedPeerKey)) {
      this.selectedPeerKey = undefined;
    }
    if (this.hoveredPeerKey && !this.peers.has(this.hoveredPeerKey)) {
      this.hoveredPeerKey = undefined;
    }
    if (this.focusedPeerKey && !this.peers.has(this.focusedPeerKey)) {
      this.clearFocusView();
    }
    // Line highlighting is derived from the hovered peer, never stored across
    // updates: upsertLines rebuilds the map from scratch on every presence
    // tick. Carrying the flag over instead would both strand a stale `true`
    // once hover was cleared without a pointer event, and miss links that
    // appeared while the peer stayed hovered.
    this.setHovered(this.hoveredPeerKey ? this.peers.get(this.hoveredPeerKey) : undefined);
    if (topologyChanged || labelsChanged || this.layoutDirty) {
      this.layoutDirty = false;
      this.recalculateLayout();
      if (this.focusedPeerKey) {
        this.beginFocusAnimation(this.focusedPeerKey, true);
      }
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

  private upsertPeers(input: PresenceGraphInput): boolean {
    let labelsChanged = false;
    const seen = new Set<string>();
    seen.add(input.localPeerKey);
    const localExisting = this.peers.get(input.localPeerKey);
    if (localExisting) {
      if (localExisting.label !== input.localDeviceName) {
        invalidatePillWidth(input.localPeerKey);
        localExisting.label = input.localDeviceName;
        labelsChanged = true;
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
          labelsChanged = true;
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
    return labelsChanged;
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
    const result = calculateLayout(
      this.localKey,
      allKeys,
      cs,
      scale,
      this.estimatedNodeFootprints(),
    );
    if (this.showDirectConnectedOnly) {
      this.expandDirectRingForLabels(result);
    }
    this.layout = result;
    if (this.fitDirectLayoutOnNextRecalculate) {
      this.fitDirectLayoutOnNextRecalculate = false;
      this.fitZoomToLayout(result);
    }
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
   * - Focus mode fades its already-laid-out foreground ring in.
   *
   * Returns true while any graph animation is still in flight (position
   *   transitions, or a user interaction that must not freeze mid-drag).
   * The caller uses that to keep the RAF loop awake and to settle it once
   * everything is still.
   */
  tick(now: number, dt: number): boolean {
    if (this.backgroundEffectsEnabled) {
      this.stars.tick(now, dt);
    }

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
    const focus = this.focusAnimation;
    if (focus?.animating) {
      const elapsed = now - focus.tStart;
      const t = Math.min(elapsed / focus.duration, 1);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      focus.amount = focus.fromAmount + (focus.toAmount - focus.fromAmount) * eased;
      if (t >= 1) {
        focus.amount = focus.toAmount;
        focus.animating = false;
        if (focus.toAmount === 0) {
          this.focusAnimation = undefined;
          this.focusedPeerKey = undefined;
          this.selectedPeerKey = undefined;
        }
      }
    }
    // Stars deliberately do not keep the loop alive — the element freezes
    // them after a short idle window so a visible-but-idle panel doesn't
    // repaint at 60fps forever.
    return this.transitions.size > 0 || focus?.animating === true || this.isUserInteracting;
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
      if (!n) { continue; }
      if (this.isFocusedView && !this.focusAnimation?.toPositions.has(n.key)) { continue; }
      const hitNode = this.isFocusedView && this.focusAnimation?.toPositions.has(n.key)
        ? { ...n, position: this.focusPosition(n.key) }
        : n;
      if (pillContainsPoint(ctx, hitNode, world)) { return n; }
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

  /** Enable/disable Direct mode and discard focus because the visible graph
   *  (and therefore the selected peer's neighbourhood) is changing. */
  setShowDirectConnectedOnly(value: boolean): void {
    const modeChanged = value !== this.showDirectConnectedOnly;
    this.showDirectConnectedOnly = value;
    if (modeChanged) {
      this.layoutDirty = true;
      if (value) { this.fitDirectLayoutOnNextRecalculate = true; }
      this.clearFocusView();
      // Goes through setHovered rather than clearing the key directly so the
      // node/line `highlighted` flags are reset too — otherwise the previously
      // hovered peer keeps its emphasized stroke until the next input push.
      this.setHovered(undefined);
    }
  }

  /** Expand Direct mode's first ring enough for the actual pill footprints.
   *
   * The shared layout engine has no renderer/font context, so it deliberately
   * uses a fixed peer footprint. Direct mode is the one place where several
   * long labels can collapse into the same compact ring after coming from the
   * expanded mesh. Use the same conservative label estimate as focused mode,
   * preserving equal angular spacing while growing only the orbit. */
  private expandDirectRingForLabels(layout: LayoutResult): void {
    const ring = layout.ringAssignments.get(1) ?? [];
    if (ring.length < 2) { return; }
    const first = layout.positions.get(ring[0]!);
    if (!first) { return; }
    const baseRadius = Math.hypot(first.x, first.y);
    const angularChordFactor = 2 * Math.sin(Math.PI / ring.length);
    if (angularChordFactor <= 0) { return; }

    let radius = baseRadius;
    for (let i = 0; i < ring.length; i += 1) {
      const leftKey = ring[i];
      const rightKey = ring[(i + 1) % ring.length];
      if (!leftKey || !rightKey) { continue; }
      const requiredHorizontal = (
        this.estimatedDirectNodeWidth(leftKey) + this.estimatedDirectNodeWidth(rightKey)
      ) / 2 + DIRECT_RING_GAP;
      const requiredCenterDistance = Math.hypot(
        requiredHorizontal,
        FOCUS_NODE_HEIGHT + DIRECT_RING_GAP,
      );
      radius = Math.max(radius, requiredCenterDistance / angularChordFactor);
    }

    if (radius <= baseRadius) { return; }
    layout.ringRadii.set(1, radius);
    for (const key of ring) {
      const position = layout.positions.get(key);
      if (!position) { continue; }
      const angle = Math.atan2(position.y, position.x);
      layout.positions.set(key, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  }

  private estimatedDirectNodeWidth(key: string): number {
    return this.estimatedNodeWidth(key);
  }

  /** Use the same conservative label estimate for every layout mode. The
   * canvas renderer measures the actual font width; this intentionally rounds
   * up so the renderer-independent layout never packs pills more tightly than
   * their expected footprint. */
  private estimatedNodeFootprints(): ReadonlyMap<string, number> {
    const footprints = new Map<string, number>();
    for (const key of this.peers.keys()) {
      footprints.set(key, this.estimatedNodeWidth(key));
    }
    return footprints;
  }

  private estimatedNodeWidth(key: string): number {
    const node = this.peers.get(key);
    if (!node) { return FOCUS_NODE_PADDING; }
    if (this.measurementContext) {
      return measurePillWidth(this.measurementContext, node);
    }
    const label = node.isLocal ? 'Me' : node.label;
    return label.length * FOCUS_ESTIMATED_CHAR_WIDTH + FOCUS_NODE_PADDING;
  }

  /** Lower inherited zoom only when entering Direct mode if the compacted
   *  graph would otherwise be clipped. Never zooms in over the user's choice. */
  private fitZoomToLayout(layout: LayoutResult): void {
    let maxX = 0;
    let maxY = 0;
    for (const [key, position] of layout.positions) {
      const halfWidth = this.estimatedDirectNodeWidth(key) / 2;
      const halfHeight = FOCUS_NODE_HEIGHT / 2;
      maxX = Math.max(maxX, Math.abs(position.x + this.camera.x) + halfWidth);
      maxY = Math.max(maxY, Math.abs(position.y + this.camera.y) + halfHeight);
    }
    const availableWidth = Math.max(1, this.width / 2 - DIRECT_VIEW_PADDING);
    const availableHeight = Math.max(1, this.height / 2 - DIRECT_VIEW_PADDING);
    const fitZoom = Math.min(availableWidth / Math.max(1, maxX), availableHeight / Math.max(1, maxY));
    this.setZoom(Math.min(this.zoom, fitZoom));
  }

  /** Toggle persistent peer focus in either graph mode.
   *
   *  The local peer is not selectable: in Direct mode every line touches it by
   *  construction, so focusing it would exempt the whole graph from dimming
   *  and only thicken every stroke at once — which reads as a glitch, not a
   *  focus treatment. Full-mesh selection uses the same focus treatment so a
   *  selected peer's neighbours and connection types stand out. */
  selectPeer(key: string | undefined): void {
    if (key === undefined) {
      this.exitFocusView();
      return;
    }
    const invalid = key !== undefined && (!this.peers.has(key) || key === this.localKey);
    if (invalid) {
      this.selectedPeerKey = undefined;
      return;
    }
    if (!this.showDirectConnectedOnly) {
      if (this.focusedPeerKey === key && this.focusAnimation?.toAmount === 1) {
        this.exitFocusView();
      } else {
        this.selectedPeerKey = key;
        this.beginFocusAnimation(key, false);
      }
      return;
    }
    this.selectedPeerKey = this.selectedPeerKey === key ? undefined : key;
  }

  /** Leave the isolated neighbourhood and immediately restore the full mesh. */
  exitFocusView(): void {
    this.clearFocusView();
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
    if (this.selectedPeerKey) { return this.selectedPeerKey; }
    // Hovering the local peer is not a focus in Direct mode: every line
    // touches it there, so it would exempt the whole graph from dimming.
    return this.hoveredPeerKey === this.localKey ? undefined : this.hoveredPeerKey;
  }

  private clearFocusView(): void {
    this.focusedPeerKey = undefined;
    this.focusAnimation = undefined;
    this.selectedPeerKey = undefined;
  }

  /** Start or refresh the animated focused-neighbourhood view. */
  private beginFocusAnimation(key: string, refresh: boolean): void {
    const keys = [key, ...this.neighboursOf(key)];
    const connections: ConnectionInfo[] = [];
    for (const line of this.lines.values()) {
      if (line.fromKey === key || line.toKey === key) {
        connections.push({ fromPeer: line.fromKey, toPeer: line.toKey });
      }
    }
    const target = calculateLayout(
      key,
      keys,
      connections,
      1,
      this.estimatedNodeFootprints(),
    );
    const targetPositions = new Map<string, Point>();
    for (const peerKey of keys) {
      const position = target.positions.get(peerKey);
      if (position) { targetPositions.set(peerKey, { ...position }); }
    }
    this.expandFocusedRingForLabels(target, targetPositions);
    // The focused ring snaps to its final layout; only opacity is animated.
    // Keeping these maps equal avoids interpolating every node on every frame.
    const fromPositions = new Map<string, Point>();
    for (const [peerKey, position] of targetPositions) {
      fromPositions.set(peerKey, { ...position });
    }
    const targetZoom = Math.max(this.zoom, FOCUS_ZOOM);
    const fromAmount = refresh ? this.focusAmount() : 0;
    this.focusedPeerKey = key;
    this.focusAnimation = {
      key,
      amount: fromAmount,
      fromAmount,
      toAmount: 1,
      tStart: performance.now(),
      duration: FOCUS_ANIMATION_MS,
      fromCamera: { x: 0, y: 0 },
      toCamera: { x: 0, y: 0 },
      fromZoom: targetZoom,
      toZoom: targetZoom,
      fromPositions,
      toPositions: targetPositions,
      animating: true,
    };
  }

  /** Increase the focused ring radius using the actual label lengths.
   *
   * The shared layout engine intentionally uses a fixed peer footprint so it
   * stays renderer-independent. Focus mode is the one place where long,
   * horizontal pills are especially noticeable, so apply a conservative
   * label-aware radius floor after the BFS ring has been calculated. The
   * angular spacing remains equal; only the orbit grows when needed. */
  private expandFocusedRingForLabels(
    layout: LayoutResult,
    positions: Map<string, Point>,
  ): void {
    const ring = layout.ringAssignments.get(1) ?? [];
    if (ring.length < 2) { return; }
    const first = positions.get(ring[0]!);
    if (!first) { return; }
    const baseRadius = Math.hypot(first.x, first.y);
    const angularChordFactor = 2 * Math.sin(Math.PI / ring.length);
    if (angularChordFactor <= 0) { return; }

    let radius = baseRadius;
    for (let i = 0; i < ring.length; i += 1) {
      const leftKey = ring[i];
      const rightKey = ring[(i + 1) % ring.length];
      if (!leftKey || !rightKey) { continue; }
      const requiredHorizontal = (
        this.estimatedFocusedNodeWidth(leftKey) + this.estimatedFocusedNodeWidth(rightKey)
      ) / 2 + FOCUS_RING_GAP;
      const requiredCenterDistance = Math.hypot(
        requiredHorizontal,
        FOCUS_NODE_HEIGHT + FOCUS_RING_GAP,
      );
      radius = Math.max(radius, requiredCenterDistance / angularChordFactor);
    }

    if (radius <= baseRadius) { return; }
    for (const key of ring) {
      const position = positions.get(key);
      if (!position) { continue; }
      const angle = Math.atan2(position.y, position.x);
      positions.set(key, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
  }

  private estimatedFocusedNodeWidth(key: string): number {
    return this.estimatedNodeWidth(key);
  }

  private focusAmount(): number {
    return this.focusAnimation?.amount ?? (this.focusedPeerKey ? 1 : 0);
  }

  private focusPosition(key: string): Point {
    const animation = this.focusAnimation;
    const from = animation?.fromPositions.get(key);
    const to = animation?.toPositions.get(key);
    if (!animation || !from || !to) {
      return { ...(this.peers.get(key)?.position ?? { x: 0, y: 0 }) };
    }
    return {
      x: from.x + (to.x - from.x) * animation.amount,
      y: from.y + (to.y - from.y) * animation.amount,
    };
  }

  private focusCamera(): Point {
    const animation = this.focusAnimation;
    if (!animation) { return { ...this.camera }; }
    return {
      x: animation.fromCamera.x + (animation.toCamera.x - animation.fromCamera.x) * animation.amount,
      y: animation.fromCamera.y + (animation.toCamera.y - animation.fromCamera.y) * animation.amount,
    };
  }

  private focusZoom(): number {
    const animation = this.focusAnimation;
    return animation
      ? animation.fromZoom + (animation.toZoom - animation.fromZoom) * animation.amount
      : this.zoom;
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

  /** Clamp helper for zoom changes. The lower bound accommodates large
   *  expanded presence graphs with many visual rings. */
  setZoom(z: number): void {
    // Round to whole percents: the 0.1/0.05 zoom steps accumulate binary
    // float error (1 − 0.1 × 8 = 0.19999999999999996), which defeats the
    // exact-boundary disabled state on the zoom buttons and shows up as a
    // dead final click.
    this.zoom = Math.round(Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, z)) * 100) / 100;
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
    if (!this.focusedPeerKey) {
      this.renderMeshLayer(ctx, this.camera, this.zoom, 1, false);
      return;
    }

    const amount = this.focusAmount();
    const contextAlpha = FOCUS_CONTEXT_ALPHA + (1 - amount) * (1 - FOCUS_CONTEXT_ALPHA);
    this.renderMeshLayer(ctx, this.camera, this.zoom, contextAlpha, true);

    const focus = this.focusAnimation;
    this.renderFocusedLayer(ctx, this.focusCamera(), this.focusZoom(), amount, focus);
  }

  private renderMeshLayer(
    ctx: CanvasRenderingContext2D,
    camera: Point,
    zoom: number,
    alpha: number,
    blurred: boolean,
  ): void {
    ctx.save();
    // Blur only during the short focus fade. Keeping it off after the fade
    // avoids continuously paying Chromium's filter cost on a large mesh.
    const focusAmount = this.focusAmount();
    ctx.filter = blurred && focusAmount > 0 && focusAmount < 1
      ? `blur(${FOCUS_CONTEXT_BLUR_PX}px)`
      : 'none';
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(camera.x, camera.y);
    if (this.backgroundEffectsEnabled) {
      this.stars.draw(ctx, blurred ? alpha : 1);
    }
    for (const line of this.lines.values()) {
      const from = this.peers.get(line.fromKey)?.position;
      const to = this.peers.get(line.toKey)?.position;
      if (!from || !to) { continue; }
      const focus = blurred ? undefined : this.focusForLine(line);
      const lineAlpha = blurred
        ? Math.min(alpha, FOCUS_CONTEXT_LINE_ALPHA)
        : alpha * (focus?.alpha ?? 1);
      drawConnectionLine(ctx, line, from, to, lineAlpha, focus?.selected ?? false);
    }
    for (const node of this.peers.values()) {
      const isFocusNode = blurred && this.focusAnimation?.toPositions.has(node.key);
      const focus = blurred ? undefined : this.focusForPeer(node.key);
      const nodeAlpha = isFocusNode
        ? alpha * (1 - this.focusAmount())
        : alpha * (focus?.alpha ?? 1);
      drawPeerNode(ctx, node, nodeAlpha, focus?.selected ?? false);
    }
    ctx.restore();
    ctx.filter = 'none';
  }

  private renderFocusedLayer(
    ctx: CanvasRenderingContext2D,
    camera: Point,
    zoom: number,
    alpha: number,
    focus: FocusAnimation | undefined,
  ): void {
    if (!focus || alpha <= 0) { return; }
    ctx.save();
    ctx.filter = 'none';
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(camera.x, camera.y);
    const focusedKey = this.focusedPeerKey;
    if (!focusedKey) { ctx.restore(); return; }
    for (const line of this.lines.values()) {
      if (line.fromKey !== focusedKey && line.toKey !== focusedKey) { continue; }
      const from = this.focusPosition(line.fromKey);
      const to = this.focusPosition(line.toKey);
      drawConnectionLine(ctx, line, from, to, alpha, true);
    }
    for (const key of focus.toPositions.keys()) {
      const node = this.peers.get(key);
      if (!node) { continue; }
      const position = this.focusPosition(key);
      drawPeerNode(ctx, { ...node, position }, alpha, key === focusedKey);
    }
    ctx.restore();
  }
}
