import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceLifecycle, type LifecycleState } from '../ditto/lifecycle-state.js';

test('reduceLifecycle: idle + connectStart → connecting', () => {
  const next = reduceLifecycle({ kind: 'idle' }, { type: 'connectStart', configId: 'A' });
  assert.deepEqual(next, { kind: 'connecting', targetConfigId: 'A' });
});

test('reduceLifecycle: connecting + connectOk → active', () => {
  const next = reduceLifecycle({ kind: 'connecting', targetConfigId: 'A' }, { type: 'connectOk' });
  assert.deepEqual(next, { kind: 'active', configId: 'A' });
});

test('reduceLifecycle: active(A) + switchStart(B) → switching', () => {
  const next = reduceLifecycle({ kind: 'active', configId: 'A' }, { type: 'switchStart', toConfigId: 'B' });
  assert.deepEqual(next, { kind: 'switching', fromConfigId: 'A', toConfigId: 'B' });
});

test('reduceLifecycle: switching + disconnectOk → connecting(target)', () => {
  const next = reduceLifecycle({ kind: 'switching', fromConfigId: 'A', toConfigId: 'B' }, { type: 'disconnectOk' });
  assert.deepEqual(next, { kind: 'connecting', targetConfigId: 'B' });
});

test('reduceLifecycle: connecting + connectFail → error', () => {
  const next = reduceLifecycle({ kind: 'connecting', targetConfigId: 'B' }, { type: 'connectFail', message: 'bad token' });
  assert.deepEqual(next, { kind: 'error', lastError: 'bad token' });
});

test('reduceLifecycle: switching/disconnecting/connecting reject duplicate connect — bail action returns same state', () => {
  const cur: LifecycleState = { kind: 'switching', fromConfigId: 'A', toConfigId: 'B' };
  const next = reduceLifecycle(cur, { type: 'connectStart', configId: 'C' });
  assert.deepEqual(next, cur);            // unchanged
});
