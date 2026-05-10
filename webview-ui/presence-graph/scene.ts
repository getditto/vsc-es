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
  /** Drives scale/alpha for newly-added peers — rendered by drawPeer. */

  /** Star field is owned here so the same RAF loop ticks both. */
  readonly stars: FloatingStars;

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
    const allKeys = [...this.peers.keys()];
    const cs: ConnectionInfo[] = [];
    for (const line of this.lines.values()) {
      cs.push({ fromPeer: line.fromKey, toPeer: line.toKey });
    }
    const result = calculateLayout(this.localKey, allKeys, cs);
    this.layout = result;
    // For Phase 2 we snap positions instantly. The animation loop in
    // the next commit will replace this with eased transitions.
    for (const [key, pos] of result.positions) {
      const node = this.peers.get(key);
      if (node) { node.position = pos; }
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
      drawConnectionLine(ctx, line, from, to);
    }

    // Nodes on top.
    for (const node of this.peers.values()) {
      drawPeerNode(ctx, node);
    }

    ctx.restore();
  }
}
