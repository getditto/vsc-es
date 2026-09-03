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
