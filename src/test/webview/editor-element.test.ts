import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

const posted: unknown[] = [];
(globalThis as any).acquireVsCodeApi = () => ({
  postMessage(message: unknown) { posted.push(message); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/editor/editor-element.js');

function config(advancedConfig?: unknown) {
  return {
    id: 'cfg-1',
    name: 'Demo',
    databaseId: 'db-1',
    mode: 'server',
    authUrl: 'https://example.test',
    httpApiUrl: '',
    allowUntrustedCerts: false,
    logLevel: 'info',
    isStrictModeEnabled: false,
    advancedConfig,
  };
}

async function mount(advancedConfig?: unknown): Promise<any> {
  posted.length = 0;
  const el = document.createElement('ditto-database-editor') as any;
  document.body.appendChild(el);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'editor.init', config: config(advancedConfig), secrets: { token: 'token' } },
  }));
  await el.updateComplete;
  return el;
}

test('DatabaseEditor: legacy config renders a collapsed empty advanced section', async () => {
  const el = await mount();
  const details = el.shadowRoot.querySelector('details.advanced') as HTMLDetailsElement;
  assert.equal(details.open, false);
  assert.match(details.textContent, /0 scopes/);
  assert.match(details.textContent, /Developer Options/);
  el.remove();
});

test('DatabaseEditor: adds, updates, and removes arbitrary scope rows', async () => {
  const el = await mount({ collectionSyncScopes: [] });
  el.shadowRoot.querySelector('.add-scope').click();
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelectorAll('.scope-row').length, 1);
  assert.equal(el.shadowRoot.querySelector('details.advanced').open, true);

  const input = el.shadowRoot.querySelector('.scope-row input') as HTMLInputElement;
  input.value = 'orders';
  input.dispatchEvent(new window.Event('input'));
  const select = el.shadowRoot.querySelector('.scope-row select') as HTMLSelectElement;
  select.value = 'SmallPeersOnly';
  select.dispatchEvent(new window.Event('change'));
  await el.updateComplete;

  el.shadowRoot.querySelector('.scope-remove').click();
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelectorAll('.scope-row').length, 0);
  el.remove();
});

test('DatabaseEditor: posts configured scopes in the save payload', async () => {
  const el = await mount({
    collectionSyncScopes: [{ collection: 'orders', scope: 'SmallPeersOnly' }],
  });
  el.shadowRoot.querySelector('.save').click();
  assert.equal(posted.length, 1);
  assert.deepEqual((posted[0] as any).config.advancedConfig.collectionSyncScopes, [
    { collection: 'orders', scope: 'SmallPeersOnly' },
  ]);
  el.remove();
});

test('DatabaseEditor: invalid system collections disable save and show an error', async () => {
  const el = await mount({
    collectionSyncScopes: [{ collection: '__sync_status', scope: 'LocalPeerOnly' }],
  });
  assert.equal(el.shadowRoot.querySelector('.save').disabled, true);
  el.advancedOpen = true;
  await el.updateComplete;
  assert.match(el.shadowRoot.querySelector('.scope-error').textContent, /System collections/);
  el.remove();
});
