import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import { DittoManager } from '../ditto/DittoManager.js';
import type { StoredDittoConfig, SecretSet } from '../models/DittoConfig.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * DittoManager behaviour beyond the lifecycle file: error translation,
 * transport-config application, presence coalescing, observer registration,
 * the sync toggle, and secret-redaction wiring.
 *
 * SCOPE (same envelope as DittoManager.lifecycle.test.ts): a real SDK opened
 * offline in `smallPeersOnly` mode against a temp dir, no license token, no
 * network. `sync.start()` refuses on an unactivated instance, so a real
 * successful `connect()` is not reachable here — the parts of connect() that
 * only run past `sync.start()` (session assignment through the success
 * epilogue) are covered via {@linkcode injectSession}, which opens a real
 * offline Ditto and assigns the session exactly the way connect() would.
 * Everything the tests assert about that session (presence flush, transport
 * apply, toggleSync, observers) is manager logic running against real SDK
 * objects; only the assignment is staged.
 *
 * Offline behaviour these tests rely on, pinned so an SDK change fails loudly
 * instead of silently vacating assertions:
 *   - sync.stop() on a never-started instance is a no-op (does not throw)
 *   - sync.start() throws /has not yet been activated/
 *   - store.registerObserver / sync.registerSubscription / presence.observe
 *     / updateTransportConfig all succeed offline
 */

DittoLogger.enabled = false;

const NOT_ACTIVATED = /has not yet been activated/;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-mgr-behavior-'));
}

interface RecordedLog {
  logger: Logger;
  errors: string[];
  warns: string[];
  infos: string[];
  secrets: string[][];
  clearedSecrets: number;
}

function recordingLogger(): RecordedLog {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const secrets: string[][] = [];
  const rec: RecordedLog = {
    errors, warns, infos, secrets,
    clearedSecrets: 0,
    logger: undefined as unknown as Logger,
  };
  const self = {
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    info: (m: string, _c?: LogContext) => { infos.push(m); },
    debug: () => {}, trace: () => {},
    registerKnownSecrets: (values: readonly string[]) => { secrets.push([...values]); },
    clearKnownSecrets: () => { rec.clearedSecrets += 1; },
    withTag: () => self,
  } as unknown as Logger;
  rec.logger = self;
  return rec;
}

function contextIn(dir: string): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: dir, scheme: 'file', path: dir, query: '' },
    extensionUri: { fsPath: '/ext', scheme: 'file', path: '/ext', query: '' },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

let configSeq = 0;
function makeConfig(over: Partial<StoredDittoConfig> = {}): StoredDittoConfig {
  configSeq += 1;
  return {
    id: `cfg-${configSeq}`,
    name: `db-${configSeq}`,
    databaseId: '00000000-0000-4000-8000-000000000000',
    mode: 'smallPeersOnly',
    authUrl: '',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'error',
    isStrictModeEnabled: false,
    // Every transport off: these tests must never touch the network.
    isLanEnabled: false,
    isBluetoothLeEnabled: false,
    isAwdlEnabled: false,
    ...over,
  };
}

const NO_SECRETS: SecretSet = { token: '' };

/** Private internals the tests reach into to stage a session. Centralised so
 *  a rename in DittoManager fails to compile here, not silently mis-stages. */
interface ManagerInternals {
  session: {
    configId: string;
    ditto: Ditto;
    presenceObserver?: { stop?: () => void } | undefined;
    subscriptionHandles: Map<string, { cancel: () => void }>;
    presenceCoalesceTimer?: NodeJS.Timeout | undefined;
  } | null;
  syncState: 'active' | 'idle';
  localPeerInfo: unknown;
  attachPresenceObserver(ditto: Ditto): void;
  loadLocalPeerInfo(ditto: Ditto): Promise<void>;
}

function internals(mgr: DittoManager): ManagerInternals {
  return mgr as unknown as ManagerInternals;
}

interface Staged {
  mgr: DittoManager;
  dir: string;
  ditto: Ditto;
  log: RecordedLog;
}

/** Stage a session the way a successful connect() would leave it: a real
 *  offline Ditto in the per-config persistence dir, assigned to this.session
 *  with an empty subscription map, status 'active'. */
async function stageSession(
  t: { after(fn: () => void | Promise<void>): void },
  config: StoredDittoConfig,
  opts: {
    configStore?: { get(id: string): StoredDittoConfig | undefined; save(c: StoredDittoConfig): Promise<void> };
    attachPresence?: boolean;
  } = {},
): Promise<Staged> {
  const dir = tmpdir();
  const log = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), log.logger, opts.configStore as never);
  const persistence = path.join(dir, 'dittoData', config.id);
  fs.mkdirSync(persistence, { recursive: true });
  const ditto = await Ditto.open(new DittoConfig(
    config.databaseId, { mode: 'smallPeersOnly', privateKey: null }, persistence,
  ));
  internals(mgr).session = { configId: config.id, ditto, subscriptionHandles: new Map() };
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* already down */ }
    try { await ditto.close(); } catch { /* disconnect owns it */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (opts.attachPresence) { internals(mgr).attachPresenceObserver(ditto); }
  return { mgr, dir, ditto, log };
}

