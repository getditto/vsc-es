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

async function mount(advancedConfig?: unknown, isActiveConnection = false): Promise<any> {
  posted.length = 0;
  const el = document.createElement('ditto-database-editor') as any;
  document.body.appendChild(el);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'editor.init', config: config(advancedConfig), secrets: { token: 'token' }, isActiveConnection },
  }));
  await el.updateComplete;
  return el;
}

test('DatabaseEditor: initialization failures replace Loading with a closable error', async () => {
  posted.length = 0;
  const el = document.createElement('ditto-database-editor') as any;
  document.body.appendChild(el);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'editor.initError', message: 'Connection credentials could not be loaded.' },
  }));
  await el.updateComplete;
  assert.match(el.shadowRoot.querySelector('[role=alert]').textContent, /credentials could not be loaded/);
  el.shadowRoot.querySelector('.cancel').click();
  assert.equal((posted[0] as any).type, 'editor.cancel');
  el.remove();
});

test('DatabaseEditor: legacy config renders a collapsed empty advanced section', async () => {
  const el = await mount();
  const details = el.shadowRoot.querySelector('details.advanced') as HTMLDetailsElement;
  assert.equal(details.open, false);
  assert.match(details.textContent, /0 scopes · 0 startup settings/);
  assert.match(details.textContent, /Developer Options/);
  el.remove();
});

test('DatabaseEditor: active setting additions and removals show reconnect warning with counts', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'OLD_SETTING', type: 'integer', value: 1 }],
  }, true);
  el.shadowRoot.querySelector('.setting-remove').click();
  await el.updateComplete;
  let warning = el.shadowRoot.querySelector('.setting-warning');
  assert.match(warning.textContent, /Reconnect required/);
  assert.match(warning.textContent, /1 removed/);

  el.shadowRoot.querySelectorAll('.add-scope')[1].click();
  await el.updateComplete;
  warning = el.shadowRoot.querySelector('.setting-warning');
  assert.match(warning.textContent, /1 added/);
  assert.match(warning.textContent, /1 removed/);
  el.remove();
});

test('DatabaseEditor: reconnect warning disappears when active edits are reverted', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'LIMIT', type: 'integer', value: 1 }],
  }, true);
  const input = el.shadowRoot.querySelector('.setting-row input[type=number]') as HTMLInputElement;
  input.value = '2';
  input.dispatchEvent(new window.Event('input'));
  await el.updateComplete;
  assert.ok(el.shadowRoot.querySelector('.setting-warning'));
  input.value = '1';
  input.dispatchEvent(new window.Event('input'));
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.setting-warning'), null);
  el.remove();
});

test('DatabaseEditor: JSON object key reordering does not require reconnect', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'DIRECTIVES', type: 'json', value: { first: 1, second: 2 } }],
  }, true);
  const textarea = el.shadowRoot.querySelector('.setting-row textarea') as HTMLTextAreaElement;
  textarea.value = '{"second":2,"first":1}';
  textarea.dispatchEvent(new window.Event('input'));
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.setting-warning'), null);
  el.remove();
});

test('DatabaseEditor: legacy parameter casing does not require reconnect', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'max_query_time', type: 'integer', value: 30 }],
  }, true);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'editor.systemSettingsLoaded',
      options: [{ parameter: 'MAX_QUERY_TIME', type: 'integer', value: 30 }],
    },
  }));
  await el.updateComplete;
  const parameter = el.shadowRoot.querySelector('.setting-row select') as HTMLSelectElement;
  parameter.value = 'MAX_QUERY_TIME';
  parameter.dispatchEvent(new window.Event('change'));
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.setting-warning'), null);
  el.remove();
});

test('DatabaseEditor: disconnected setting changes do not show reconnect warning', async () => {
  const el = await mount({ collectionSyncScopes: [], systemSettings: [] });
  el.shadowRoot.querySelectorAll('.add-scope')[1].click();
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.setting-warning'), null);
  el.remove();
});

test('DatabaseEditor: reconnect warning follows host active-connection updates', async () => {
  const el = await mount({ collectionSyncScopes: [], systemSettings: [] }, true);
  el.shadowRoot.querySelectorAll('.add-scope')[1].click();
  await el.updateComplete;
  assert.ok(el.shadowRoot.querySelector('.setting-warning'));
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { type: 'editor.activeConnectionChanged', isActiveConnection: false },
  }));
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('.setting-warning'), null);
  el.remove();
});

test('DatabaseEditor: active SHOW options populate parameter and inferred type', async () => {
  const el = await mount({ collectionSyncScopes: [], systemSettings: [] }, true);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'editor.systemSettingsLoaded',
      options: [{ parameter: 'MAX_QUERY_TIME', type: 'integer', value: 30 }],
    },
  }));
  await el.updateComplete;
  el.shadowRoot.querySelectorAll('.add-scope')[1].click();
  await el.updateComplete;
  const row = el.shadowRoot.querySelector('.setting-row');
  assert.equal(row.querySelector('select').value, 'MAX_QUERY_TIME');
  assert.equal(row.querySelector('select[id^=setting-type]').value, 'integer');
  assert.equal(row.querySelector('input[type=number]').value, '30');
  el.remove();
});

test('DatabaseEditor: posts typed startup settings in the save payload', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'MAX_QUERY_TIME', type: 'integer', value: 20 }],
  });
  el.shadowRoot.querySelector('.save').click();
  assert.deepEqual((posted[0] as any).config.advancedConfig.systemSettings, [
    { parameter: 'MAX_QUERY_TIME', type: 'integer', value: 20 },
  ]);
  el.remove();
});

