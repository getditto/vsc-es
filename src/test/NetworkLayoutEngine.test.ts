import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLayout,
  sortRing1Peers,
  calculateOptimalAngles,
  perpendicularControlPoint,
  outwardControlPoint,
  type ConnectionInfo,
} from '../presence/NetworkLayoutEngine.js';

// ─── BFS ring assignment ───────────────────────────────────────

test('layout: lone local peer → only ring 0, no positions to place', () => {
  const r = calculateLayout('local', ['local'], []);
  assert.equal(r.ringAssignments.size, 1);
  assert.deepEqual(r.ringAssignments.get(0), ['local']);
  assert.deepEqual(r.positions.get('local'), { x: 0, y: 0 });
});

test('layout: two-peer chain — local + one ring-1 peer at the top', () => {
  const cs: ConnectionInfo[] = [{ fromPeer: 'local', toPeer: 'A' }];
  const r = calculateLayout('local', ['local', 'A'], cs);
  assert.deepEqual(r.ringAssignments.get(0), ['local']);
  assert.deepEqual(r.ringAssignments.get(1), ['A']);
  // First (and only) ring-1 peer sits at angle 90° → x≈0, y≈radius.
  const a = r.positions.get('A')!;
  assert.ok(Math.abs(a.x) < 1e-6, `expected x≈0, got ${a.x}`);
  assert.ok(a.y > 100, `expected y > 100, got ${a.y}`);
});

test('layout: chain of 3 (local-A-B) → A in ring 1, B in ring 2 behind A', () => {
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'A', toPeer: 'B' },
  ];
  const r = calculateLayout('local', ['local', 'A', 'B'], cs);
  assert.deepEqual(r.ringAssignments.get(1), ['A']);
  assert.deepEqual(r.ringAssignments.get(2), ['B']);
  const a = r.positions.get('A')!;
  const b = r.positions.get('B')!;
  // B's angle should equal A's angle (a lone parent with one child
  // → siblingSpread = 0 → child placed exactly at parent's angle).
  const angleA = Math.atan2(a.y, a.x);
  const angleB = Math.atan2(b.y, b.x);
  assert.ok(Math.abs(angleA - angleB) < 1e-6, 'B should sit on the same radial as A');
  // B is on the OUTER ring → larger radius than A.
  assert.ok(Math.hypot(b.x, b.y) > Math.hypot(a.x, a.y), 'B further from origin than A');
});

test('layout: star with 4 ring-1 peers, no inter-peer edges → evenly spaced', () => {
  const peers = ['local', 'A', 'B', 'C', 'D'];
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'local', toPeer: 'B' },
    { fromPeer: 'local', toPeer: 'C' },
    { fromPeer: 'local', toPeer: 'D' },
  ];
  const r = calculateLayout('local', peers, cs);
  assert.equal(r.ringAssignments.get(1)?.length, 4);
  const angles = ['A', 'B', 'C', 'D'].map(k => {
    const p = r.positions.get(k)!;
    let a = Math.atan2(p.y, p.x);
    if (a < 0) { a += 2 * Math.PI; }
    return a;
  }).sort((x, y) => x - y);
  // Adjacent angle gaps should each be ~π/2.
  for (let i = 1; i < angles.length; i += 1) {
    const gap = angles[i]! - angles[i - 1]!;
    assert.ok(Math.abs(gap - Math.PI / 2) < 1e-6,
      `gap[${i}] expected π/2, got ${gap}`);
  }
});

test('layout: disconnected peer parked in outermost ring', () => {
  const cs: ConnectionInfo[] = [{ fromPeer: 'local', toPeer: 'A' }];
  const r = calculateLayout('local', ['local', 'A', 'orphan'], cs);
  // Direct: ring 1 = [A]; orphan was disconnected → placed at ring 2.
  assert.deepEqual(r.ringAssignments.get(1), ['A']);
  assert.deepEqual(r.ringAssignments.get(2), ['orphan']);
});

test('layout: multiple disconnected peers all park in the same outermost ring', () => {
  const r = calculateLayout('local', ['local', 'X', 'Y', 'Z'], []);
  // No edges → no ring 1; everyone except local lands in ring 1
  // (the outermost = max ring 0 + 1).
  const r1 = r.ringAssignments.get(1);
  assert.equal(r1?.length, 3);
  assert.ok(r1?.includes('X') && r1?.includes('Y') && r1?.includes('Z'));
});