/** Wait until pred() holds, polling on a short timer. Presence flushes are
 *  coalesced over 250ms, so the default budget is generous. */
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) { throw new Error('timed out waiting for condition'); }
    await new Promise(r => setTimeout(r, 10));
  }
}

/** An offline SDK refuses sync.start() (no license), which means
 *  applyTransportConfig's recovery phase can never succeed here. Patch
 *  sync.start to a counting no-op for tests that need a clean apply, and
 *  restore it after. */
function patchSyncStart(t: { after(fn: () => void): void }, ditto: Ditto): { starts: () => number } {
  let count = 0;
  const real = ditto.sync.start.bind(ditto.sync);
  ditto.sync.start = () => { count += 1; };
  t.after(() => { ditto.sync.start = real; });
  return { starts: () => count };
}

// ─── Offline SDK behaviour this file relies on ─────────────────
// These pin the envelope: if a future SDK changes any of these, the tests
// below that depend on them would quietly assert nothing instead of failing.

test('offline envelope: sync.stop() on a never-started instance is a no-op', async t => {
  const { ditto } = await stageSession(t, makeConfig());
  assert.doesNotThrow(() => ditto.sync.stop(), 'applyTransportConfig recovery assumes this');
});

test('offline envelope: sync.start() refuses an unactivated instance', async t => {
  const { ditto } = await stageSession(t, makeConfig());
  assert.throws(() => ditto.sync.start(), NOT_ACTIVATED);
});

// ─── Guards that refuse work without a session (remainder) ─────

test('getSystemSettingOptions rejects for the wrong or missing session', async t => {
  const { mgr } = await stageSession(t, makeConfig());
  await assert.rejects(
    () => mgr.getSystemSettingOptions('some-other-config'),
    /Connect this database to load its current system settings/,
  );
  await mgr.disconnect();
  await assert.rejects(
    () => mgr.getSystemSettingOptions('some-other-config'),
    /Connect this database to load its current system settings/,
  );
});

test('fetchAttachment returns null with no session instead of throwing', async t => {
  const { mgr } = await stageSession(t, makeConfig());
  await mgr.disconnect();
  assert.equal(mgr.fetchAttachment({ id: 'x', len: 1, metadata: {} }), null);
});

test('newAttachment surfaces the SDK error for a missing file', async t => {
  const { mgr, dir } = await stageSession(t, makeConfig());
  await assert.rejects(
    () => mgr.newAttachment(path.join(dir, 'does-not-exist.bin'), {}),
    /No such file|I\/O error/,
  );
});

test('saveAttachmentToPath delegates to the attachment (and rethrows its failure)', async () => {
  const calls: string[] = [];
  const fake = {
    copyToPath: (p: string) => { calls.push(p); return Promise.resolve(); },
  };
  const mgr = new DittoManager(contextIn(tmpdir()), recordingLogger().logger);
  await mgr.saveAttachmentToPath(fake as never, '/tmp/whatever.bin');
  assert.deepEqual(calls, ['/tmp/whatever.bin']);

  const failing = { copyToPath: () => Promise.reject(new Error('disk full')) };
  await assert.rejects(() => mgr.saveAttachmentToPath(failing as never, '/x'), /disk full/);
});

// ─── getSystemSettingOptions against a real offline store ──────

test('getSystemSettingOptions runs SHOW ALL against the active store', async t => {
  const cfg = makeConfig();
  const { mgr, ditto } = await stageSession(t, cfg);
  // Spy on the store the manager holds so the assertion covers "the right
  // statement reached the right store". SDK 5.x answers SHOW ALL with one
  // item whose value is a single wide object (param name → value, ~388 keys)
  // — parseShowAllOptions now understands that shape, so the options list
  // must be non-empty against a real store (it was silently empty before the
  // fix, which the DatabaseEditorPanel surfaced as a blank settings list).
  const executed: string[] = [];
  const realExecute = ditto.store.execute.bind(ditto.store);
  ditto.store.execute = ((q: string, a?: unknown) => { executed.push(q); return realExecute(q, a as never); }) as never;
  t.after(() => { ditto.store.execute = realExecute; });

  const options = await mgr.getSystemSettingOptions(cfg.id);
  assert.deepEqual(executed, ['SHOW ALL']);
  assert.ok(options.length > 100, `expected the full 5.x parameter list, got ${options.length} options`);
  assert.ok(options.some(o => o.parameter === 'DQL_REQUEST_TIMEOUT_SECONDS'),
    'a known 5.1 parameter parses through the wide-map shape');
});

