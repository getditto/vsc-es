import test from 'node:test';
import assert from 'node:assert/strict';
import { withConnectionPersistenceLock } from '../storage/connection-persistence-lock.js';

test('connection persistence operations run exclusively in arrival order', async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = withConnectionPersistenceLock(async () => {
    events.push('save:start');
    await gate;
    events.push('save:end');
  });
  const second = withConnectionPersistenceLock(async () => {
    events.push('delete:start');
    events.push('delete:end');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['save:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['save:start', 'save:end', 'delete:start', 'delete:end']);
});