// ─── Ring 1 ordering — greedy double-ended path ────────────────

test('sortRing1Peers: 2-or-fewer peers returned as-is', () => {
  const adj = new Map<string, Set<string>>();
  assert.deepEqual(sortRing1Peers([], adj), []);
  assert.deepEqual(sortRing1Peers(['A'], adj), ['A']);
  assert.deepEqual(sortRing1Peers(['A', 'B'], adj), ['A', 'B']);
});

test('sortRing1Peers: no inter-peer edges → input order preserved', () => {
  const adj = new Map<string, Set<string>>();
  // Each peer connects only to centre, not to other ring-1 peers.
  const peers = ['A', 'B', 'C', 'D'];
  assert.deepEqual(sortRing1Peers(peers, adj), peers);
});

test('sortRing1Peers: simple A-B-C chain → adjacent in result', () => {
  // Edges: A↔B, B↔C
  const adj = new Map<string, Set<string>>([
    ['A', new Set(['B'])],
    ['B', new Set(['A', 'C'])],
    ['C', new Set(['B'])],
  ]);
  const ordered = sortRing1Peers(['A', 'B', 'C'], adj);
  // B has the highest ring-1 degree (2) and starts the path. Then
  // we extend at the tail to one of its neighbours; the other
  // neighbour gets prepended at the head.
  assert.equal(ordered.length, 3);
  // A and C should each be adjacent to B in the linear order.
  const idx = (k: string) => ordered.indexOf(k);
  assert.ok(Math.abs(idx('A') - idx('B')) === 1);
  assert.ok(Math.abs(idx('C') - idx('B')) === 1);
});

test('sortRing1Peers: disconnected sub-graphs handled (cluster + lone peer)', () => {
  // A↔B form a cluster; X has no ring-1 edges.
  const adj = new Map<string, Set<string>>([
    ['A', new Set(['B'])],
    ['B', new Set(['A'])],
  ]);
  const ordered = sortRing1Peers(['A', 'B', 'X'], adj);
  assert.equal(ordered.length, 3);
  // A and B should be adjacent in the linear order.
  const ai = ordered.indexOf('A');
  const bi = ordered.indexOf('B');
  assert.ok(Math.abs(ai - bi) === 1, 'A and B must be adjacent');
  // X is appended after both ends are stuck.
  assert.equal(ordered[ordered.length - 1], 'X');
});

test('sortRing1Peers: triangle (A-B-C all connected) → any rotation is fine', () => {
  // Every pair connected → all three should end up adjacent on the
  // ring (which is automatic for a 3-cycle since you can start
  // anywhere). The path algorithm should still produce a valid
  // 3-element ordering with all peers present.
  const adj = new Map<string, Set<string>>([
    ['A', new Set(['B', 'C'])],
    ['B', new Set(['A', 'C'])],
    ['C', new Set(['A', 'B'])],
  ]);
  const ordered = sortRing1Peers(['A', 'B', 'C'], adj);
  assert.equal(ordered.length, 3);
  assert.ok(ordered.includes('A') && ordered.includes('B') && ordered.includes('C'));
});

test('sortRing1Peers: deterministic across reruns (ties broken by key)', () => {
  // Two equally-valid starting points (both have degree 1). Tie
  // breaks by key ascending so we always get the same answer.
  const adj = new Map<string, Set<string>>([
    ['A', new Set(['B'])],
    ['B', new Set(['A'])],
    ['C', new Set(['D'])],
    ['D', new Set(['C'])],
  ]);
  const a = sortRing1Peers(['A', 'B', 'C', 'D'], adj);
  const b = sortRing1Peers(['A', 'B', 'C', 'D'], adj);
  assert.deepEqual(a, b);
});

// ─── Ring 2+ parent-anchored placement ─────────────────────────

test('layout: parent with 2 children → siblings split symmetrically around parent angle', () => {
  // local — A — {B, C}: A is in ring 1 alone; B and C in ring 2,
  // both children of A.
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'A', toPeer: 'B' },
    { fromPeer: 'A', toPeer: 'C' },
  ];
  const r = calculateLayout('local', ['local', 'A', 'B', 'C'], cs);
  const a = r.positions.get('A')!;
  const b = r.positions.get('B')!;
  const c = r.positions.get('C')!;
  const angleA = Math.atan2(a.y, a.x);
  const angleB = Math.atan2(b.y, b.x);
  const angleC = Math.atan2(c.y, c.x);
  // Siblings symmetric around parent's angle → midpoint of (B, C) ≈
  // A's angle.
  const mid = (angleB + angleC) / 2;
  assert.ok(Math.abs(mid - angleA) < 1e-6,
    `midpoint of siblings (${mid}) should equal parent angle (${angleA})`);
});