// ─── Subscription registration / cancellation ──────────────────

test('registerSubscription and cancelSubscription no-op without a session', async () => {
  const mgr = new DittoManager(contextIn(tmpdir()), recordingLogger().logger);
  assert.doesNotThrow(() => {
    mgr.registerSubscription('s1', 'SELECT * FROM t');
    mgr.cancelSubscription('s1');
  });
});

test('registerSubscription dedupes by id; cancelSubscription cancels the handle once', async t => {
  const { mgr } = await stageSession(t, makeConfig());
  const internal = internals(mgr);
  const session = internal.session!;
  const original = session.ditto.sync.registerSubscription.bind(session.ditto.sync);
  const cancellations: string[] = [];
  let registrations = 0;
  session.ditto.sync.registerSubscription = (query: string) => {
    registrations += 1;
    const h = original(query) as { cancel(): void };
    return { cancel: () => { cancellations.push(query); h.cancel(); } } as never;
  };

  mgr.registerSubscription('s1', 'SELECT * FROM a');
  mgr.registerSubscription('s1', 'SELECT * FROM b'); // same id — must be ignored
  assert.equal(registrations, 1, 'a duplicate id does not re-register');
  assert.deepEqual([...session.subscriptionHandles.keys()], ['s1']);

  mgr.cancelSubscription('nope');
  assert.deepEqual(cancellations, [], 'cancelling an unknown id touches nothing');

  mgr.cancelSubscription('s1');
  assert.deepEqual(cancellations, ['SELECT * FROM a']);
  assert.equal(session.subscriptionHandles.size, 0);
});

test('disconnect cancels live subscription handles and fires presence + sync + status', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  const internal = internals(mgr);
  const session = internal.session!;
  const original = session.ditto.sync.registerSubscription.bind(session.ditto.sync);
  let cancels = 0;
  session.ditto.sync.registerSubscription = (query: string) => {
    const h = original(query) as { cancel(): void };
    return { cancel: () => { cancels += 1; h.cancel(); } } as never;
  };
  mgr.registerSubscription('s1', 'SELECT * FROM t');

  internal.syncState = 'active';
  internal.localPeerInfo = { peerKey: '', deviceName: 'VS Code', sdkLanguage: '', sdkPlatform: '', sdkVersion: '' };

  const presencePayloads: { local: unknown; remote: unknown[] }[] = [];
  const syncStates: string[] = [];
  const statuses: string[] = [];
  const subs = [
    mgr.onPresence(s => presencePayloads.push(s)),
    mgr.onSyncChange(s => syncStates.push(s)),
    mgr.onStatusChange(s => statuses.push(s)),
  ];
  t.after(() => subs.forEach(s => s.dispose()));

  await mgr.disconnect();

  assert.equal(cancels, 1, 'the live handle was cancelled');
  assert.deepEqual(syncStates, ['idle']);
  assert.deepEqual(statuses, ['idle']);
  assert.equal(presencePayloads.length, 1, 'presence fired once');
  assert.deepEqual(presencePayloads[0], { local: null, remote: [] }, 'local peer info is cleared too');
  assert.equal(log.clearedSecrets >= 1, true, 'redaction set dropped on disconnect');
  assert.ok(log.infos.includes('Disconnected'));
});

// ─── toggleSync ────────────────────────────────────────────────

test('toggleSync with no session returns idle and notifies nobody', async () => {
  const mgr = new DittoManager(contextIn(tmpdir()), recordingLogger().logger);
  const seen: string[] = [];
  const sub = mgr.onSyncChange(s => seen.push(s));
  assert.equal(await mgr.toggleSync(), 'idle');
  assert.deepEqual(seen, []);
  sub.dispose();
});

test('toggleSync from idle attempts sync.start and stays idle when the SDK refuses', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  assert.equal(mgr.getSyncState(), 'idle');
  const state = await mgr.toggleSync();
  assert.equal(state, 'idle', 'the failed start leaves state untouched');
  assert.equal(mgr.getSyncState(), 'idle');
  assert.ok(
    log.warns.some(w => w.includes('sync.start() failed')),
    `the refusal is logged, got ${JSON.stringify(log.warns)}`,
  );
});

