import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSdkLogBridge } from '../logging/sdk-bridge.js';
import type { Logger } from '../logging/types.js';

/**
 * A fake `@dittolive/ditto` Logger module that mirrors the real SDK's shape:
 * `customLogCallback` is exposed as a *getter only* — any attempt to assign
 * to it (`fake.customLogCallback = …`) throws TypeError in strict mode.
 * `setCustomLogCallback(cb)` is the only legal way to install the callback.
 */
function fakeDittoLoggerWithGetterOnlyStatic() {
  let installed: ((level: string, message: string) => void) | undefined;
  const fake: any = {
    setCustomLogCallback(cb?: (level: string, message: string) => void) {
      installed = cb;
    },
    /** Test-only handle to invoke whatever was last installed. */
    _emit(level: string, message: string) { installed?.(level, message); },
  };
  Object.defineProperty(fake, 'customLogCallback', {
    get() { return installed; },
    // Intentionally NO setter. With strict mode (which esbuild emits and
    // node:test runs under for ES modules), any assignment throws TypeError.
    configurable: false,
  });
  return fake;
}

function fakeHostLogger(): Logger & { _captured: { level: string; msg: string }[] } {
  const captured: { level: string; msg: string }[] = [];
  const make = (level: string) => (m: string) => { captured.push({ level, msg: m }); };
  const noop = () => { /* no-op */ };
  return {
    error: make('error'), warn: make('warn'), info: make('info'),
    debug: make('debug'), trace: make('trace'),
    setChannelLevel: noop, getChannelLevel: () => 'info',
    onDidChangeChannelLevel: () => ({ dispose() {} }) as any,
    setSdkLevel: noop, getSdkLevel: () => 'info',
    onDidChangeSdkLevel: () => ({ dispose() {} }) as any,
    withTag: function withTag() { return this; },
    readAllLogs: async () => '',
    dispose: async () => { /* no-op */ },
    _captured: captured,
  } as any;
}

test('attachSdkLogBridge: installs callback via setCustomLogCallback (not direct assignment)', () => {
  const sdk = fakeDittoLoggerWithGetterOnlyStatic();
  const host = fakeHostLogger();

  // Regression guard: if someone reverts to `dittoLogger.customLogCallback = …`,
  // the assignment hits the no-setter property and throws TypeError. Verifying
  // that this call does NOT throw locks in the contract.
  assert.doesNotThrow(() => attachSdkLogBridge(sdk, host));

  // And the install actually happened via the setter.
  assert.equal(typeof sdk.customLogCallback, 'function');
});

test('attachSdkLogBridge: maps SDK level names to host level names', () => {
  const sdk = fakeDittoLoggerWithGetterOnlyStatic();
  const host = fakeHostLogger();

  attachSdkLogBridge(sdk, host);

  sdk._emit('Error', 'e');
  sdk._emit('Warning', 'w');
  sdk._emit('Info', 'i');
  sdk._emit('Debug', 'd');
  sdk._emit('Verbose', 'v');

  assert.deepEqual(host._captured, [
    { level: 'error', msg: 'e' },
    { level: 'warn',  msg: 'w' },
    { level: 'info',  msg: 'i' },
    { level: 'debug', msg: 'd' },
    { level: 'trace', msg: 'v' },
  ]);
});

test('attachSdkLogBridge: unknown SDK level falls back to info', () => {
  const sdk = fakeDittoLoggerWithGetterOnlyStatic();
  const host = fakeHostLogger();

  attachSdkLogBridge(sdk, host);
  sdk._emit('Mystery', 'unknown level');

  assert.deepEqual(host._captured, [{ level: 'info', msg: 'unknown level' }]);
});

test('regression: direct assignment to customLogCallback throws (proves the fake mirrors the SDK)', () => {
  const sdk = fakeDittoLoggerWithGetterOnlyStatic();
  // This is the bug we shipped: assigning to the getter-only static.
  // The fake faithfully reproduces that failure mode under strict mode,
  // which is what makes the test above (`does not throw`) load-bearing.
  assert.throws(
    () => { 'use strict'; (sdk).customLogCallback = () => {}; },
    /TypeError/,
  );
});