test('layout: ring 2 children sit at the larger radius, not the parent radius', () => {
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'A', toPeer: 'B' },
  ];
  const r = calculateLayout('local', ['local', 'A', 'B'], cs);
  const a = r.positions.get('A')!;
  const b = r.positions.get('B')!;
  const radiusA = Math.hypot(a.x, a.y);
  const radiusB = Math.hypot(b.x, b.y);
  assert.ok(radiusB > radiusA, `child (${radiusB}) must be on outer ring than parent (${radiusA})`);
});

// ─── Even-angle distribution helper ────────────────────────────

test('calculateOptimalAngles: edge cases', () => {
  assert.deepEqual(calculateOptimalAngles(0), []);
  const one = calculateOptimalAngles(1);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0]! - Math.PI / 2) < 1e-6);
});

test('calculateOptimalAngles: 4 peers evenly spaced from top', () => {
  const angles = calculateOptimalAngles(4);
  assert.equal(angles.length, 4);
  for (let i = 1; i < angles.length; i += 1) {
    const gap = angles[i]! - angles[i - 1]!;
    assert.ok(Math.abs(gap - Math.PI / 2) < 1e-6);
  }
});

// ─── Bezier control-point helpers ──────────────────────────────

test('perpendicularControlPoint: zero-distance fallback returns midpoint', () => {
  const same = { x: 5, y: 5 };
  const cp = perpendicularControlPoint(same, same);
  assert.deepEqual(cp, { x: 5, y: 5 });
});

test('perpendicularControlPoint: control point lies off the chord midpoint', () => {
  const cp = perpendicularControlPoint({ x: -100, y: 0 }, { x: 100, y: 0 });
  // Chord runs along x-axis → control point gets a perpendicular
  // (y-direction) offset.
  assert.equal(cp.x, 0);
  assert.ok(Math.abs(cp.y) > 1, 'control point should have non-zero y offset');
});

test('outwardControlPoint: pushes away from origin', () => {
  // Two ring-1 peers on the right side of the circle.
  const cp = outwardControlPoint({ x: 100, y: 50 }, { x: 100, y: -50 });
  // Midpoint is (100, 0) → outward direction is +x → control point
  // should have x > 100.
  assert.ok(cp.x > 100, `expected outward push beyond x=100, got x=${cp.x}`);
  assert.ok(Math.abs(cp.y) < 1e-6);
});

test('outwardControlPoint: midpoint near origin falls back to perpendicular', () => {
  // Two near-antipodal points whose midpoint is exactly the origin.
  const cp = outwardControlPoint({ x: -100, y: 0 }, { x: 100, y: 0 });
  // No outward direction available → perpendicular fallback → off-axis.
  assert.equal(cp.x, 0);
  assert.ok(Math.abs(cp.y) > 1, 'fallback should still bow the line');
});

// ─── Ring expansion when crowded ────────────────────────────────

test('layout: ring with many peers expands radius beyond base', () => {
  // 20 ring-1 peers — pill diameter 60 + 20 spacing each, so the
  // minimum-required circumference exceeds the base ring.
  const peers = ['local', ...Array.from({ length: 20 }, (_, i) => `P${i}`)];
  const cs: ConnectionInfo[] = peers.slice(1).map(p => ({ fromPeer: 'local', toPeer: p }));
  const r = calculateLayout('local', peers, cs);
  const radius = r.ringRadii.get(1) ?? 0;
  // Base ring 1 radius is ~123.75; with 20 peers needing 80pt each
  // around the circumference, the radius must scale up significantly.
  assert.ok(radius > 200, `expected expanded radius, got ${radius}`);
});

// ─── End-to-end fixture mirroring a realistic mesh ──────────────

