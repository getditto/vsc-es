import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceGraphScene, type PresenceGraphInput } from '../../webview-ui/presence-graph/scene.js';

function graphInput(remoteKeys = ['a', 'b']): PresenceGraphInput {
  return {
    localPeerKey: 'local',
    localDeviceName: 'Local device',
    isLocalConnectedToCloud: false,
    remotePeers: remoteKeys.map(peerKey => ({ peerKey, deviceName: peerKey.toUpperCase() })),
    connections: remoteKeys.map(peerKey => ({
      from: 'local',
      to: peerKey,
      type: 'AccessPoint' as const,
    })),
  };
}

test('PresenceGraphScene: Direct-mode selection focuses the selected peer and its neighbours', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  scene.selectPeer('a');

  assert.equal(scene.selectedPeerKey, 'a');
  assert.deepEqual(scene.focusForPeer('a'), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 1 });
  // Pinned exactly: a loose `< 1` leaves the dimming constant free to drift
  // to a value that no longer reads as a focus treatment.
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 0.25 });

  const selectedLine = [...scene.lines.values()].find(line => line.toKey === 'a')!;
  const unrelatedLine = [...scene.lines.values()].find(line => line.toKey === 'b')!;
  assert.deepEqual(scene.focusForLine(selectedLine), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForLine(unrelatedLine), { selected: false, alpha: 0.08 });
});

test('PresenceGraphScene: full-mesh selection dims unrelated peers and connections', () => {
  const input = graphInput(['a', 'b', 'c']);
  input.connections.push(
    { from: 'a', to: 'b', type: 'Bluetooth' },
    { from: 'b', to: 'c', type: 'P2PWiFi' },
  );
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false });
  scene.applyInput(input);

  scene.selectPeer('a');

  assert.equal(scene.selectedPeerKey, 'a');
  assert.deepEqual(scene.focusForPeer('a'), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('c'), { selected: false, alpha: 0.25 });

  const selectedLine = [...scene.lines.values()].find(line =>
    (line.fromKey === 'a' && line.toKey === 'b')
    || (line.fromKey === 'b' && line.toKey === 'a'))!;
  const unrelatedLine = [...scene.lines.values()].find(line =>
    (line.fromKey === 'b' && line.toKey === 'c')
    || (line.fromKey === 'c' && line.toKey === 'b'))!;
  assert.deepEqual(scene.focusForLine(selectedLine), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForLine(unrelatedLine), { selected: false, alpha: 0.08 });
});

test('PresenceGraphScene: full-mesh selection opens a focused direct-neighbour ring', () => {
  const input = graphInput(['a', 'b', 'c', 'd']);
  input.connections.push(
    { from: 'a', to: 'b', type: 'Bluetooth' },
    { from: 'a', to: 'c', type: 'P2PWiFi' },
    { from: 'b', to: 'd', type: 'AccessPoint' },
  );
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false });
  scene.applyInput(input);

  scene.selectPeer('a');

  assert.equal(scene.isFocusedView, true);
  assert.equal(scene.focusedPeerLabel, 'A');
  assert.equal(scene.selectedPeerKey, 'a');
  // Complete the camera/layout animation and inspect the isolated ring.
  scene.tick(performance.now() + 700, 0);
  const animation = (scene as any).focusAnimation;
  assert.deepEqual(animation.toPositions.get('a'), { x: 0, y: 0 });
  assert.deepEqual([...animation.toPositions.keys()].sort(), ['a', 'b', 'c', 'local']);
  assert.equal(animation.toPositions.has('d'), false, 'multi-hop peers stay in the background');

  scene.exitFocusView();
  scene.tick(performance.now() + 700, 0);
  assert.equal(scene.isFocusedView, false);
  assert.equal(scene.selectedPeerKey, undefined);
});

test('PresenceGraphScene: focus mode fits the neighbourhood and owns its zoom', () => {
  const remoteKeys = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
  const longName = 'Cuttlefish arm64 phone 6';
  const input: PresenceGraphInput = {
    localPeerKey: 'local',
    localDeviceName: 'Local device',
    isLocalConnectedToCloud: false,
    remotePeers: remoteKeys.map(peerKey => ({ peerKey, deviceName: longName })),
    connections: [
      { from: 'local', to: 'peer-0', type: 'AccessPoint' },
      ...remoteKeys.slice(1).map(peerKey => ({
        from: 'peer-0', to: peerKey, type: 'AccessPoint' as const,
      })),
    ],
  };
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false, zoom: 0.55 });
  scene.setSize(800, 600);
  scene.applyInput(input);
  scene.selectPeer('peer-0');

  assert.ok(scene.activeZoom < 1.25, `focus zoom should fit, got ${scene.activeZoom}`);
  assert.equal(scene.zoom, 0.55, 'background zoom is preserved');
  const before = scene.activeZoom;
  scene.setZoom(before + 0.1);
  assert.ok(scene.activeZoom > before, 'focus zoom responds to zoom controls');
  assert.equal(scene.zoom, 0.55, 'zooming focus does not change the background zoom');
});

