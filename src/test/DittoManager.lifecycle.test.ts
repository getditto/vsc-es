import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Ditto, DittoConfig, Logger as DittoLogger } from '@dittolive/ditto';
import { DittoManager } from '../ditto/DittoManager.js';
import type { StoredDittoConfig, SecretSet, StoredSubscription } from '../models/DittoConfig.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * DittoManager against a real SDK, offline.
 *
 * This is the highest-risk file in the extension — one SDK instance ever, with
 * connect/disconnect/switch, transport re-application, and an OS lock on the
 * working directory — and it had no behavioural coverage. Every bug fixed in it
 * so far was found by reading it, which is not a strategy.
 *
 * IMPORTANT SCOPE LIMIT. `connect()` calls `sync.start()`, and the SDK refuses
 * that until the instance is activated with a license token. So a *successful*
 * connect is not reachable offline and is not tested here — that belongs to
 * `src/test/integration/e2e.test.ts`, which runs in the Extension Development
 * Host with CI credentials.
 *
 * What IS reachable, and is covered below: everything up to sync.start
 * (validation, per-config persistence directory, SDK log level), the whole
 * failure and teardown path (which is where the interesting bugs live), the
 * guards that refuse work without a session, and the working-directory lock.
 * The store-level query paths are covered separately in dql-live.test.ts.
 */

DittoLogger.enabled = false;

/** The error the SDK raises for an unactivated offline instance. Asserting on
 *  it keeps these tests honest: if the SDK ever stops requiring activation,
 *  the connect path starts succeeding and these tests must be revisited rather
 *  than silently passing for a new reason. */
const NOT_ACTIVATED = /has not yet been activated/;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-mgr-test-'));
}