test('layout: mixed scenario (3 ring-1 + 2 ring-2 + 1 disconnected) is consistent', () => {
  // local↔A, local↔B, local↔C, A↔X, B↔Y, plus orphan Z.
  const peers = ['local', 'A', 'B', 'C', 'X', 'Y', 'Z'];
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'local', toPeer: 'B' },
    { fromPeer: 'local', toPeer: 'C' },
    { fromPeer: 'A', toPeer: 'X' },
    { fromPeer: 'B', toPeer: 'Y' },
  ];
  const r = calculateLayout('local', peers, cs);
  assert.deepEqual(r.ringAssignments.get(0), ['local']);
  // Ring 1 should hold A, B, C in some order.
  const ring1 = r.ringAssignments.get(1) ?? [];
  assert.equal(ring1.length, 3);
  assert.ok(['A', 'B', 'C'].every(k => ring1.includes(k)));
  // Ring 2 should hold X, Y.
  const ring2 = r.ringAssignments.get(2) ?? [];
  assert.equal(ring2.length, 2);
  assert.ok(ring2.includes('X') && ring2.includes('Y'));
  // Z (orphan) is parked in the outermost ring (ring 3).
  const ring3 = r.ringAssignments.get(3) ?? [];
  assert.deepEqual(ring3, ['Z']);
  // Every peer has a position assigned.
  for (const p of peers) {
    assert.ok(r.positions.has(p), `missing position for ${p}`);
  }
});

test('layout: radiusScale > 1 spreads rings outward proportionally', () => {
  // 4-peer star, no inter-peer edges → all 4 sit at the base ring 1
  // radius. Re-running with scale=1.75 should put them at exactly
  // 1.75× the radius (the crowding floor doesn't kick in for 4 peers
  // at the base radius, so the scale is the only factor).
  const peers = ['local', 'A', 'B', 'C', 'D'];
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'local', toPeer: 'B' },
    { fromPeer: 'local', toPeer: 'C' },
    { fromPeer: 'local', toPeer: 'D' },
  ];
  const r1 = calculateLayout('local', peers, cs);
  const r2 = calculateLayout('local', peers, cs, 1.75);
  const radius1 = r1.ringRadii.get(1) ?? 0;
  const radius2 = r2.ringRadii.get(1) ?? 0;
  assert.ok(Math.abs(radius2 - radius1 * 1.75) < 1e-6,
    `expected ring 1 radius to scale 1.75× (${radius1} → ${radius1 * 1.75}), got ${radius2}`);
  // Per-peer positions should scale 1.75× as well — same angles, bigger radius.
  for (const k of ['A', 'B', 'C', 'D']) {
    const p1 = r1.positions.get(k)!;
    const p2 = r2.positions.get(k)!;
    assert.ok(Math.abs(p2.x - p1.x * 1.75) < 1e-6, `${k}.x should scale 1.75×`);
    assert.ok(Math.abs(p2.y - p1.y * 1.75) < 1e-6, `${k}.y should scale 1.75×`);
  }
});

test('layout: expanded mode packs a crowded BFS layer into concentric rings', () => {
  const direct = Array.from({ length: 12 }, (_, i) => `direct-${i}`);
  const peers = ['local', ...direct, 'indirect'];
  const cs: ConnectionInfo[] = direct.map(peer => ({ fromPeer: 'local', toPeer: peer }));
  cs.push({ fromPeer: direct[0]!, toPeer: 'indirect' });

  const r = calculateLayout('local', peers, cs, 1.75);
  const ring1 = r.ringAssignments.get(1) ?? [];
  const ring2 = r.ringAssignments.get(2) ?? [];
  const ring3 = r.ringAssignments.get(3) ?? [];

  // The direct layer fills the first visual rings before the multi-hop peer
  // is placed outside them.
  assert.ok(ring1.length > 0 && ring1.every(peer => direct.includes(peer)));
  assert.ok(ring2.length > 0 && ring2.every(peer => direct.includes(peer)));
  assert.deepEqual(ring3, ['indirect']);

  const radii = [...r.ringRadii.entries()]
    .filter(([ring]) => ring > 0)
    .sort(([a], [b]) => a - b)
    .map(([, radius]) => radius);
  for (let i = 1; i < radii.length; i += 1) {
    assert.ok(radii[i]! > radii[i - 1]!, 'visual rings must expand outward');
  }

  assert.equal(r.positions.size, peers.length);
  for (const peer of peers) {
    assert.ok(r.positions.has(peer), `missing position for ${peer}`);
  }
});