test('toggleSync from active stops sync and forces a presence emission', async t => {
  const cfg = makeConfig();
  const { mgr } = await stageSession(t, cfg);
  internals(mgr).syncState = 'active'; // as a successful connect leaves it

  const syncEvents: [string, string | null][] = [];
  const presencePayloads: unknown[] = [];
  const subs = [
    mgr.onSyncChange((s, id) => syncEvents.push([s, id])),
    mgr.onPresence(s => presencePayloads.push(s)),
  ];
  t.after(() => subs.forEach(s => s.dispose()));

  const state = await mgr.toggleSync();
  assert.equal(state, 'idle');
  assert.equal(syncEvents.length, 1, 'one sync notification');
  assert.equal(syncEvents[0]![0], 'idle');
  assert.equal(syncEvents[0]![1], cfg.id, 'the notification names the session config');
  assert.equal(presencePayloads.length, 1, 'stop forces an immediate snapshot rebuild');
});

test('toggleSync stays active when sync.stop() throws', async t => {
  const { mgr, ditto, log } = await stageSession(t, makeConfig());
  internals(mgr).syncState = 'active';
  const realStop = ditto.sync.stop.bind(ditto.sync);
  ditto.sync.stop = () => { throw new Error('teardown in flight'); };
  t.after(() => { ditto.sync.stop = realStop; });

  const state = await mgr.toggleSync();
  assert.equal(state, 'active', 'a failed stop must not lie to the UI');
  assert.equal(mgr.getSyncState(), 'active');
  assert.ok(log.warns.some(w => w.includes('sync.stop() failed')));
});

// ─── applyTransportConfig against a live (offline) session ─────

test('applyTransportConfig applies gated prefs and persists them', async t => {
  const cfg = makeConfig({ isLanEnabled: false });
  const saved: StoredDittoConfig[] = [];
  const configStore = {
    get: (id: string) => (id === cfg.id ? cfg : undefined),
    save: (c: StoredDittoConfig) => { saved.push(c); return Promise.resolve(); },
  };
  const { mgr, ditto, log } = await stageSession(t, cfg, { configStore });
  const syncStart = patchSyncStart(t, ditto); // offline SDK refuses recovery's sync.start

  await mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: true, isAwdlEnabled: true });

  const tc = ditto.transportConfig.peerToPeer;
  assert.equal(tc.lan.isEnabled, true, 'requested LAN applied');
  assert.equal(tc.lan.isMdnsEnabled, true, 'mdns follows the LAN flag');
  assert.equal(tc.lan.isMulticastEnabled, true);
  // The OS gate is platform-dependent; the prefs as persisted must match
  // the gate, not the raw request.
  assert.equal(saved.length, 1, 'prefs persisted once');
  assert.equal(saved[0]!.id, cfg.id);
  assert.equal(saved[0]!.isLanEnabled, true);
  assert.equal(typeof saved[0]!.isBluetoothLeEnabled, 'boolean');
  assert.equal(typeof saved[0]!.isAwdlEnabled, 'boolean');
  assert.equal(saved[0]!.isBluetoothLeEnabled, tc.bluetoothLE.isEnabled, 'persisted prefs match the gated apply');
  assert.equal(saved[0]!.isAwdlEnabled, tc.awdl.isEnabled);
  assert.ok(log.infos.some(m => m.includes('Transport apply: complete')), `saw ${JSON.stringify(log.infos)}`);
  assert.ok(log.infos.some(m => m.includes('Transport readback')));
  assert.equal(syncStart.starts(), 1, 'recovery restarted sync');
  assert.equal(mgr.getSyncState(), 'active', 'recovery flips sync state on success');
  assert.equal(mgr.isApplyingTransports(), false, 'flag clears after success');
});

test('applyTransportConfig without a configStore warns and still applies', async t => {
  const { mgr, ditto, log } = await stageSession(t, makeConfig());
  patchSyncStart(t, ditto);
  await mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false });
  assert.equal(ditto.transportConfig.peerToPeer.lan.isEnabled, true);
  assert.ok(log.warns.some(m => m.includes('no configStore reference')), `saw ${JSON.stringify(log.warns)}`);
});

test('applyTransportConfig warns when the store has no entry for the config', async t => {
  const cfg = makeConfig();
  const configStore = {
    get: () => undefined,
    save: () => { assert.fail('save must not run without an entry'); },
  };
  const { mgr, ditto, log } = await stageSession(t, cfg, { configStore });
  patchSyncStart(t, ditto);
  await mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false });
  assert.equal(ditto.transportConfig.peerToPeer.lan.isEnabled, true);
  assert.ok(log.warns.some(m => m.includes('no entry for configId')));
});