test('DatabaseEditor: save is single-flight in the webview', async () => {
  const el = await mount({ collectionSyncScopes: [], systemSettings: [] });
  const save = el.shadowRoot.querySelector('.save') as HTMLButtonElement;
  save.click();
  save.click();
  await el.updateComplete;
  assert.equal(posted.filter(message => (message as any).type === 'editor.save').length, 1);
  assert.equal(save.disabled, true);
  assert.equal(save.textContent, 'Saving…');
  assert.equal(el.shadowRoot.querySelector('.cancel').disabled, true);
  el.remove();
});

test('DatabaseEditor: invalid JSON remains visible and disables save', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'DIRECTIVES', type: 'json', value: {} }],
  });
  el.advancedOpen = true;
  await el.updateComplete;
  const textarea = el.shadowRoot.querySelector('.setting-row textarea') as HTMLTextAreaElement;
  textarea.value = '{broken';
  textarea.dispatchEvent(new window.Event('input'));
  await el.updateComplete;
  assert.equal(textarea.value, '{broken');
  assert.equal(el.shadowRoot.querySelector('.save').disabled, true);
  assert.match(el.shadowRoot.querySelector('.setting-error').textContent, /valid JSON/);
  el.remove();
});

test('DatabaseEditor: an empty integer remains visible and disables save instead of becoming zero', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'LIMIT', type: 'integer', value: 20 }],
  });
  const input = el.shadowRoot.querySelector('.setting-row input[type=number]') as HTMLInputElement;
  input.value = '';
  input.dispatchEvent(new window.Event('input'));
  await el.updateComplete;
  assert.equal(input.value, '');
  assert.equal(el.shadowRoot.querySelector('.save').disabled, true);
  assert.match(el.shadowRoot.querySelector('.setting-error').textContent, /safe integer/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'setting-error');
  el.remove();
});

test('DatabaseEditor: parameter validation identifies the invalid control', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: '', type: 'string', value: '' }],
  });
  const input = el.shadowRoot.querySelector('.setting-row input[type=text]') as HTMLInputElement;
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'setting-error');
  assert.equal(el.shadowRoot.querySelector('#setting-error').getAttribute('role'), 'alert');
  el.remove();
});

test('DatabaseEditor: selecting a discovered non-JSON setting clears an obsolete JSON draft', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [{ parameter: 'DIRECTIVES', type: 'json', value: {} }],
  }, true);
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'editor.systemSettingsLoaded',
      options: [
        { parameter: 'DIRECTIVES', type: 'json', value: {} },
        { parameter: 'MAX_QUERY_TIME', type: 'integer', value: 30 },
      ],
    },
  }));
  await el.updateComplete;
  const textarea = el.shadowRoot.querySelector('.setting-row textarea') as HTMLTextAreaElement;
  textarea.value = '{broken';
  textarea.dispatchEvent(new window.Event('input'));
  await el.updateComplete;

  const parameter = el.shadowRoot.querySelector('.setting-row select') as HTMLSelectElement;
  parameter.value = 'MAX_QUERY_TIME';
  parameter.dispatchEvent(new window.Event('change'));
  await el.updateComplete;

  assert.equal(el.shadowRoot.querySelector('.setting-error'), null);
  assert.equal(el.shadowRoot.querySelector('.save').disabled, false);
  assert.equal(el.shadowRoot.querySelector('.setting-row input[type=number]').value, '30');
  el.remove();
});

test('DatabaseEditor: removing a row preserves and reindexes another row JSON draft', async () => {
  const el = await mount({
    collectionSyncScopes: [],
    systemSettings: [
      { parameter: 'LABEL', type: 'string', value: 'keep' },
      { parameter: 'DIRECTIVES', type: 'json', value: {} },
    ],
  });
  const textarea = el.shadowRoot.querySelector('.setting-row textarea') as HTMLTextAreaElement;
  textarea.value = '{in progress';
  textarea.dispatchEvent(new window.Event('input'));
  await el.updateComplete;

  el.shadowRoot.querySelector('.setting-remove').click();
  await el.updateComplete;

  assert.equal(el.shadowRoot.querySelector('.setting-row textarea').value, '{in progress');
  assert.equal(el.shadowRoot.querySelector('.save').disabled, true);
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
  const error = el.shadowRoot.querySelector('.scope-error');
  assert.match(error.textContent, /System collections/);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(el.shadowRoot.querySelector('.scope-row input').getAttribute('aria-invalid'), 'true');
  el.remove();
});

test('DatabaseEditor: exposes an unknown persisted scope instead of visually defaulting it', async () => {
  const el = await mount({
    collectionSyncScopes: [{ collection: 'orders', scope: 'Unknown' }],
  });
  assert.equal(el.shadowRoot.querySelector('details.advanced').open, true);
  assert.equal(el.shadowRoot.querySelector('.save').disabled, true);
  const select = el.shadowRoot.querySelector('.scope-row select');
  assert.equal(select.value, 'Unknown');
  assert.match(select.selectedOptions[0].textContent, /Unsupported scope/);
  assert.equal(select.getAttribute('aria-invalid'), 'true');
  el.remove();
});

test('DatabaseEditor: host advanced validation errors expand the section and announce', async () => {
  const el = await mount({ collectionSyncScopes: [] });
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'editor.validationError',
      message: 'Advanced configuration is invalid.',
      field: 'advancedConfig',
    },
  }));
  await el.updateComplete;
  assert.equal(el.shadowRoot.querySelector('details.advanced').open, true);
  assert.equal(el.shadowRoot.querySelector('.error-banner').getAttribute('role'), 'alert');
  el.remove();
});
