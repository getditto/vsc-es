import test from 'node:test';
import { removeSdkTempDir } from './fixtures/remove-sdk-temp-dir.js';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import { normalizeDittoServerUrl } from '../ditto/HttpQueryService.js';

/**
 * Live validation of the sync-websocket scheme pin (fix(sync): pin the
 * sync websocket scheme for plain-HTTP Big Peers).
 *
 * Background — the bug the pin fixes:
 *   The SDK, on opening in server mode, seeds transportConfig.connect
 *   .websocketURLs from the server URL with the scheme forced to wss://
 *   (`crates/dittoffi/src/ditto.rs`: `wss_url.set_scheme("wss")` — an
 *   UNCONDITIONAL upgrade, with no http->ws case). Against a self-managed
 *   Big Peer serving plain HTTP that produces a TLS ClientHello against a
 *   plaintext port: nginx logs "\x16\x03\x01..." 400s every ~5 s, sync
 *   never establishes, system:data_sync_info stays empty, and the Big
 *   Peer never appears in the Presence Graph — while auth and the REST
 *   API keep working, which makes it look like a server problem.
 *
 * What is asserted here:
 *   1. The SDK's own default really is the unconditional wss:// upgrade
 *      (so the pin is correcting a real defect, not a phantom one).
 *   2. The pin's own scheme mapping: http->ws, https->wss, and a
 *      host-only URL (normalized to https://) -> wss://.
 *   3. The pinned value survives a real round-trip through the SDK's
 *      transport-config serialization, so the string that reaches the
 *      native layer is the one we intend.
 *
 * No Big Peer is required: the websocket URL is a transport-config
 * string, and the SDK's serialization + copy semantics are what's under
 * test. T28 in docs/MANUAL_TESTING.md covers the live nginx-log
 * signature.
 */

DittoLogger.enabled = false;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-ws-pin-test-'));
}

/**
 * The scheme mapping the pin applies, expressed as a pure function so
 * it can be asserted directly. Mirrors the inline transform in
 * DittoManager.connect().
 */
function pinWebsocketScheme(serverUrl: string): string {
  return normalizeDittoServerUrl(serverUrl)
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
}

test('ws pin: the SDK upgrades a server-mode URL to wss:// unconditionally', async t => {
  // Premise check: open a real instance in server mode against a plain-HTTP
  // URL and read back what the SDK seeded into websocketURLs. If the SDK
  // ever stops upgrading to wss://, this pin becomes unnecessary and the
  // test must fail rather than silently passing for a new reason.
  const dir = tmpdir();
  t.after(() => removeSdkTempDir(dir));

  const cfg = new DittoConfig({
    databaseID: '44444444-4444-4444-4444-444444444444',
    connect: { mode: 'server', url: 'http://localhost:9999' },
    persistenceDirectory: dir,
  });
  const ditto = await Ditto.open(cfg);
  t.after(async () => {
    try { await ditto.close(); } catch { /* down */ }
  });

  const seeded = ditto.transportConfig.connect.websocketURLs;
  console.log('SDK-seeded websocketURLs for http://localhost:9999 →', JSON.stringify(seeded));
  assert.ok(
    seeded.some(u => u.startsWith('wss://')),
    'the SDK seeds a wss:// URL even for a plain-HTTP server — this is the defect the pin corrects',
  );
  assert.ok(
    !seeded.some(u => u.startsWith('ws://')),
    'the SDK does NOT seed a plain ws:// URL; the extension must pin it',
  );
});

test('ws pin: the extension pins ws:// for a plain-HTTP server', () => {
  assert.equal(pinWebsocketScheme('http://localhost:9999'), 'ws://localhost:9999');
  assert.equal(pinWebsocketScheme('http://big-peer.internal:8080'), 'ws://big-peer.internal:8080');
  assert.equal(pinWebsocketScheme('HTTP://Big-Peer.Internal:8080'), 'ws://Big-Peer.Internal:8080',
    'the scheme match is case-insensitive');
});