test('PresenceGraphScene: focused rings expand for long device names', () => {
  const longName = 'Cuttlefish arm64 phone 6';
  const remoteKeys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const input: PresenceGraphInput = {
    localPeerKey: 'local',
    localDeviceName: 'Local device',
    isLocalConnectedToCloud: false,
    remotePeers: remoteKeys.map(peerKey => ({ peerKey, deviceName: longName })),
    connections: [
      { from: 'local', to: 'a', type: 'AccessPoint' as const },
      ...remoteKeys.filter(peerKey => peerKey !== 'a').map(peerKey => ({
        from: 'a', to: peerKey, type: 'AccessPoint' as const,
      })),
    ],
  };
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false });
  scene.applyInput(input);
  scene.selectPeer('a');

  const positions = (scene as any).focusAnimation.toPositions as Map<string, { x: number; y: number }>;
  const ring = ['local', 'b', 'c', 'd', 'e', 'f'];
  const radius = Math.hypot(positions.get('b')!.x, positions.get('b')!.y);
  assert.ok(radius > 200, `long labels should expand the ring, got radius ${radius}`);
  for (let i = 0; i < ring.length; i += 1) {
    const left = positions.get(ring[i]!)!;
    const right = positions.get(ring[(i + 1) % ring.length]!)!;
    assert.ok(
      Math.hypot(left.x - right.x, left.y - right.y) > 180,
      'adjacent long-name pills keep a visible gap',
    );
  }
});

test('PresenceGraphScene: entering Direct mode expands long-label rings and fits inherited zoom', () => {
  const longName = 'Cuttlefish arm64 phone 6';
  const remoteKeys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const input: PresenceGraphInput = {
    localPeerKey: 'local',
    localDeviceName: 'Local device',
    isLocalConnectedToCloud: false,
    remotePeers: remoteKeys.map(peerKey => ({ peerKey, deviceName: longName })),
    connections: remoteKeys.map(peerKey => ({
      from: 'local', to: peerKey, type: 'AccessPoint' as const,
    })),
  };
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false, zoom: 1.65 });
  scene.setSize(800, 600);
  scene.applyInput(input);

  scene.setShowDirectConnectedOnly(true);
  scene.applyInput(input);

  const ring = scene.layout?.ringAssignments.get(1) ?? [];
  const positions = scene.layout?.positions;
  assert.equal(ring.length, remoteKeys.length);
  assert.ok((scene.layout?.ringRadii.get(1) ?? 0) > 200, 'Direct ring grows for long labels');
  assert.ok(scene.zoom < 1.65, `inherited zoom should be fitted, got ${scene.zoom}`);
  for (let i = 0; i < ring.length; i += 1) {
    const left = positions?.get(ring[i]!);
    const right = positions?.get(ring[(i + 1) % ring.length]!);
    assert.ok(left && right);
    assert.ok(
      Math.hypot(left.x - right.x, left.y - right.y) > 215,
      'adjacent long-name pills keep a separating gap',
    );
  }
});

test('PresenceGraphScene: a renamed peer triggers label-aware relayout', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  const before = scene.layout?.ringRadii.get(1) ?? 0;

  scene.applyInput({
    ...graphInput(),
    remotePeers: ['a', 'b'].map(peerKey => ({
      peerKey,
      deviceName: 'A very very very very very very long device name',
    })),
  });

  const after = scene.layout?.ringRadii.get(1) ?? 0;
  assert.ok(after > before, `renaming peers should expand the ring (${before} → ${after})`);
});