test('applyTransportConfig re-attaches the presence observer it tore down', async t => {
  // The apply stops the old observer; without re-attach the Peers list goes
  // silent until the next connect.
  const { mgr, ditto } = await stageSession(t, makeConfig(), { attachPresence: true });
  patchSyncStart(t, ditto);
  const before = internals(mgr).session?.presenceObserver;
  assert.ok(before, 'staged with an observer');

  await mgr.applyTransportConfig({ isLanEnabled: false, isBluetoothLeEnabled: false, isAwdlEnabled: false });

  const after = internals(mgr).session?.presenceObserver;
  assert.ok(after, 'a new observer is attached');
  assert.notEqual(after, before, 'it is a fresh observer, not the stopped one');
});

test('applyTransportConfig rethrows the primary failure after recovery runs', async t => {
  const { mgr, ditto, log } = await stageSession(t, makeConfig());
  const realUpdate = ditto.updateTransportConfig.bind(ditto);
  ditto.updateTransportConfig = () => { throw new Error('native config rejected'); };
  t.after(() => { ditto.updateTransportConfig = realUpdate; });

  await assert.rejects(
    () => mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false }),
    (err: unknown) => {
      // The apply error is the cause the user needs — not a wrapper, and not
      // the recovery's sync.start() refusal (which is expected offline).
      assert.equal((err as Error).message, 'native config rejected');
      return true;
    },
  );
  assert.ok(log.errors.some(m => m.includes('Transport apply: failed')));
  assert.ok(log.errors.some(m => m.includes('sync.start() failed')), 'recovery ran and its failure was logged separately');
  assert.equal(mgr.isApplyingTransports(), false, 'the flag clears even on failure');
});

test('applyTransportConfig surfaces a recovery sync.start() failure when the apply succeeded', async t => {
  const { mgr, ditto } = await stageSession(t, makeConfig());
  const realStart = ditto.sync.start.bind(ditto.sync);
  ditto.sync.start = () => { throw new Error('sync blew up'); };
  t.after(() => { ditto.sync.start = realStart; });

  await assert.rejects(
    () => mgr.applyTransportConfig({ isLanEnabled: false, isBluetoothLeEnabled: false, isAwdlEnabled: false }),
    /sync blew up/,
  );
  assert.equal(mgr.isApplyingTransports(), false);
  assert.equal(mgr.getSyncState(), 'idle', 'recovery did not reach the sync-state flip');
});

test('applyTransportConfig rethrows a persistence failure, verbatim, after recovery ran', async t => {
  // The saved prefs are the user's record of what they asked for; a failure
  // there is the primary error — never masked by the recovery that still ran.
  const cfg = makeConfig();
  const persistBoom = new Error('memento write failed');
  const configStore = {
    get: (id: string) => (id === cfg.id ? cfg : undefined),
    save: () => Promise.reject(persistBoom),
  };
  const { mgr, ditto, log } = await stageSession(t, cfg, { configStore });
  const syncStart = patchSyncStart(t, ditto);

  await assert.rejects(
    () => mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false }),
    (err: unknown) => {
      assert.equal(err, persistBoom, 'rethrown verbatim, not wrapped');
      return true;
    },
  );
  assert.equal(syncStart.starts(), 1, 'recovery still restarted sync');
  assert.equal(ditto.transportConfig.peerToPeer.lan.isEnabled, true, 'the SDK-side apply was not rolled back');
  assert.equal(mgr.getSyncState(), 'active', 'recovery finished despite the persistence failure');
  assert.ok(log.errors.some(m => m.includes('Transport apply: failed')));
  assert.equal(mgr.isApplyingTransports(), false);
});

test('applyTransportConfig tolerates a failed observer re-attach', async t => {
  // attachPresenceObserver throwing must never mask a successful apply: the
  // observers can be re-attached on the next presence tick.
  const { mgr, ditto, log } = await stageSession(t, makeConfig());
  patchSyncStart(t, ditto);
  const realObserve = ditto.presence.observe.bind(ditto.presence);
  ditto.presence.observe = (() => { throw new Error('presence subsystem wedged'); });
  t.after(() => { ditto.presence.observe = realObserve; });

  await mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false });

  assert.equal(ditto.transportConfig.peerToPeer.lan.isEnabled, true, 'the apply itself landed');
  assert.ok(log.errors.some(m => m.includes('re-attach observers failed')), `saw ${JSON.stringify(log.errors)}`);
  assert.equal(mgr.isApplyingTransports(), false);
});