test('ws pin: the extension pins wss:// for an HTTPS server (cloud is a no-op)', () => {
  assert.equal(pinWebsocketScheme('https://example.ditto.live'), 'wss://example.ditto.live');
  assert.equal(pinWebsocketScheme('https://big-peer.internal:8443'), 'wss://big-peer.internal:8443');
  // A host-only URL normalizes to https://, so it pins wss:// — the same
  // value the SDK's own derivation would produce. No behavior change.
  assert.equal(pinWebsocketScheme('example.ditto.live'), 'wss://example.ditto.live');
});

test('ws pin: the pinned URL carries no path (the SDK appends /_ditto/ws)', () => {
  const pinned = pinWebsocketScheme('http://localhost:9999');
  assert.ok(!pinned.includes('/_ditto/ws'), 'the SDK appends the path itself; pinning it would 404');
  assert.ok(!pinned.endsWith('/'), 'no trailing slash — the SDK trims and appends');
});

test('ws pin: the pinned value survives the SDK transport-config round-trip', async t => {
  // The string that reaches the native layer is what the SDK serialized
  // from the config object. Round-trip it through the real SDK's
  // updateTransportConfig so a serialization change (e.g. the SDK
  // renaming or re-deriving the field) fails here rather than at runtime
  // against a Big Peer.
  const dir = tmpdir();
  t.after(() => removeSdkTempDir(dir));

  const cfg = new DittoConfig({
    databaseID: '55555555-5555-5555-5555-555555555555',
    connect: { mode: 'server', url: 'http://localhost:9999' },
    persistenceDirectory: dir,
  });
  const ditto = await Ditto.open(cfg);
  t.after(async () => {
    try { await ditto.close(); } catch { /* down */ }
  });

  const pinned = pinWebsocketScheme('http://localhost:9999');
  ditto.updateTransportConfig((c) => {
    c.connect.websocketURLs = [pinned];
  });

  const readback = ditto.transportConfig.connect.websocketURLs;
  console.log('after pin, websocketURLs →', JSON.stringify(readback));
  assert.ok(
    readback.includes('ws://localhost:9999'),
    'the pinned ws:// URL is what the SDK carries',
  );
  assert.ok(
    !readback.some(u => u.startsWith('wss://localhost:9999')),
    'the wss:// default is gone — no TLS handshake against a plaintext port',
  );
});

test('ws pin: the pin survives a later transport-config apply', async t => {
  // The Peers-panel transport popover calls updateTransportConfig again
  // (applyTransportConfig). That path mutates only the peerToPeer.* fields
  // and relies on updateTransportConfig copying the CURRENT config — so the
  // pinned websocket URL must still be there afterwards. If a future change
  // rebuilt the config from scratch (or the SDK reset the default), the
  // wss:// default would silently return and the Big Peer would break again.
  const dir = tmpdir();
  t.after(() => removeSdkTempDir(dir));

  const cfg = new DittoConfig({
    databaseID: '66666666-6666-6666-6666-666666666666',
    connect: { mode: 'server', url: 'http://localhost:9999' },
    persistenceDirectory: dir,
  });
  const ditto = await Ditto.open(cfg);
  t.after(async () => {
    try { await ditto.close(); } catch { /* down */ }
  });

  ditto.updateTransportConfig((c) => {
    c.connect.websocketURLs = [pinWebsocketScheme('http://localhost:9999')];
  });
  // A later apply, as the Peers panel would do.
  ditto.updateTransportConfig((c) => {
    c.peerToPeer.lan.isEnabled = false;
    c.peerToPeer.bluetoothLE.isEnabled = false;
  });

  const readback = ditto.transportConfig.connect.websocketURLs;
  console.log('after a later transport apply →', JSON.stringify(readback));
  assert.ok(
    readback.includes('ws://localhost:9999'),
    'the pinned ws:// URL survives a later transport-config apply',
  );
  assert.ok(
    !readback.some(u => u.startsWith('wss://localhost:9999')),
    'the SDK did not restore its wss:// default',
  );
});
