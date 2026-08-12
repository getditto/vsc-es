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
  assert.ok(scene.focusForPeer('b').alpha < 1);

  const selectedLine = [...scene.lines.values()].find(line => line.toKey === 'a')!;
  const unrelatedLine = [...scene.lines.values()].find(line => line.toKey === 'b')!;
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

test('PresenceGraphScene: selection is cleared outside Direct mode and after peer removal', () => {
  const scene = new PresenceGraphScene({ showDirectConnectedOnly: true });
  scene.applyInput(graphInput());
  scene.selectPeer('a');

  scene.setShowDirectConnectedOnly(false);
  assert.equal(scene.selectedPeerKey, undefined);
  scene.selectPeer('a');
  assert.equal(scene.selectedPeerKey, undefined);

  scene.setShowDirectConnectedOnly(true);
  scene.selectPeer('a');
  scene.applyInput(graphInput(['b']));
  assert.equal(scene.selectedPeerKey, undefined);
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
