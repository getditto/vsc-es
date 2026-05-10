import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInterface, readLocalNetworkInterfaces } from '../util/local-network.js';

test('classifyInterface: loopback wins regardless of name', () => {
  assert.equal(classifyInterface('lo0', true), 'loopback');
  assert.equal(classifyInterface('en0', true), 'loopback');
});

test('classifyInterface: Linux Wi-Fi prefixes', () => {
  assert.equal(classifyInterface('wlan0', false), 'wifi');
  assert.equal(classifyInterface('wlp3s0', false), 'wifi');
  assert.equal(classifyInterface('Wi-Fi', false), 'wifi');
});

test('classifyInterface: Linux Ethernet prefixes', () => {
  assert.equal(classifyInterface('eth0', false), 'ethernet');
  assert.equal(classifyInterface('enp0s31f6', false), 'ethernet');
  assert.equal(classifyInterface('ens33', false), 'ethernet');
  assert.equal(classifyInterface('eno1', false), 'ethernet');
});

test('classifyInterface: unknown patterns fall through to other', () => {
  assert.equal(classifyInterface('utun0', false), 'other');
  assert.equal(classifyInterface('awdl0', false), 'other');
  assert.equal(classifyInterface('bridge0', false), 'other');
});

test('readLocalNetworkInterfaces: returns a list (stdlib smoke test)', () => {
  const list = readLocalNetworkInterfaces();
  // Every machine has at least loopback configured, so the result
  // should never be empty in a healthy test environment.
  assert.ok(list.length > 0, 'expected at least one interface');
  // Each entry has the documented shape.
  for (const i of list) {
    assert.equal(typeof i.name, 'string');
    assert.ok(['wifi', 'ethernet', 'loopback', 'other'].includes(i.kind));
    assert.ok(Array.isArray(i.ipv4));
    assert.ok(Array.isArray(i.ipv6));
  }
});

test('readLocalNetworkInterfaces: loopback sorts last', () => {
  const list = readLocalNetworkInterfaces();
  const lastNonLoopbackIdx = list.findIndex(i => i.kind === 'loopback') - 1;
  if (lastNonLoopbackIdx >= 0) {
    // Every entry after the first loopback must also be loopback.
    for (let i = lastNonLoopbackIdx + 1; i < list.length; i += 1) {
      assert.equal(list[i].kind, 'loopback');
    }
  }
});