test('PresenceGraphScene: clicking the selected peer or empty canvas clears focus', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  scene.selectPeer('a');
  scene.selectPeer('a');
  assert.equal(scene.selectedPeerKey, undefined);

  scene.selectPeer('b');
  scene.selectPeer(undefined);
  assert.equal(scene.selectedPeerKey, undefined);
  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: hover applies the same dimming and clears when pointer leaves peers', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  const hovered = scene.peers.get('a')!;
  const unrelatedLine = [...scene.lines.values()].find(line => line.toKey === 'b')!;

  scene.setHovered(hovered);
  assert.deepEqual(scene.focusForLine(unrelatedLine), { selected: false, alpha: 0.08 });
  assert.ok(scene.focusForPeer('b').alpha < 1);

  scene.setHovered(undefined);
  assert.deepEqual(scene.focusForLine(unrelatedLine), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: persistent selection takes precedence over hovering another peer', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.selectPeer('a');
  scene.setHovered(scene.peers.get('b'));

  const selectedLine = [...scene.lines.values()].find(line => line.toKey === 'a')!;
  const hoveredLine = [...scene.lines.values()].find(line => line.toKey === 'b')!;
  assert.deepEqual(scene.focusForLine(selectedLine), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForLine(hoveredLine), { selected: false, alpha: 0.08 });
});

test('PresenceGraphScene: selection is cleared when graph mode changes and after peer removal', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.selectPeer('a');

  scene.setShowDirectConnectedOnly(false);
  assert.equal(scene.selectedPeerKey, undefined);
  scene.selectPeer('a');
  assert.equal(scene.selectedPeerKey, 'a');

  scene.setShowDirectConnectedOnly(true);
  assert.equal(scene.selectedPeerKey, undefined);
  scene.selectPeer('a');
  scene.applyInput(graphInput(['b']));
  assert.equal(scene.selectedPeerKey, undefined);
});

test('PresenceGraphScene: the local peer is not selectable', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  // Every line touches local in Direct mode, so focusing it would exempt the
  // whole graph from dimming and only thicken every stroke at once.
  scene.selectPeer('local');
  assert.equal(scene.selectedPeerKey, undefined);

  // Clicking the unselectable local peer is treated like clicking empty
  // canvas: it clears any existing selection rather than focusing local.
  scene.selectPeer('a');
  scene.selectPeer('local');
  assert.equal(scene.selectedPeerKey, undefined);
});

test('PresenceGraphScene: selecting an unknown peer clears rather than sticks', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  scene.selectPeer('a');
  scene.selectPeer('ghost');
  assert.equal(scene.selectedPeerKey, undefined);
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: hover focus is dropped when its peer leaves the graph', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('a'));
  assert.equal(scene.hoveredPeerKey, 'a');

  scene.applyInput(graphInput(['b']));

  assert.equal(scene.hoveredPeerKey, undefined);
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: leaving Direct mode drops hover focus too', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('a'));

  scene.setShowDirectConnectedOnly(false);

  assert.equal(scene.hoveredPeerKey, undefined);
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: hovering the local peer is not a focus and highlights no lines', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('local'));

  // Every line touches local in Direct mode, so hover-focusing it would dim
  // nothing and thicken every stroke at once — the glitch the selectPeer
  // guard rejects for clicks. Hover gets the same treatment.
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 }, 'no dimming');
  const line = [...scene.lines.values()].find(l => l.toKey === 'a')!;
  assert.deepEqual(scene.focusForLine(line), { selected: false, alpha: 1 });
  assert.ok(!line.highlighted, 'no emphasized stroke');
  assert.equal(scene.peers.get('local')!.highlighted, true, 'the pill itself still gets the hover fill');
});

test('PresenceGraphScene: hovering the local peer in full-mesh mode still highlights its lines', () => {
  // The Direct-mode glitch rationale does not apply here: local's spokes are
  // a minority of the mesh, and every other peer gets line emphasis on hover.
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: false });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('local'));

  const line = [...scene.lines.values()].find(l => l.toKey === 'a')!;
  assert.equal(line.highlighted, true);
});

test('PresenceGraphScene: leaving Direct mode resets highlight flags, not just focus keys', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('a'));
  assert.equal([...scene.lines.values()].find(l => l.toKey === 'a')!.highlighted, true);

  scene.setShowDirectConnectedOnly(false);

  assert.equal(scene.hoveredPeerKey, undefined);
  assert.equal(scene.peers.get('a')!.highlighted, false, 'node highlight cleared');
  assert.ok([...scene.lines.values()].every(l => !l.highlighted), 'line highlights cleared');
});

test('PresenceGraphScene: zoom snaps to whole percents at the lower clamp boundary', () => {
  const scene = new PresenceGraphScene({});
  for (let i = 0; i < 8; i += 1) { scene.setZoom(scene.zoom - 0.1); }
  // 1 − 0.1 × 8 is 0.19999999999999996 in binary float; the zoom buttons
  // disable at exactly 0.25, so the error would read as one dead click.
  assert.equal(scene.zoom, 0.25);
  scene.setZoom(scene.zoom + 0.05);
  assert.equal(scene.zoom, 0.3);
});

