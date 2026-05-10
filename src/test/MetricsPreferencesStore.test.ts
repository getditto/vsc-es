import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsPreferencesStore } from '../storage/MetricsPreferencesStore.js';

function fakeMemento() {
  const m = new Map<string, unknown>();
  return {
    api: {
      get: (k: string, d?: unknown) => m.has(k) ? m.get(k) : d,
      update: async (k: string, v: unknown) => {
        if (v === undefined) { m.delete(k); } else { m.set(k, v); }
      },
      keys: () => [...m.keys()],
    } as any,
    map: m,
  };
}

test('MetricsPreferencesStore: defaults to hideLimitHint=false', () => {
  const f = fakeMemento();
  const s = new MetricsPreferencesStore(f.api);
  assert.deepEqual(s.get(), { hideLimitHint: false });
});

test('MetricsPreferencesStore: dismissLimitHint flips the flag', async () => {
  const f = fakeMemento();
  const s = new MetricsPreferencesStore(f.api);
  await s.dismissLimitHint();
  assert.equal(s.get().hideLimitHint, true);
});

test('MetricsPreferencesStore: dismissLimitHint is idempotent', async () => {
  const f = fakeMemento();
  const s = new MetricsPreferencesStore(f.api);
  await s.dismissLimitHint();
  await s.dismissLimitHint();
  assert.equal(s.get().hideLimitHint, true);
});

test('MetricsPreferencesStore: resetAll clears the dismissal', async () => {
  const f = fakeMemento();
  const s = new MetricsPreferencesStore(f.api);
  await s.dismissLimitHint();
  await s.resetAll();
  assert.deepEqual(s.get(), { hideLimitHint: false });
});

test('MetricsPreferencesStore: resetAll on never-dismissed state is a no-op', async () => {
  const f = fakeMemento();
  const s = new MetricsPreferencesStore(f.api);
  await s.resetAll();
  assert.deepEqual(s.get(), { hideLimitHint: false });
});