test('applyTransportConfig refuses a concurrent apply', async t => {
  // A fake Ditto is deliberate here: the guard must trigger while the FIRST
  // apply is between "flag set" and "flag cleared", and with a real offline
  // Ditto that stretch has no awaitable suspension point to park in. The fake
  // parks recovery's __small_peer_info query (recovery's one awaited step)
  // until the refusal has been observed.
  //
  // The refusal now lives in the PUBLIC entry point: a pre-lock check on
  // `applyingTransports` fails fast while an apply is in flight (previously
  // the check sat inside the locked method, where the lock's serialization
  // made it unreachable — the second call would queue and silently re-apply).
  const dir = tmpdir();
  const log = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), log.logger);
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* down */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let parked: (() => void) | undefined;
  let enteredRecovery: (() => void) | undefined;
  const recoveryEntered = new Promise<void>(resolve => { enteredRecovery = resolve; });
  const transportConfig = {
    peerToPeer: {
      lan: { isEnabled: true, isMdnsEnabled: true, isMulticastEnabled: true },
      bluetoothLE: { isEnabled: false },
      awdl: { isEnabled: false },
    },
  };
  const fakeDitto = {
    sync: { stop: () => {}, start: () => {} },
    updateTransportConfig: (fn: (c: typeof transportConfig) => void) => { fn(transportConfig); },
    transportConfig,
    presence: { observe: () => ({ stop() {} }) },
    store: {
      execute: (q: string) => {
        if (q.includes('__small_peer_info')) {
          enteredRecovery!(); // recovery reached its one awaited step
          return new Promise(r => { parked = () => r({ items: [] }); });
        }
        return Promise.resolve({ items: [] });
      },
    },
  };
  internals(mgr).session = {
    configId: 'cfg-fake', ditto: fakeDitto as unknown as Ditto, subscriptionHandles: new Map(),
  };

  const first = mgr.applyTransportConfig({ isLanEnabled: false, isBluetoothLeEnabled: false, isAwdlEnabled: false });
  await recoveryEntered;
  assert.equal(mgr.isApplyingTransports(), true, 'the first apply is parked mid-recovery');

  await assert.rejects(
    () => mgr.applyTransportConfig({ isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false }),
    /Transport change already in progress/,
  );
  assert.equal(transportConfig.peerToPeer.lan.isEnabled, false, 'the refused apply never touched the config');

  parked!();
  await first;
  assert.equal(mgr.isApplyingTransports(), false, 'the flag clears afterwards');
  assert.equal(mgr.getSyncState(), 'active', 'the parked apply recovered cleanly once released');
});

// ─── Presence handling ─────────────────────────────────────────

test('a presence observer emission reaches listeners after the coalesce window', async t => {
  const cfg = makeConfig();
  const { mgr } = await stageSession(t, cfg, { attachPresence: true });
  // connect() loads this from __small_peer_info after attaching the observer;
  // offline that query returns no rows, so stage it directly — the behaviour
  // under test is the firePresence stamping, not the query.
  internals(mgr).localPeerInfo = {
    peerKey: '', deviceName: 'VS Code', sdkLanguage: '', sdkPlatform: '', sdkVersion: '',
  };
  const payloads: { local: { peerKey: string; deviceName: string } | null; remote: unknown[] }[] = [];
  const sub = mgr.onPresence(s => payloads.push(s));
  t.after(() => sub.dispose());

  await waitFor(() => payloads.some(p => p.local !== null));
  const snap = payloads[payloads.length - 1]!;
  assert.equal(snap.local!.deviceName, 'VS Code');
  assert.ok(snap.local!.peerKey.length > 0,
    'firePresence stamps the peer key from the graph onto local info');
});

test('the coalesce window collapses a burst of presence callbacks into one flush', async t => {
  // Stage the session WITHOUT an observer so no timer can come from the real
  // SDK, then capture the manager's observer callback and drive a burst
  // faster than the 250ms window.
  const { mgr } = await stageSession(t, makeConfig());
  const internal = internals(mgr);
  const ditto = internal.session!.ditto;
  let captured: ((g: unknown) => void) | undefined;
  const realObserve = ditto.presence.observe.bind(ditto.presence);
  ditto.presence.observe = ((cb: (g: unknown) => void) => { captured = cb; return { stop() {} }; }) as typeof ditto.presence.observe;
  t.after(() => { ditto.presence.observe = realObserve; });
  internal.attachPresenceObserver(ditto);
  assert.ok(captured, 'the attach registered a callback');

  const payloads: {
    local: { peerKey: string } | null;
    presenceGraph?: { remotePeers: { peerKey: string }[] } | undefined;
  }[] = [];
  const sub = mgr.onPresence(s => payloads.push(s));
  t.after(() => sub.dispose());

  // Synthetic graphs shaped like the real PresenceGraph so the identity
  // guard and the snapshot rebuild accept them; the burst differs only in
  // the local peer key.
  const graph = (key: string) => ({
    localPeer: {
      peerKey: key, deviceName: 'VS Code', os: 'macOS',
      connections: [], peerMetadata: {}, identityServiceMetadata: {},
      isConnectedToDittoServer: false,
    },
    remotePeers: [],
    connections: [],
  });
  captured(graph('burst-1'));
  captured(graph('burst-2'));
  // A remote peer wired to burst-3's local key: buildPresenceGraphView only
  // emits remote peers that participate in an edge, so seeing it in the
  // snapshot proves the LAST graph of the burst is what flushed.
  captured({
    ...graph('burst-3'),
    remotePeers: [{
      peerKey: 'remote-1', deviceName: 'Phone', os: 'iOS',
      connections: [{ id: 'c1', connectionType: 'P2PWiFi', peer1: 'burst-3', peer2: 'remote-1' }],
      peerMetadata: {}, identityServiceMetadata: {}, isConnectedToDittoServer: false,
    }],
  });

  await waitFor(() => payloads.length > 0);
  await new Promise(r => setTimeout(r, 400)); // any further timer would have fired
  assert.equal(payloads.length, 1, 'three callbacks inside the window flushed once');
  const snap = payloads[0]!;
  assert.deepEqual(
    snap.presenceGraph?.remotePeers.map(p => p.peerKey),
    ['remote-1'],
    'the flush carries the last graph of the burst',
  );
});

