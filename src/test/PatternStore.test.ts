import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PatternStore } from '../logAnalyzer/PatternStore.js';

async function tmpdir() { return await fs.mkdtemp(path.join(os.tmpdir(), 'ditto-ps-')); }

function makeStore(opts: { dir: string; pathSetting?: string }) {
  return new PatternStore({
    bundledPath: path.resolve(import.meta.dirname, '../logAnalyzer/patterns/problem_patterns.json'),
    resolveUserPath: () => opts.pathSetting ?? path.join(opts.dir, 'user_patterns.json'),
    logger: { warn: () => {}, error: () => {} } as any,
  });
}

test('PatternStore: listAll returns bundled patterns from disk', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  const { bundled } = store.listAll();
  assert.ok(bundled.find(p => p.key === 'deadlock_critical'));
});

test('PatternStore: add persists user pattern to disk', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  await store.add({
    key: 'my_oom', pattern: 'OOM', severity: 4, recommendation: 'check memory',
  });
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'user_patterns.json'), 'utf8'));
  assert.ok(onDisk.my_oom);
  assert.equal(onDisk.my_oom.severity, 4);
});

test('PatternStore: delete on user key removes it', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  await store.add({ key: 'x', pattern: 'x', severity: 3, recommendation: 'r' });
  await store.delete('x');
  assert.equal(store.listAll().user.find(p => p.key === 'x'), undefined);
});

test('PatternStore: delete on bundled key throws', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  await assert.rejects(() => store.delete('deadlock_critical'), /bundled/i);
});

test('PatternStore: add rejects key that exists in bundled', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  await assert.rejects(
    () => store.add({ key: 'deadlock_critical', pattern: 'x', severity: 3, recommendation: 'r' }),
    /collid/i,
  );
});

test('PatternStore: invalid disk JSON falls back to empty user list, bundled OK', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'user_patterns.json'), '{ this is not json');
  const store = makeStore({ dir });
  await store.load();
  assert.equal(store.listAll().user.length, 0);
  assert.ok(store.listAll().bundled.length > 0);
});

test('PatternStore: update replaces an existing user pattern', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  await store.add({ key: 'x', pattern: 'x', severity: 3, recommendation: 'r' });
  await store.update('x', { key: 'x', pattern: 'y', severity: 4, recommendation: 'r2' });
  const u = store.listAll().user.find(p => p.key === 'x');
  assert.equal(u?.pattern, 'y');
  assert.equal(u?.severity, 4);
});

test('PatternStore: onDidChange fires after add', async () => {
  const dir = await tmpdir();
  const store = makeStore({ dir });
  await store.load();
  let fired = 0;
  store.onDidChange(() => { fired++; });
  await store.add({ key: 'z', pattern: 'z', severity: 3, recommendation: 'r' });
  assert.equal(fired, 1);
});
