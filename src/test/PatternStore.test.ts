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
    logger: { warn: () => {}, error: () => {} },
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

test('PatternStore: non-object entries in the user file are skipped with a warn', async () => {
  // Without validation `{key, ...p}` spreads garbage into the store: a string
  // entry becomes `{key, 0: 's', 1: 't', …}` and a null entry throws on
  // spread-of-null paths downstream. Valid entries must survive.
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'user_patterns.json'), JSON.stringify({
    good: { pattern: 'boom', severity: 4, recommendation: 'r' },
    a_string: 'not an object',
    a_number: 42,
    a_null: null,
    an_array: ['x'],
  }));
  const warnings: string[] = [];
  const store = new PatternStore({
    bundledPath: path.resolve(import.meta.dirname, '../logAnalyzer/patterns/problem_patterns.json'),
    resolveUserPath: () => path.join(dir, 'user_patterns.json'),
    logger: { warn: (m: string) => { warnings.push(m); }, error: () => {} },
  });
  await store.load();

  const user = store.listAll().user;
  assert.deepEqual(user.map(p => p.key), ['good'], 'only the object-valued entry is loaded');
  assert.equal(user[0].pattern, 'boom');
  assert.equal(warnings.length, 4, 'each malformed entry warned');
  assert.ok(warnings.every(w => w.includes('skipping malformed entry')));
});

test('PatternStore: a non-object user document is ignored with a warn, bundled OK', async () => {
  const dir = await tmpdir();
  await fs.writeFile(path.join(dir, 'user_patterns.json'), '["not", "an", "object"]');
  const warnings: string[] = [];
  const store = new PatternStore({
    bundledPath: path.resolve(import.meta.dirname, '../logAnalyzer/patterns/problem_patterns.json'),
    resolveUserPath: () => path.join(dir, 'user_patterns.json'),
    logger: { warn: (m: string) => { warnings.push(m); }, error: () => {} },
  });
  await store.load();
  assert.equal(store.listAll().user.length, 0);
  assert.ok(warnings.some(w => w.includes('not an object')));
  assert.ok(store.listAll().bundled.length > 0);
});

test('PatternStore: malformed entries in the bundled file are skipped with a warn', async () => {
  // Same boundary validation guards the bundled file, which is read with the
  // identical parse path.
  const dir = await tmpdir();
  const bundledPath = path.join(dir, 'bundled.json');
  await fs.writeFile(bundledPath, JSON.stringify({
    real: { pattern: 'boom', severity: 4, recommendation: 'r' },
    bogus: 'definitely not a pattern',
  }));
  const warnings: string[] = [];
  const store = new PatternStore({
    bundledPath,
    resolveUserPath: () => path.join(dir, 'user_patterns.json'),
    logger: { warn: (m: string) => { warnings.push(m); }, error: () => {} },
  });
  await store.load();
  assert.deepEqual(store.listAll().bundled.map(p => p.key), ['real']);
  assert.ok(warnings.some(w => w.includes('skipping malformed entry')));
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
