import * as assert from 'assert';
import * as vscode from 'vscode';
import { panelHtml } from '../../panels/webview-utils.js';
import { newConfig } from '../../models/DittoConfig.js';
import type { EditorIn } from '../../ipc/messages.js';

suite('Activation', () => {
  test('extension is present and active', async () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext, 'extension ditto.ditto-vsce should be installed');
    if (!ext.isActive) { await ext.activate(); }
    assert.strictEqual(ext.isActive, true);
  });

  test('Ditto activity bar container is registered', () => {
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext);
    const containers = ext.packageJSON?.contributes?.viewsContainers?.activitybar as { id: string }[] | undefined;
    assert.ok(Array.isArray(containers), 'activitybar viewsContainers must be an array');
    assert.ok(
      containers.some(c => c.id === 'dittoVsce'),
      'expected a viewsContainers.activitybar entry with id "dittoVsce"',
    );
  });

  test('Register Database command opens its panel', async () => {
    await vscode.commands.executeCommand('dittoVsce.registerDatabase');
    let tab: vscode.Tab | undefined;
    for (let attempt = 0; attempt < 100 && !tab; attempt++) {
      tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .find(candidate => candidate.label === 'Register Database');
      if (!tab) { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(tab, 'registration command must open the database editor');
    await vscode.window.tabGroups.close(tab);
  });

  test('bundled database editor receives real host messages and submits the form', async function () {
    this.timeout(20_000);
    const ext = vscode.extensions.getExtension('ditto.ditto-vsce');
    assert.ok(ext);
    const assets = vscode.Uri.joinPath(ext.extensionUri, 'dist', 'webview-ui');
    const panel = vscode.window.createWebviewPanel('dittoRegistrationTest', 'Registration smoke test',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
    const config = { ...newConfig(), id: 'registration-smoke', name: 'Before edit',
      databaseId: '00000000-0000-4000-8000-000000000000', authUrl: 'https://example.test' };
    const scaffold = panelHtml({ title: 'Registration smoke test',
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(assets, 'editor.js')),
      cspSource: panel.webview.cspSource });
    const nonce = /<script nonce="([^"]+)"/.exec(scaffold)?.[1];
    assert.ok(nonce);
    let sendTimer: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let listener: vscode.Disposable | undefined;
    try {
      const saved = new Promise<EditorIn>((resolve, reject) => {
        listener = panel.webview.onDidReceiveMessage((msg: EditorIn) => {
          if (msg.type === 'editor.save') { resolve(msg); }
        });
        timeout = setTimeout(() => reject(new Error('Bundled editor never rendered/submitted after editor.init')), 15_000);
      });
      // Drive the actual bundled form inside Electron. No synthetic message
      // events or window.parent shim: VS Code owns the transport and origin.
      panel.webview.html = scaffold.replace('</body>', `<script nonce="${nonce}">
        const probe = setInterval(async () => {
          const editor = document.querySelector('ditto-database-editor');
          const name = editor?.shadowRoot?.querySelector('#connection-name');
          if (!name) { return; }
          clearInterval(probe);
          name.value = 'Registration smoke test';
          name.dispatchEvent(new Event('input'));
          await editor.updateComplete;
          editor.shadowRoot.querySelector('.save').click();
        }, 25);
      </script></body>`);
      // Retry only in the test harness until the webview has loaded. The
      // production editor's startup timing is covered separately on the host.
      // Keep it visible if the first-run Welcome panel opens during the test.
      sendTimer = setInterval(() => {
        panel.reveal();
        void panel.webview.postMessage({ type: 'editor.init', config,
          secrets: { token: 'test-only-placeholder' }, isActiveConnection: false });
      }, 100);
      const message = await saved;
      assert.strictEqual(message.type, 'editor.save');
      if (message.type === 'editor.save') {
        assert.strictEqual(message.config.id, config.id);
        assert.strictEqual(message.config.name, 'Registration smoke test');
        assert.strictEqual(message.secrets.token, 'test-only-placeholder');
      }
    } finally {
      clearInterval(sendTimer);
      clearTimeout(timeout);
      listener?.dispose();
      panel.dispose();
    }
  });
});
