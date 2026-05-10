import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInterface,
  readLocalNetworkInterfaces,
  shouldHideInterface,
} from '../util/local-network.js';

// ─── classifyInterface (LAN/loopback/other only) ───────────────

test('classifyInterface: loopback wins regardless of name', () => {
  assert.equal(classifyInterface('lo0', true), 'loopback');
  assert.equal(classifyInterface('en0', true), 'loopback');
});

test('classifyInterface: known Wi-Fi name patterns → lan', () => {
  // Wi-Fi and Ethernet are intentionally collapsed into one kind
  // because os.networkInterfaces() can't tell them apart on macOS
  // (en0 over a Thunderbolt dock is wired Ethernet but the name
  // alone would suggest Wi-Fi).
  assert.equal(classifyInterface('wlan0', false), 'lan');
  assert.equal(classifyInterface('wlp3s0', false), 'lan');
  assert.equal(classifyInterface('Wi-Fi', false), 'lan');
});

test('classifyInterface: known Ethernet name patterns → lan', () => {
  assert.equal(classifyInterface('eth0', false), 'lan');
  assert.equal(classifyInterface('enp0s31f6', false), 'lan');
  assert.equal(classifyInterface('ens33', false), 'lan');
  assert.equal(classifyInterface('eno1', false), 'lan');
});

test('classifyInterface: macOS en0/en1 → lan (covers both Wi-Fi and Thunderbolt-dock Ethernet)', () => {
  assert.equal(classifyInterface('en0', false), 'lan');
  assert.equal(classifyInterface('en1', false), 'lan');
});

test('classifyInterface: unknown patterns fall through to other', () => {
  assert.equal(classifyInterface('bridge0', false), 'other');
  assert.equal(classifyInterface('awdl0', false), 'other');
});

// ─── shouldHideInterface (loopback + utun + llw) ───────────────

test('shouldHideInterface: loopback is hidden', () => {
  assert.equal(shouldHideInterface('lo0', true), true);
});

test('shouldHideInterface: utun* tunnels are hidden', () => {
  // macOS VPN / hypervisor tunnels — Tailscale, Docker Desktop,
  // VMware Fusion all expose themselves here.
  assert.equal(shouldHideInterface('utun0', false), true);
  assert.equal(shouldHideInterface('utun17', false), true);
});

test('shouldHideInterface: llw* low-latency-wireless is hidden', () => {
  // macOS AWDL companion link used for Continuity / AirDrop;
  // omnipresent on Apple Silicon and never useful here.
  assert.equal(shouldHideInterface('llw0', false), true);
  assert.equal(shouldHideInterface('LLW0', false), true);
});

test('shouldHideInterface: real interfaces are NOT hidden', () => {
  assert.equal(shouldHideInterface('en0', false), false);
  assert.equal(shouldHideInterface('eth0', false), false);
  assert.equal(shouldHideInterface('wlan0', false), false);
});

// ─── readLocalNetworkInterfaces (integration smoke) ────────────

test('readLocalNetworkInterfaces: returns a list with expected shape', () => {
  const list = readLocalNetworkInterfaces();
  // No assertion on length — a CI runner may have only loopback
  // (which we now filter out), so the list can legitimately be empty.
  for (const i of list) {
    assert.equal(typeof i.name, 'string');
    assert.ok(['lan', 'loopback', 'other'].includes(i.kind));
    assert.ok(Array.isArray(i.ipv4));
    assert.ok(Array.isArray(i.ipv6));
  }
});

test('readLocalNetworkInterfaces: loopback is filtered out', () => {
  const list = readLocalNetworkInterfaces();
  for (const i of list) {
    assert.notEqual(i.kind, 'loopback', `loopback ${i.name} should not surface`);
    assert.ok(!i.name.startsWith('lo'), `loopback-ish ${i.name} should not surface`);
  }
});

test('readLocalNetworkInterfaces: utun/llw interfaces are filtered out', () => {
  const list = readLocalNetworkInterfaces();
  for (const i of list) {
    assert.ok(!i.name.toLowerCase().startsWith('utun'), `${i.name} should be hidden`);
    assert.ok(!i.name.toLowerCase().startsWith('llw'), `${i.name} should be hidden`);
  }
});