function recordingLogger(): { logger: Logger; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const self = {
    error: (m: string, _c?: LogContext) => { errors.push(m); },
    warn: (m: string, _c?: LogContext) => { warns.push(m); },
    info: () => {}, debug: () => {}, trace: () => {},
    registerKnownSecrets: () => {}, clearKnownSecrets: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return { logger: self, errors, warns };
}

/** An ExtensionContext with just the surface DittoManager reaches for. */
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

const SECRETS: SecretSet = { token: '' };

function withManager(t: { after(fn: () => void | Promise<void>): void }): {
  mgr: DittoManager;
  dir: string;
  errors: string[];
  warns: string[];
} {
  const dir = tmpdir();
  const { logger, errors, warns } = recordingLogger();
  const mgr = new DittoManager(contextIn(dir), logger);
  t.after(async () => {
    try { await mgr.disconnect(); } catch { /* already down */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mgr, dir, errors, warns };
}

// ─── The failure and teardown path ─────────────────────────────

test('DittoManager: a failed connect holds no session and reports error', async t => {
  // A retained partial session would make getActiveConfigId() name a config
  // whose lifecycle is 'error', and would keep a live Ditto instance holding
  // the working-directory lock.
  const { mgr } = withManager(t);
  const cfg = makeConfig();

  await assert.rejects(() => mgr.connect(cfg, SECRETS), NOT_ACTIVATED);

  assert.equal(mgr.getActiveConfigId(), null, 'no session retained');
  assert.equal(mgr.getCurrentLifecycleState().kind, 'error');
});

test('DittoManager: a failed connect surfaces as error status on its own config', async t => {
  // Regression: getStatus() short-circuited to 'idle' whenever there was no
  // session, and a failed connect never has one — so 'error' was unreachable.
  // The tree derives its red icon and the `database.error` context value from
  // this, so a failed connect left the row showing the plain idle circle with
  // no lasting sign anything had gone wrong.
  const { mgr } = withManager(t);
  const cfg = makeConfig();
  await assert.rejects(() => mgr.connect(cfg, SECRETS), NOT_ACTIVATED);

  assert.equal(mgr.getStatus(cfg.id), 'error');
  // Other configs are unaffected.
  assert.equal(mgr.getStatus('some-other-config'), 'idle');
});

test('DittoManager: a failed connect releases the working-directory lock', async t => {
  // The SDK holds an OS advisory lock while open. If the catch does not close
  // the partial instance, every later attempt fails with "File already locked"
  // and the only fix the user has is restarting VS Code.
  const { mgr, dir } = withManager(t);
  const cfg = makeConfig();
  await assert.rejects(() => mgr.connect(cfg, SECRETS), NOT_ACTIVATED);

  // Prove it by opening the same directory directly: this throws if the lock
  // is still held.
  const persistence = path.join(dir, 'dittoData', cfg.id);
  const probe = await Ditto.open(new DittoConfig(
    cfg.databaseId, { mode: 'smallPeersOnly', privateKey: null }, persistence,
  ));
  await probe.close();
});

test('DittoManager: repeated failed connects stay recoverable', async t => {
  // Each attempt must clean up after itself, or attempt N+1 fails for a
  // different reason than attempt N and the user is stuck.
  const { mgr } = withManager(t);
  const cfg = makeConfig();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => mgr.connect(cfg, SECRETS), NOT_ACTIVATED);
  }
  assert.equal(mgr.getActiveConfigId(), null);
  assert.equal(mgr.getStatus(cfg.id), 'error');
});

test('DittoManager: a failed connect logs the failure', async t => {
  const { mgr, errors } = withManager(t);
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  assert.ok(errors.includes('Connect failed'), `saw ${JSON.stringify(errors)}`);
});

test('DittoManager: a malformed databaseId fails before opening anything', async t => {
  const { mgr } = withManager(t);
  await assert.rejects(() => mgr.connect(makeConfig({ databaseId: 'not-a-uuid' }), SECRETS));
  assert.equal(mgr.getActiveConfigId(), null);
  assert.equal(mgr.getCurrentLifecycleState().kind, 'error');
});

// ─── Per-connection persistence ────────────────────────────────

test('DittoManager: each config gets its own persistence directory', async t => {
  // Two connections sharing a working directory would fight over the SDK lock.
  const { mgr, dir } = withManager(t);
  const a = makeConfig();
  const b = makeConfig();
  await assert.rejects(() => mgr.connect(a, SECRETS), NOT_ACTIVATED);
  await assert.rejects(() => mgr.connect(b, SECRETS), NOT_ACTIVATED);

  assert.ok(fs.existsSync(path.join(dir, 'dittoData', a.id)), 'A has its own directory');
  assert.ok(fs.existsSync(path.join(dir, 'dittoData', b.id)), 'B has its own directory');
  assert.notEqual(a.id, b.id);
});

test('DittoManager: the persistence directory is created if missing', async t => {
  const { mgr, dir } = withManager(t);
  // globalStorage may not exist yet on a first run.
  fs.rmSync(dir, { recursive: true, force: true });
  const cfg = makeConfig();
  await assert.rejects(() => mgr.connect(cfg, SECRETS), NOT_ACTIVATED);
  assert.ok(fs.existsSync(path.join(dir, 'dittoData', cfg.id)));
});

// ─── The working-directory lock, held by someone else ───────────

test('DittoManager: a directory locked elsewhere is translated into advice', async t => {
  // The two-VS-Code-windows case. The SDK's own message is terse and does not
  // tell the user what to do, so DittoManager rewrites it; if that translation
  // breaks, the user sees an unactionable error on a very common mistake.
  const { mgr, dir } = withManager(t);
  const cfg = makeConfig();
  const persistence = path.join(dir, 'dittoData', cfg.id);
  fs.mkdirSync(persistence, { recursive: true });

  // Hold the lock the way another window would.
  const holder = await Ditto.open(new DittoConfig(
    cfg.databaseId, { mode: 'smallPeersOnly', privateKey: null }, persistence,
  ));
  t.after(async () => { try { await holder.close(); } catch { /* ignore */ } });

  await assert.rejects(
    () => mgr.connect(cfg, SECRETS),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /locked by another process/, `unhelpful message: ${msg}`);
      assert.match(msg, /Another VS Code window/, 'should name the likely cause');
      assert.match(msg, /restart VS Code/, 'should say what to do');
      return true;
    },
  );
});

// ─── Guards that must refuse work without a session ────────────

test('DittoManager: query paths reject cleanly with no active database', async t => {
  const { mgr } = withManager(t);
  await assert.rejects(() => mgr.executeRaw('SELECT * FROM foo'), /No active database/);
  await assert.rejects(() => mgr.executeQuery('SELECT * FROM foo'), /No active database/);
  await assert.rejects(() => mgr.cborBytesForCollection('`foo`'), /No active database/);
});

