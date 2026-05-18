import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Activation', () => {
  test('extension is present and active', async () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext, 'extension ditto.ditto-vsce should be installed');
    if (!ext!.isActive) { await ext!.activate(); }
    assert.strictEqual(ext!.isActive, true);
  });

  test('Ditto activity bar container is registered', () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext);
    const containers = ext!.packageJSON?.contributes?.viewsContainers?.activitybar as { id: string }[] | undefined;
    assert.ok(Array.isArray(containers), 'activitybar viewsContainers must be an array');
    assert.ok(
      containers!.some(c => c.id === 'dittoVsce'),
      'expected a viewsContainers.activitybar entry with id "dittoVsce"',
    );
  });
});
