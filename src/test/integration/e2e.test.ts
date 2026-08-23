import * as assert from 'assert';
import * as vscode from 'vscode';
import type { TestApi } from '../../test-api/index.js';

suite('E2E sync', function () {
  this.timeout(60_000);

  let api: TestApi | undefined;

  suiteSetup(async function () {
    if (process.env.DITTO_CI_MODE !== '1') { this.skip(); }
    const ext = vscode.extensions.getExtension<TestApi | undefined>('ditto.ditto-vsce');
    assert.ok(ext);
    api = await ext.activate();
    assert.ok(api, 'extension did not return TestApi when DITTO_CI_MODE=1');
  });

  suiteTeardown(async () => {
    if (api) {
      try { await api.disconnect(); } catch (_) { /* best-effort */ }
    }
  });

  test('connects to CI app and observes presence or sync activity within 30s', async () => {
    assert.ok(api);
    const id = await api.registerFromEnv();
    await api.connect(id);
    await api.waitForPeerOrSyncStatus(30_000);
  });
});