test('DittoManager: applyTransportConfig refuses without a session and clears its flag', async t => {
  // A stuck `applyingTransports` flag permanently blocks connect, disconnect
  // and the sync toggle — every guard in extension.ts consults it.
  const { mgr } = withManager(t);
  await assert.rejects(
    () => mgr.applyTransportConfig({
      isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false,
    }),
    /No active database/,
  );
  assert.equal(mgr.isApplyingTransports(), false);
});

test('DittoManager: applyTransportConfig stays unblocked after a failed connect', async t => {
  const { mgr } = withManager(t);
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  assert.equal(mgr.isApplyingTransports(), false, 'a failed connect must not strand the flag');
  assert.equal(mgr.isSwitchInProgress(), false, 'nor the switch flag');
});

test('DittoManager: disconnect with no session is a no-op, not an error', async t => {
  const { mgr, errors } = withManager(t);
  await mgr.disconnect();
  await mgr.disconnect();
  assert.deepEqual(mgr.getCurrentLifecycleState(), { kind: 'idle' });
  assert.deepEqual(errors, []);
});

test('DittoManager: disconnect after a failed connect leaves a clean idle state', async t => {
  const { mgr } = withManager(t);
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  await mgr.disconnect();
  assert.equal(mgr.getActiveConfigId(), null);
  assert.equal(mgr.isApplyingTransports(), false);
});

// ─── Initial state ─────────────────────────────────────────────

test('DittoManager: starts idle with nothing held', async t => {
  const { mgr } = withManager(t);
  assert.deepEqual(mgr.getCurrentLifecycleState(), { kind: 'idle' });
  assert.equal(mgr.getActiveConfigId(), null);
  assert.equal(mgr.getStatus('anything'), 'idle');
  assert.equal(mgr.isSwitchInProgress(), false);
  assert.equal(mgr.isApplyingTransports(), false);
  assert.deepEqual(mgr.getLatestSnapshot().remote, []);
});

// ─── Listeners ─────────────────────────────────────────────────

test('DittoManager: lifecycle listeners observe connecting then error', async t => {
  const { mgr } = withManager(t);
  const kinds: string[] = [];
  const sub = mgr.onLifecycleStateChange(() => {
    kinds.push(mgr.getCurrentLifecycleState().kind);
  });
  t.after(() => sub.dispose());

  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);

  assert.ok(kinds.includes('connecting'), `saw ${JSON.stringify(kinds)}`);
  assert.equal(kinds[kinds.length - 1], 'error', 'settles on error');
});

test('DittoManager: status listeners see activating before the failure', async t => {
  const { mgr } = withManager(t);
  const seen: string[] = [];
  const sub = mgr.onStatusChange((s) => { seen.push(s); });
  t.after(() => sub.dispose());

  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);

  assert.ok(seen.includes('activating'), `saw ${JSON.stringify(seen)}`);
  assert.equal(seen[seen.length - 1], 'error');
});

test('DittoManager: a disposed listener stops firing', async t => {
  const { mgr } = withManager(t);
  let calls = 0;
  const sub = mgr.onStatusChange(() => { calls += 1; });
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  assert.ok(calls > 0, 'fired while subscribed');

  const atDispose = calls;
  sub.dispose();
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  assert.equal(calls, atDispose, 'a disposed listener must not fire again');
});

test('DittoManager: listeners that throw do not break the connect path', async t => {
  // A misbehaving consumer (a panel mid-disposal, say) must not turn a
  // recoverable connect failure into a different, confusing one.
  const { mgr } = withManager(t);
  const sub = mgr.onStatusChange(() => { throw new Error('listener exploded'); });
  t.after(() => sub.dispose());
  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS), NOT_ACTIVATED);
  assert.equal(mgr.getCurrentLifecycleState().kind, 'error', 'still reached the expected state');
});

// ─── Subscription registration is deferred past sync.start ─────

test('DittoManager: initial subscriptions are not registered when connect fails', async t => {
  // They are registered after sync starts, so a failed connect must not leave
  // handles behind on an instance that is about to be closed.
  const { mgr, warns } = withManager(t);
  const subs = [
    { id: 's1', databaseId: 'cfg', name: 'things', query: 'SELECT * FROM things' },
  ] as unknown as StoredSubscription[];

  await assert.rejects(() => mgr.connect(makeConfig(), SECRETS, subs), NOT_ACTIVATED);

  assert.deepEqual(
    warns.filter(w => w.includes('Subscription register failed')), [],
    'no half-registered subscriptions',
  );
});