test('a stale flush is dropped after disconnect', async t => {
  const { mgr } = await stageSession(t, makeConfig(), { attachPresence: true });
  const payloads: unknown[] = [];
  const sub = mgr.onPresence(s => payloads.push(s));
  t.after(() => sub.dispose());
  await waitFor(() => payloads.length > 0);

  await mgr.disconnect();
  // Disconnect clears the pending timer; a flush that still ran would write
  // presence for a dead session. Only the disconnect's own empty fire is
  // allowed past this point.
  const atDisconnect = payloads.length;
  await new Promise(r => setTimeout(r, 400));
  assert.equal(payloads.length, atDisconnect, 'no presence write from beyond the grave');
  assert.deepEqual(mgr.getLatestSnapshot(), { local: null, remote: [] });
});

// ─── Store observers ───────────────────────────────────────────

test('registerStoreObserver fires with the current rows, and callback throws are absorbed', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  await mgr.executeRaw('INSERT INTO keepme DOCUMENTS (:doc)', { doc: { _id: 'a', n: 1 } });

  const deliveries: Record<string, unknown>[][] = [];
  const handle = mgr.registerStoreObserver('SELECT * FROM keepme', rows => { deliveries.push(rows); });
  assert.ok(handle, 'observer registered');
  await waitFor(() => deliveries.length > 0);
  assert.deepEqual(deliveries[0], [{ _id: 'a', n: 1 }]);

  // A throwing consumer must not break the SDK callback or future firings.
  let fired = 0;
  const throwing = mgr.registerStoreObserver('SELECT * FROM keepme', () => {
    fired += 1;
    throw new Error('consumer exploded');
  });
  t.after(() => { throwing?.cancel(); });
  await waitFor(() => fired > 0);
  assert.ok(log.warns.some(w => w.includes('Store observer callback threw')));

  await mgr.executeRaw('INSERT INTO keepme DOCUMENTS (:doc)', { doc: { _id: 'b', n: 2 } });
  await waitFor(() => deliveries.some(rows => rows.length === 2));

  handle.cancel();
  const settled = deliveries.length;
  await mgr.executeRaw('INSERT INTO keepme DOCUMENTS (:doc)', { doc: { _id: 'c', n: 3 } });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(deliveries.length, settled, 'a cancelled observer stops firing');
});

test('registerObserver ships rows, diff indexes, and the totalRows cap contract', async t => {
  const { mgr } = await stageSession(t, makeConfig());
  await mgr.executeRaw('INSERT INTO obs DOCUMENTS (:doc)', { doc: { _id: 'a', n: 1 } });

  const events: { rows: Record<string, unknown>[]; totalRows: number; insertions: number[] }[] = [];
  const handle = mgr.registerObserver('SELECT * FROM obs ORDER BY _id', e => events.push(e));
  assert.ok(handle, 'observer registered');
  t.after(() => handle.cancel());

  await waitFor(() => events.length > 0);
  assert.deepEqual(events[0]!.rows, [{ _id: 'a', n: 1 }]);
  assert.equal(events[0]!.totalRows, 1);
  assert.deepEqual(events[0]!.insertions, [0], 'first firing reports everything as inserted');

  await mgr.executeRaw('INSERT INTO obs DOCUMENTS (:doc)', { doc: { _id: 'b', n: 2 } });
  await waitFor(() => events.length > 1);
  assert.equal(events[1]!.totalRows, 2);
  assert.equal(events[1]!.rows.length, 2);
  assert.ok(events[1]!.insertions.length > 0, 'the Differ reported the new row');
});