test('layout: expanded mode evenly spaces peers within every visual ring', () => {
  const peers = ['local', ...Array.from({ length: 30 }, (_, i) => `P${i}`)];
  const cs: ConnectionInfo[] = peers.slice(1).map(peer => ({ fromPeer: 'local', toPeer: peer }));
  const r = calculateLayout('local', peers, cs, 1.75);

  for (const [ring, ringPeers] of r.ringAssignments) {
    if (ring === 0 || ringPeers.length < 2) { continue; }
    const angles = ringPeers.map(peer => {
      const position = r.positions.get(peer)!;
      let angle = Math.atan2(position.y, position.x);
      if (angle < 0) { angle += 2 * Math.PI; }
      return angle;
    }).sort((a, b) => a - b);
    const expectedGap = (2 * Math.PI) / ringPeers.length;
    for (let i = 1; i < angles.length; i += 1) {
      assert.ok(Math.abs((angles[i]! - angles[i - 1]!) - expectedGap) < 1e-6,
        `ring ${ring} is not evenly spaced`);
    }
  }
});

test('layout: expanded mode uses supplied pill footprints when packing rings', () => {
  const direct = Array.from({ length: 12 }, (_, i) => `P${i}`);
  const peers = ['local', ...direct];
  const cs: ConnectionInfo[] = direct.map(peer => ({ fromPeer: 'local', toPeer: peer }));
  const footprints = new Map(direct.map(peer => [peer, 340]));
  const r = calculateLayout('local', peers, cs, 1.75, footprints);

  const ring1 = r.ringAssignments.get(1) ?? [];
  assert.ok(ring1.length < direct.length, 'wide pills should reduce visual-ring capacity');
  for (const [ring, ringPeers] of r.ringAssignments) {
    if (ring === 0 || ringPeers.length < 2) { continue; }
    const positions = ringPeers.map(peer => r.positions.get(peer)!);
    for (let i = 0; i < positions.length; i += 1) {
      const next = positions[(i + 1) % positions.length]!;
      const distance = Math.hypot(positions[i]!.x - next.x, positions[i]!.y - next.y);
      assert.ok(distance >= 340, `ring ${ring} chord is too short: ${distance}`);
    }
  }
});

test('layout: expanded mode continues outward beyond 100 peers', () => {
  const peers = ['local', ...Array.from({ length: 101 }, (_, i) => `P${i}`)];
  const cs: ConnectionInfo[] = peers.slice(1).map(peer => ({ fromPeer: 'local', toPeer: peer }));
  const r = calculateLayout('local', peers, cs, 1.75);

  const visualRings = [...r.ringAssignments.keys()].filter(ring => ring > 0);
  assert.ok(visualRings.length >= 5, `expected at least 5 visual rings, got ${visualRings.length}`);
  assert.equal(r.positions.size, peers.length);
  assert.equal(new Set([...r.positions.values()].map(point => `${point.x},${point.y}`)).size, peers.length,
    'large meshes must not reuse a position');
});

test('layout: radiusScale does not shrink rings below the crowding floor', () => {
  // 20 ring-1 peers — crowding pushes radius well above base. Scaling
  // DOWN with a tiny scale must NOT shrink the ring below the floor
  // (pills would visually overlap).
  const peers = ['local', ...Array.from({ length: 20 }, (_, i) => `P${i}`)];
  const cs: ConnectionInfo[] = peers.slice(1).map(p => ({ fromPeer: 'local', toPeer: p }));
  const tight = calculateLayout('local', peers, cs, 0.1);
  const radius = tight.ringRadii.get(1) ?? 0;
  // 20 peers × 80pt circumference / 2π ≈ 254. Should stay near that
  // floor regardless of the tiny scale.
  assert.ok(radius > 200, `crowding floor should hold ring at ~254, got ${radius}`);
});

test('layout: rerunning the same input produces the same output (determinism)', () => {
  const peers = ['local', 'A', 'B', 'C', 'D'];
  const cs: ConnectionInfo[] = [
    { fromPeer: 'local', toPeer: 'A' },
    { fromPeer: 'local', toPeer: 'B' },
    { fromPeer: 'local', toPeer: 'C' },
    { fromPeer: 'local', toPeer: 'D' },
    { fromPeer: 'A', toPeer: 'B' },
    { fromPeer: 'C', toPeer: 'D' },
  ];
  const a = calculateLayout('local', peers, cs);
  const b = calculateLayout('local', peers, cs);
  for (const k of peers) {
    const pa = a.positions.get(k)!;
    const pb = b.positions.get(k)!;
    assert.deepEqual(pa, pb, `position for ${k} differs across runs`);
  }
});