test('PresenceGraphScene: hovered link emphasis survives a presence update', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setHovered(scene.peers.get('a'));

  const hoveredLine = () => [...scene.lines.values()].find(line => line.toKey === 'a')!;
  assert.equal(hoveredLine().highlighted, true);

  // A routine peer.state push rebuilds the line map; the peer stays hovered,
  // so its links must not silently lose their emphasis.
  scene.applyInput(graphInput());
  assert.equal(hoveredLine().highlighted, true);
});

test('PresenceGraphScene: reset view falls back to the origin with no local peer', () => {
  const scene = new PresenceGraphScene({ zoom: 1.5, cameraOffset: { x: 12, y: 9 } });

  scene.resetViewToLocal();

  assert.equal(scene.zoom, 1);
  // Loose === so the negated-zero the fallback produces still counts.
  assert.ok(scene.camera.x === 0, `camera.x at origin, got ${scene.camera.x}`);
  assert.ok(scene.camera.y === 0, `camera.y at origin, got ${scene.camera.y}`);
});

test('PresenceGraphScene: reset view uses the local peer actual position', () => {
  const scene = new PresenceGraphScene({
    showDirectConnectedOnly: true,
    zoom: 1.8,
    cameraOffset: { x: 40, y: -15 },
  });
  scene.applyInput(graphInput());
  scene.setPeerPosition('local', { x: 75, y: -30 });

  scene.resetViewToLocal();

  assert.equal(scene.zoom, 1);
  assert.deepEqual(scene.camera, { x: -75, y: 30 });
});

test('PresenceGraphScene: focus neighbours are recomputed when the topology changes', () => {
  // The neighbour set behind focusForPeer is cached on (focus key, lines
  // epoch). The epoch is the only guard against a stale answer when the
  // topology changes underneath an unchanged selection, so assert exactly
  // that: same selected peer, different connections.
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.selectPeer('a');

  // 'local' is a neighbour of 'a' via the local↔a link, so it is not dimmed.
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 1 });

  // Now 'a' is still present but no longer connected to anything. The
  // selection has not changed, so a cache keyed only on the focus key would
  // keep reporting 'local' as a neighbour.
  const noLinkToA: PresenceGraphInput = {
    ...graphInput(),
    connections: [{ from: 'local', to: 'b', type: 'AccessPoint' as const }],
  };
  scene.applyInput(noLinkToA);

  assert.equal(scene.selectedPeerKey, 'a', 'selection survived the update');
  assert.deepEqual(
    scene.focusForPeer('local'),
    { selected: false, alpha: 0.25 },
    'local is no longer a neighbour of the selected peer',
  );

  // And back again — the cache must not latch in either direction.
  scene.applyInput(graphInput());
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: an active search dims non-matching peers and their connections', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  scene.setSearchMatches(new Set(['a']));

  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 1 });
  // Pinned exactly, same as the selection dimming: the search highlight is
  // meant to read as the same treatment, not a new one.
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 0.25 });
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 0.25 });

  const matchLine = [...scene.lines.values()].find(line => line.toKey === 'a')!;
  const otherLine = [...scene.lines.values()].find(line => line.toKey === 'b')!;
  assert.deepEqual(scene.focusForLine(matchLine), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForLine(otherLine), { selected: false, alpha: 0.08 });
});

test('PresenceGraphScene: an empty search match set dims the whole graph', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());

  // A query with zero hits must not read as "no search": every peer dimmed
  // is what tells the user nothing here matches.
  scene.setSearchMatches(new Set());

  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 0.25 });
  assert.deepEqual(scene.focusForPeer('local'), { selected: false, alpha: 0.25 });

  // ...and clearing the box restores full opacity everywhere.
  scene.setSearchMatches(undefined);
  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
});

test('PresenceGraphScene: hover and click selection override the search dimming', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.setSearchMatches(new Set(['a']));

  // Hover inspects whichever peer is under the pointer even when it is not
  // a search hit; moving off the canvas falls back to the search dimming.
  scene.setHovered(scene.peers.get('b'));
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 0.25 });
  scene.setHovered(undefined);
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 0.25 });
  assert.deepEqual(scene.focusForPeer('a'), { selected: false, alpha: 1 });

  // A click selection is the strongest focus source while a search is live.
  scene.selectPeer('a');
  assert.deepEqual(scene.focusForPeer('a'), { selected: true, alpha: 1 });
  assert.deepEqual(scene.focusForPeer('b'), { selected: false, alpha: 0.25 });
});