test('registerObserver callback throws are logged, not propagated into the SDK callback', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  let fired = 0;
  const handle = mgr.registerObserver('SELECT * FROM obs', () => {
    fired += 1;
    throw new Error('panel exploded');
  });
  t.after(() => handle?.cancel());
  await waitFor(() => fired > 0);
  assert.ok(log.warns.some(w => w.includes('Observer callback threw')));
});

test('registerObserver and registerStoreObserver return null without a session', async () => {
  const mgr = new DittoManager(contextIn(tmpdir()), recordingLogger().logger);
  assert.equal(mgr.registerObserver('SELECT * FROM t', () => {}), null);
  assert.equal(mgr.registerStoreObserver('SELECT * FROM t', () => {}), null);
});

// ─── executeRaw argument binding ───────────────────────────────

test('executeRaw binds DQL arguments and dematerializes every item', async t => {
  const { mgr } = await stageSession(t, makeConfig());
  await mgr.executeRaw(
    'INSERT INTO args DOCUMENTS (:a), (:b)',
    { a: { _id: 'x1', v: 1 }, b: { _id: 'x2', v: 2 } },
  );
  const rows = await mgr.executeRaw('SELECT * FROM args ORDER BY _id');
  assert.deepEqual(rows, [{ _id: 'x1', v: 1 }, { _id: 'x2', v: 2 }]);
});

// ─── Listener notify isolation (remainder: presence + sync) ────

test('a throwing presence listener does not block the others', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  const order: string[] = [];
  const a = mgr.onPresence(() => { order.push('a'); throw new Error('exploded'); });
  const b = mgr.onPresence(() => { order.push('b'); });
  t.after(() => { a.dispose(); b.dispose(); });

  await mgr.disconnect(); // disconnect fires presence unconditionally
  assert.deepEqual(order, ['a', 'b'], 'the thrower did not starve the next listener');
  assert.ok(log.warns.some(w => w.includes('Listener threw')));
});

test('a throwing sync listener is isolated the same way', async t => {
  const { mgr, log } = await stageSession(t, makeConfig());
  internals(mgr).syncState = 'active';
  const order: string[] = [];
  const a = mgr.onSyncChange(() => { order.push('a'); throw new Error('exploded'); });
  const b = mgr.onSyncChange(() => { order.push('b'); });
  t.after(() => { a.dispose(); b.dispose(); });

  await mgr.toggleSync();
  assert.deepEqual(order, ['a', 'b']);
  assert.ok(log.warns.some(w => w.includes('Listener threw')));
});

// ─── Connect: transport prefs + error translation ──────────────

test('a failed connect still applies the config transport prefs before sync.start refuses', async t => {
  // The transport application runs before the activation boundary, so even a
  // doomed connect must leave the SDK's transport config reflecting the
  // requested prefs (and the OS gate). Proven via the readback log, which
  // reads ditto.transportConfig straight back off the instance.
  const dir = tmpdir();
  const log = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), log.logger);
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* down */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = makeConfig({ isLanEnabled: false });
  await assert.rejects(() => mgr.connect(cfg, NO_SECRETS), NOT_ACTIVATED);
  assert.ok(log.infos.some(m => m.includes('Transport readback')), 'connect logged the readback');
});

test('an invalid startup system setting fails the connect with the parameter named', async t => {
  // applySystemSettings validates before touching the store, so this fails
  // before sync.start() — exercising a connect error path that is not the
  // usual activation refusal.
  const dir = tmpdir();
  const log = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), log.logger);
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* down */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cfg = makeConfig({
    advancedConfig: { systemSettings: [{ parameter: '1bad name', type: 'integer', value: 1 }] },
  });
  await assert.rejects(
    () => mgr.connect(cfg, NO_SECRETS),
    (err: unknown) => {
      assert.match((err as Error).message, /invalid name/i);
      return true;
    },
  );
  assert.equal(mgr.getActiveConfigId(), null);
  assert.equal(mgr.getCurrentLifecycleState().kind, 'error');
  assert.ok(log.errors.includes('Connect failed'));
});

test('a failed connect clears the redaction set it never registered', async t => {
  const dir = tmpdir();
  const log = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), log.logger);
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* down */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A secretKey that is not valid base64 makes Ditto.open reject before the
  // activation boundary — a connect error path distinct from the usual
  // sync.start refusal.
  await assert.rejects(
    () => mgr.connect(makeConfig(), { token: '', secretKey: 'not-base64!!' }),
    /valid DittoConfig/,
  );
  assert.deepEqual(log.secrets, [], 'a failed connect never registers secrets');
  assert.ok(log.clearedSecrets >= 1, 'and clears the set defensively');
});
