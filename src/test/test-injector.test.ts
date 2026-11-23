import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('offline injector awaits the SDK query and exits after inserting a document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-test-injector-'));
  try {
    const dataset = join(dir, 'tasks.ndjson');
    await writeFile(dataset, '{"_id":"test","count":1}\n');
    const script = fileURLToPath(new URL('../../scripts/test-injector/injector.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [
      script,
      `--dataset=${dataset}`,
      `--work-dir=${join(dir, 'store')}`,
      '--database-id=00000000-0000-4000-8000-000000000000',
      '--license=',
      '--rate=100',
    ], { timeout: 15_000 });
    assert.match(stdout, /done — pushed=1/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
