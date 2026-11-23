import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import './setup.js';

/** The api must exist before the element module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
const posted: Array<Record<string, unknown>> = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(message: Record<string, unknown>) { posted.push(message); },
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/editor/editor-element.js');

/**
 * Behavior coverage beyond editor-element.test.ts (which owns the reconnect
 * warning, draft-preservation, and scope-row lifecycle): mode switching and
 * the mode-conditional sections, basic field editing into the save payload,
 * the isValid gates, the save() validation short-circuit, malformed persisted
 * advanced config, every systemSettingsError branch, the JSON-value guards,
 * type changes, option selection fallbacks, and host-message resets.
 */

type El = HTMLElement & Record<string, any> & { updateComplete: Promise<unknown> };

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

async function mount(
  t: { after(fn: () => void): void },
  configOverrides: Record<string, unknown> = {},
  opts: { isNewConnection?: boolean; isActiveConnection?: boolean; secrets?: Record<string, unknown> } = {},
): Promise<El> {
  posted.length = 0;
  const el = document.createElement('ditto-database-editor') as El;
  document.body.appendChild(el);
  t.after(() => el.remove());
  window.dispatchEvent(new window.MessageEvent('message', {
    data: {
      type: 'editor.init',
      config: baseConfig(configOverrides),
      secrets: { token: 'token', ...opts.secrets },
      isNewConnection: opts.isNewConnection ?? false,
      isActiveConnection: opts.isActiveConnection ?? false,
    },
  }));
  await el.updateComplete;
  return el;
}

function send(data: unknown): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new window.Event('input'));
}

function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new window.Event('change'));
}

function toggle(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked;
  input.dispatchEvent(new window.Event('change'));
}

function q<T extends HTMLElement>(el: El, selector: string): T {
  const found = el.shadowRoot!.querySelector<T>(selector);
  assert.ok(found, `expected ${selector} to exist`);
  return found;
}

function savePayload(): Record<string, unknown> {
  const msg = posted.find(m => m.type === 'editor.save');
  assert.ok(msg, 'an editor.save message was posted');
  return msg;
}

test('local encryption is off by default and can be enabled under Advanced with an automatic key', async t => {
  const el = await mount(t, {}, { isNewConnection: true });
  const advanced = q<HTMLDetailsElement>(el, 'details.advanced');
  const checkbox = q<HTMLInputElement>(el, '#cb-encrypt-local-store');
  assert.equal(advanced.open, false);
  assert.equal(checkbox.closest('details'), advanced);
  assert.equal(checkbox.checked, false);
  assert.equal(el.shadowRoot!.querySelector('#local-encryption-key'), null);
  toggle(checkbox, true);
  await el.updateComplete;
  assert.equal(q<HTMLInputElement>(el, '#local-encryption-key').type, 'password');
  q<HTMLButtonElement>(el, '.save').click();
  assert.equal((savePayload().config as Record<string, unknown>).encryptLocalStore, true);
  assert.equal('encryptionKey' in savePayload(), false);
});

test('registration posts the key separately, reopens Advanced on error, and clears the draft when unchecked', async t => {
  const el = await mount(t, {}, { isNewConnection: true });
  const checkbox = q<HTMLInputElement>(el, '#cb-encrypt-local-store');
  toggle(checkbox, true);
  await el.updateComplete;
  const key = randomBytes(32).toString('base64');
  type(q<HTMLInputElement>(el, '#local-encryption-key'), key);
  q<HTMLButtonElement>(el, '.save').click();
  const save = savePayload();
  assert.equal(save.encryptionKey, key);
  assert.equal('encryptionKey' in (save.config as Record<string, unknown>), false);
  assert.equal('encryptionKey' in (save.secrets as Record<string, unknown>), false);

  send({ type: 'editor.validationError', field: 'encryptionKey', message: 'Enter a 32-byte key.' });
  await el.updateComplete;
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, true);
  assert.equal(q(el, '#local-encryption-key-error').textContent, 'Enter a 32-byte key.');
  assert.equal(q<HTMLInputElement>(el, '#local-encryption-key').getAttribute('aria-invalid'), 'true');

  toggle(checkbox, false);
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('#local-encryption-key'), null);
  toggle(checkbox, true);
  await el.updateComplete;
  assert.equal(q<HTMLInputElement>(el, '#local-encryption-key').value, '');
  assert.equal(el.shadowRoot!.querySelector('#local-encryption-key-error'), null);
});

test('the encryption checkbox is absent for encrypted and unencrypted edits', async t => {
  const el = await mount(t, { encryptLocalStore: true });
  assert.equal(el.shadowRoot!.querySelector('#cb-encrypt-local-store'), null);
  assert.equal(el.shadowRoot!.querySelector('#local-encryption-key'), null);
  assert.match(q(el, 'details.advanced').textContent, /Local database encryption is enabled/);

  send({
    type: 'editor.init', config: baseConfig(), secrets: { token: 'token' },
    isNewConnection: false, isActiveConnection: false,
  });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('#cb-encrypt-local-store'), null);
  assert.doesNotMatch(el.shadowRoot!.textContent, /Local database encryption is enabled/);
});

function settingError(el: El): string {
  return q(el, '.setting-error').textContent ?? '';
}

test('DatabaseEditor: mode picker swaps the server and small-peers sections', async t => {
  const el = await mount(t);
  q(el, '#auth-url');
  assert.equal(el.shadowRoot!.querySelector('#shared-secret'), null);

  const buttons = [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mode-picker button')];
  assert.equal(buttons.length, 2);
  const serverBtn = buttons[0]!;
  const smallBtn = buttons[1]!;
  assert.equal(serverBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(serverBtn.className, 'active');

  smallBtn.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('#auth-url'), null, 'server sections hidden');
  q(el, '#shared-secret');
  assert.match(el.shadowRoot!.textContent ?? '', /Offline Token/, 'token relabelled');
  assert.match(el.shadowRoot!.textContent ?? '', /portal\.ditto\.live/, 'small-peers help shown');
  assert.equal(smallBtn.getAttribute('aria-pressed'), 'true');

  type(q<HTMLInputElement>(el, '#shared-secret'), 'shared-key');
  await el.updateComplete;

  serverBtn.click();
  await el.updateComplete;
  q(el, '#auth-url');
  assert.equal(el.shadowRoot!.querySelector('#shared-secret'), null);

  q<HTMLElement>(el, '.save').click();
  const msg = savePayload();
  assert.equal((msg.config as Record<string, unknown>).mode, 'server');
  assert.equal((msg.secrets as Record<string, unknown>).secretKey, 'shared-key',
    'secret typed while in small-peers mode survives the round trip');
});

test('DatabaseEditor: basic field edits land in the save payload', async t => {
  const el = await mount(t);
  type(q<HTMLInputElement>(el, '#connection-name'), 'Renamed');
  type(q<HTMLInputElement>(el, '#database-id'), '  db-2  ');
  type(q<HTMLInputElement>(el, '#connection-token'), '  tok-2 ');
  type(q<HTMLInputElement>(el, '#auth-url'), 'https://auth.example.test');
  type(q<HTMLInputElement>(el, '#http-api-url'), 'https://api.example.test');
  type(q<HTMLInputElement>(el, '#http-api-key'), 'api-key');
  toggle(q<HTMLInputElement>(el, '#cb-untrusted'), true);
  pick(q<HTMLSelectElement>(el, '#sdk-log-level'), 'debug');
  toggle(q<HTMLInputElement>(el, '#cb-strict'), true);
  await el.updateComplete;

  q<HTMLElement>(el, '.save').click();
  const msg = savePayload();
  assert.deepEqual(msg.config, {
    id: 'cfg-1',
    name: 'Renamed',
    databaseId: 'db-2',
    mode: 'server',
    authUrl: 'https://auth.example.test',
    httpApiUrl: 'https://api.example.test',
    allowUntrustedCerts: true,
    logLevel: 'debug',
    isStrictModeEnabled: true,
  });
  assert.deepEqual(msg.secrets, { token: 'tok-2', httpApiKey: 'api-key' });
});

test('DatabaseEditor: the Save gate tracks each required field', async t => {
  const el = await mount(t);
  const save = q<HTMLButtonElement>(el, '.save');
  assert.equal(save.disabled, false, 'valid fixture starts enabled');

  const name = q<HTMLInputElement>(el, '#connection-name');
  type(name, '   ');
  await el.updateComplete;
  assert.equal(save.disabled, true, 'blank name disables save');
  type(name, 'Demo');
  await el.updateComplete;
  assert.equal(save.disabled, false);

  const dbId = q<HTMLInputElement>(el, '#database-id');
  type(dbId, '');
  await el.updateComplete;
  assert.equal(save.disabled, true, 'blank database id disables save');
  type(dbId, 'db-1');
  await el.updateComplete;
  assert.equal(save.disabled, false);

  const token = q<HTMLInputElement>(el, '#connection-token');
  type(token, ' ');
  await el.updateComplete;
  assert.equal(save.disabled, true, 'blank token disables save');
  type(token, 'token');
  await el.updateComplete;
  assert.equal(save.disabled, false);

  const authUrl = q<HTMLInputElement>(el, '#auth-url');
  type(authUrl, '');
  await el.updateComplete;
  assert.equal(save.disabled, true, 'server mode requires an auth URL');

  // Small-peers mode does not use the auth URL at all.
  [...el.shadowRoot!.querySelectorAll<HTMLElement>('.mode-picker button')][1]!.click();
  await el.updateComplete;
  assert.equal(save.disabled, false, 'small-peers mode saves without an auth URL');
});

test('DatabaseEditor: save() with an invalid advanced section opens it and posts nothing', async t => {
  const el = await mount(t, {
    advancedConfig: { collectionSyncScopes: [{ collection: '', scope: 'AllPeers' }] },
  });
  // The error disables the button, so drive the method directly — the guard
  // must hold even if a click somehow lands.
  posted.length = 0;
  el.save();
  await el.updateComplete;
  assert.equal(posted.filter(m => m.type === 'editor.save').length, 0);
  assert.match(q(el, '.error-banner').textContent ?? '', /Enter a collection name/);
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, true,
    'the section containing the error is opened');

  // Fix the scope, then save succeeds and the banner clears (setScopes
  // nulls validationError).
  type(q<HTMLInputElement>(el, '.scope-row input'), 'orders');
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.error-banner'), null);
  q<HTMLElement>(el, '.save').click();
  assert.equal(posted.filter(m => m.type === 'editor.save').length, 1);
});

test('DatabaseEditor: save() surfaces a system-settings error the same way', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: '', type: 'string', value: '' }] },
  });
  posted.length = 0;
  el.save();
  await el.updateComplete;
  assert.equal(posted.filter(m => m.type === 'editor.save').length, 0);
  assert.match(q(el, '.error-banner').textContent ?? '', /Enter a parameter name/);
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, true);
});

test('DatabaseEditor: defensive guards no-op before init delivers a config', async t => {
  const el = document.createElement('ditto-database-editor') as El;
  document.body.appendChild(el);
  t.after(() => el.remove());
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Loading…/);

  posted.length = 0;
  el.update_('name', 'x');
  el.setScopes([]);
  el.setSystemSettings([]);
  el.save();
  await el.updateComplete;
  assert.deepEqual(posted, [], 'nothing is posted without a config');
  assert.match(el.shadowRoot!.textContent ?? '', /Loading…/, 'still on the loading screen');
});

test('DatabaseEditor: the details element keeps advancedOpen in sync both ways', async t => {
  const el = await mount(t);
  const details = q<HTMLDetailsElement>(el, 'details.advanced');
  assert.equal(details.open, false);
  assert.equal(el.advancedOpen, false);

  details.open = true;
  details.dispatchEvent(new window.Event('toggle'));
  await el.updateComplete;
  assert.equal(el.advancedOpen, true, 'user expansion is tracked');

  details.open = false;
  details.dispatchEvent(new window.Event('toggle'));
  await el.updateComplete;
  assert.equal(el.advancedOpen, false, 'user collapse is tracked');
});

test('DatabaseEditor: a systemSettings load failure warns without blocking manual entry', async t => {
  const el = await mount(t);
  send({ type: 'editor.systemSettingsLoadError', message: 'SHOW failed' });
  await el.updateComplete;
  assert.match(el.shadowRoot!.textContent ?? '', /Current settings could not be loaded: SHOW failed/);
  assert.match(el.shadowRoot!.textContent ?? '', /still enter a parameter manually/);
});

test('DatabaseEditor: a validation error without a field re-arms save and leaves the section closed', async t => {
  const el = await mount(t);
  const save = q<HTMLButtonElement>(el, '.save');
  save.click();
  await el.updateComplete;
  assert.equal(save.disabled, true, 'save in flight');

  send({ type: 'editor.validationError', message: 'name already in use' });
  await el.updateComplete;
  assert.match(q(el, '.error-banner').textContent ?? '', /name already in use/);
  assert.equal(save.disabled, false, 'saving cleared by the error');
  assert.equal(save.textContent, 'Save');
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, false,
    'no field hint → the advanced section stays closed');
});

test('DatabaseEditor: malformed persisted scopes surface as data, not a crash', async t => {
  const el = await mount(t, {
    advancedConfig: {
      collectionSyncScopes: [null, 42, ['x'], { collection: 7, scope: 9 }],
    },
  });
  // scopeError() tripped during init → section auto-opens.
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, true);
  const rows = el.shadowRoot!.querySelectorAll('.scope-row');
  assert.equal(rows.length, 4, 'every malformed entry still gets a row');
  const firstInput = rows[0]!.querySelector('input')!;
  assert.equal(firstInput.value, '', 'non-object entry normalises to empty strings');
  assert.match(q(el, '.scope-error').textContent ?? '', /Enter a collection name for every scope/);

  const lastSelect = rows[3]!.querySelector('select')!;
  assert.equal(lastSelect.value, '', 'non-string scope is preserved as empty');
});

test('DatabaseEditor: a non-list collectionSyncScopes value is called out', async t => {
  const el = await mount(t, { advancedConfig: { collectionSyncScopes: 'everything' } });
  assert.match(q(el, '.scope-error').textContent ?? '', /must be a list/);
  assert.equal(q<HTMLButtonElement>(el, '.save').disabled, true);
});

test('DatabaseEditor: malformed persisted system settings normalise and report', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [null, [1], { parameter: 9, type: 'weird', value: 5 }] },
  });
  assert.match(settingError(el), /Enter a parameter name for every startup setting/);
  const rows = el.shadowRoot!.querySelectorAll('.setting-row');
  assert.equal(rows.length, 3);
  const typeSelect = rows[2]!.querySelector<HTMLSelectElement>('select[id^=setting-type]')!;
  assert.equal(typeSelect.value, 'string', 'an unknown persisted type coerces to string');
});

test('DatabaseEditor: a non-list systemSettings value is called out', async t => {
  const el = await mount(t, { advancedConfig: { systemSettings: { BAD: true } } });
  assert.match(settingError(el), /must be a list/);
  assert.equal(q<HTMLButtonElement>(el, '.save').disabled, true);
});

test('DatabaseEditor: parameter naming rules are enforced case-insensitively', async t => {
  const badName = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: '1BAD', type: 'string', value: '' }] },
  });
  assert.match(settingError(badName), /Parameter “1BAD” has an invalid name/);
  assert.equal(q(badName, '.setting-row input').getAttribute('aria-invalid'), 'true');

  const managedScopes = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'user_collection_sync_scopes', type: 'string', value: '' }] },
  });
  assert.match(settingError(managedScopes), /USER_COLLECTION_SYNC_SCOPES” is managed by a dedicated control/);

  const managedStrict = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'dql_strict_mode', type: 'boolean', value: true }] },
  });
  assert.match(settingError(managedStrict), /DQL_STRICT_MODE” is managed by a dedicated control/);

  const dupes = await mount(t, {
    advancedConfig: {
      systemSettings: [
        { parameter: 'MAX_QUERY_TIME', type: 'integer', value: 1 },
        { parameter: 'max_query_time', type: 'integer', value: 2 },
      ],
    },
  });
  assert.match(settingError(dupes), /MAX_QUERY_TIME” is configured more than once/);
  const dupeRows = dupes.shadowRoot!.querySelectorAll('.setting-row');
  assert.equal(dupeRows[0]!.querySelector('input[id^=setting-parameter]')!.getAttribute('aria-invalid'), 'true',
    'first duplicate flagged');
  assert.equal(dupeRows[1]!.querySelector('input[id^=setting-parameter]')!.getAttribute('aria-invalid'), 'true',
    'second duplicate flagged');
});

test('DatabaseEditor: value/type mismatches are reported per setting type', async t => {
  const intEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'L', type: 'integer', value: 1.5 }] },
  });
  assert.match(settingError(intEl), /L” must be an integer/);
  assert.equal(q(intEl, '.setting-row input[type=number]').getAttribute('aria-invalid'), 'true');

  const boolEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'B', type: 'boolean', value: 'yes' }] },
  });
  assert.match(settingError(boolEl), /B” must be true or false/);
  assert.equal(q(boolEl, '.setting-row select[id^=setting-value]').getAttribute('aria-invalid'), 'true');

  const strEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'S', type: 'string', value: 5 }] },
  });
  assert.match(settingError(strEl), /S” must be text/);

  const jsonEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'J', type: 'json', value: { n: Infinity } }] },
  });
  assert.match(settingError(jsonEl), /J” must contain valid JSON/,
    'Infinity is not a JSON number');
});

test('DatabaseEditor: the JSON-value guard rejects pathological structures', async t => {
  // Deeper than the 64-level walk limit.
  let deep: unknown = 'leaf';
  for (let i = 0; i < 70; i += 1) { deep = { v: deep }; }
  const deepEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'DEEP', type: 'json', value: deep }] },
  });
  assert.match(settingError(deepEl), /DEEP” must contain valid JSON/);

  // More nodes than the 10k visit budget.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 10_002; i += 1) { wide[`k${i}`] = i; }
  const wideEl = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'WIDE', type: 'json', value: wide }] },
  });
  assert.match(settingError(wideEl), /WIDE” must contain valid JSON/);

  // Nested arrays and objects are fine.
  const okEl = await mount(t, {
    advancedConfig: {
      systemSettings: [{ parameter: 'OK', type: 'json', value: { list: [1, [2, { a: 'b' }]], n: null } }],
    },
  });
  assert.equal(okEl.shadowRoot!.querySelector('.setting-error'), null);
  assert.equal(q<HTMLButtonElement>(okEl, '.save').disabled, false);
});

test('DatabaseEditor: boolean settings edit through a true/false select', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'FLAG', type: 'boolean', value: true }] },
  });
  const select = q<HTMLSelectElement>(el, '.setting-row select[id^=setting-value]');
  assert.equal(select.value, 'true');
  pick(select, 'false');
  await el.updateComplete;

  q<HTMLElement>(el, '.save').click();
  assert.deepEqual(
    (savePayload().config as Record<string, any>).advancedConfig.systemSettings,
    [{ parameter: 'FLAG', type: 'boolean', value: false }],
  );
});

test('DatabaseEditor: changing a setting type clears drafts and installs the type default', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'D', type: 'json', value: {} }] },
  });
  const textarea = q<HTMLTextAreaElement>(el, '.setting-row textarea');
  type(textarea, '{broken');
  await el.updateComplete;
  assert.match(settingError(el), /valid JSON/, 'draft is invalid');

  const typeSelect = q<HTMLSelectElement>(el, 'select[id^=setting-type]');
  pick(typeSelect, 'integer');
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.setting-error'), null, 'type change cleared the draft');
  assert.equal(q<HTMLInputElement>(el, '.setting-row input[type=number]').value, '0',
    'integer default installed');

  pick(q<HTMLSelectElement>(el, 'select[id^=setting-type]'), 'boolean');
  await el.updateComplete;
  assert.equal(q<HTMLSelectElement>(el, '.setting-row select[id^=setting-value]').value, 'false');

  pick(q<HTMLSelectElement>(el, 'select[id^=setting-type]'), 'string');
  await el.updateComplete;
  assert.equal(q<HTMLInputElement>(el, 'input[id^=setting-value]').value, '');

  pick(q<HTMLSelectElement>(el, 'select[id^=setting-type]'), 'json');
  await el.updateComplete;
  assert.equal(q<HTMLTextAreaElement>(el, '.setting-row textarea').value, '{}');
});

test('DatabaseEditor: re-selecting a manual parameter clears its obsolete draft', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'DIRECTIVES', type: 'json', value: {} }] },
  }, { isActiveConnection: true });
  send({
    type: 'editor.systemSettingsLoaded',
    options: [{ parameter: 'MAX_QUERY_TIME', type: 'integer', value: 30 }],
  });
  await el.updateComplete;

  // DIRECTIVES is not a discovered option, so the select offers it as a
  // manual entry; typing a broken draft then re-selecting the manual entry
  // must clear the draft (selectSystemSetting's not-in-options fallback).
  const select = q<HTMLSelectElement>(el, '.setting-row select[id^=setting-parameter]');
  assert.equal(select.value, 'DIRECTIVES');
  assert.ok([...select.options].some(o => o.value === 'DIRECTIVES'), 'manual entry offered');

  type(q<HTMLTextAreaElement>(el, '.setting-row textarea'), '{broken');
  await el.updateComplete;
  assert.match(settingError(el), /valid JSON/);

  pick(select, 'DIRECTIVES');
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.setting-error'), null, 'draft cleared on re-select');
  assert.equal(q<HTMLButtonElement>(el, '.save').disabled, false);
});

test('DatabaseEditor: adding a setting picks the first unconfigured discovered option', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'A_SET', type: 'string', value: 'x' }] },
  }, { isActiveConnection: true });
  send({
    type: 'editor.systemSettingsLoaded',
    options: [
      { parameter: 'A_SET', type: 'string', value: '' },
      { parameter: 'B_SET', type: 'integer', value: 7 },
    ],
  });
  await el.updateComplete;

  el.shadowRoot!.querySelectorAll<HTMLElement>('.add-scope')[1]!.click();
  await el.updateComplete;
  const rows = el.shadowRoot!.querySelectorAll('.setting-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.querySelector<HTMLSelectElement>('select[id^=setting-parameter]')!.value, 'B_SET',
    'A_SET is already configured, so the add picks B_SET');
  assert.equal(rows[1]!.querySelector<HTMLInputElement>('input[type=number]')!.value, '7');
});

test('DatabaseEditor: each parameter select only offers options not configured elsewhere', async t => {
  const el = await mount(t, {
    advancedConfig: {
      systemSettings: [
        { parameter: 'A_SET', type: 'string', value: 'x' },
        { parameter: 'B_SET', type: 'string', value: 'y' },
      ],
    },
  }, { isActiveConnection: true });
  send({
    type: 'editor.systemSettingsLoaded',
    options: [
      { parameter: 'A_SET', type: 'string', value: '' },
      { parameter: 'B_SET', type: 'string', value: '' },
      { parameter: 'C_SET', type: 'string', value: '' },
    ],
  });
  await el.updateComplete;

  const optionsOf = (row: number): string[] =>
    [...el.shadowRoot!.querySelectorAll('.setting-row')[row]!
      .querySelectorAll<HTMLOptionElement>('select[id^=setting-parameter] option')]
      .map(o => o.value);
  assert.deepEqual(optionsOf(0), ['A_SET', 'C_SET'], 'B_SET is taken by row 1');
  assert.deepEqual(optionsOf(1), ['B_SET', 'C_SET'], 'A_SET is taken by row 0');

  // The type select is locked for discovered parameters on an active
  // connection (both rows hold discovered parameters here).
  const typeOf = (row: number): HTMLSelectElement =>
    el.shadowRoot!.querySelectorAll('.setting-row')[row]!.querySelector('select[id^=setting-type]')!;
  assert.equal(typeOf(0).disabled, true, 'discovered parameter type locked');
  assert.equal(typeOf(1).disabled, true, 'discovered parameter type locked');
});

test('DatabaseEditor: removing a row reindexes integer drafts, not just JSON drafts', async t => {
  const el = await mount(t, {
    advancedConfig: {
      systemSettings: [
        { parameter: 'A', type: 'integer', value: 1 },
        { parameter: 'B', type: 'integer', value: 2 },
      ],
    },
  });
  const rowB = (): Element => {
    const row = el.shadowRoot!.querySelectorAll('.setting-row')[1];
    assert.ok(row, 'row B exists');
    return row;
  };
  // A number input cannot hold letters in jsdom (value sanitisation), so the
  // invalid-integer draft is a fractional number: valid text, unsafe integer.
  type(rowB().querySelector('input[type=number]')!, '1.5');
  await el.updateComplete;
  assert.match(settingError(el), /safe integer/);

  el.shadowRoot!.querySelector<HTMLElement>('.setting-remove')!.click();
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelectorAll('.setting-row').length, 1);
  const remaining = q<HTMLInputElement>(el, '.setting-row input[type=number]');
  assert.equal(remaining.value, '1.5', 'the draft followed row B down to index 0');
  assert.match(settingError(el), /safe integer/, 'the error followed the draft');
});

test('DatabaseEditor: a fresh init wipes drafts, errors, and the saving flag', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'D', type: 'json', value: {} }] },
  });
  type(q<HTMLTextAreaElement>(el, '.setting-row textarea'), '{broken');
  await el.updateComplete;
  send({ type: 'editor.validationError', message: 'stale banner' });
  await el.updateComplete;
  q(el, '.error-banner');
  assert.match(settingError(el), /valid JSON/, 'broken draft present before re-init');

  send({
    type: 'editor.init',
    config: baseConfig({ name: 'Fresh' }),
    secrets: { token: 'fresh-token' },
    isActiveConnection: false,
  });
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.setting-error'), null, 'draft error cleared');
  assert.equal(el.shadowRoot!.querySelectorAll('.setting-row').length, 0, 'old settings gone');
  assert.equal(q<HTMLInputElement>(el, '#connection-name').value, 'Fresh');
  assert.equal(q<HTMLInputElement>(el, '#connection-token').value, 'fresh-token');
  assert.equal(q<HTMLButtonElement>(el, '.save').disabled, false);
  assert.equal(q<HTMLDetailsElement>(el, 'details.advanced').open, false);
  // Fixed behavior: init clears a stale validationError banner — the error
  // named the previous config's problem and must not follow the new one.
  assert.equal(el.shadowRoot!.querySelector('.error-banner'), null,
    'editor.init resets validationError so a stale banner cannot survive a re-init');
});

test('DatabaseEditor: duplicate scope collections are flagged on both rows', async t => {
  const el = await mount(t, {
    advancedConfig: {
      collectionSyncScopes: [
        { collection: 'orders', scope: 'AllPeers' },
        { collection: 'orders', scope: 'BigPeerOnly' },
      ],
    },
  });
  assert.match(q(el, '.scope-error').textContent ?? '', /Collection “orders” is listed more than once/);
  const scopeInputs = el.shadowRoot!.querySelectorAll('.scope-row input');
  assert.equal(scopeInputs[0]!.getAttribute('aria-invalid'), 'true');
  assert.equal(scopeInputs[1]!.getAttribute('aria-invalid'), 'true');
  assert.equal(q<HTMLButtonElement>(el, '.save').disabled, true);
});

test('DatabaseEditor: the scope-count summary uses singular and plural correctly', async t => {
  const oneEach = await mount(t, {
    advancedConfig: {
      collectionSyncScopes: [{ collection: 'orders', scope: 'AllPeers' }],
      systemSettings: [{ parameter: 'A', type: 'string', value: 'x' }],
    },
  });
  assert.match(q(oneEach, '.scope-count').textContent ?? '', /1 scope · 1 startup setting/);

  const none = await mount(t);
  assert.match(q(none, '.scope-count').textContent ?? '', /0 scopes · 0 startup settings/);
});

test('DatabaseEditor: an active connection with a pending change badges the summary', async t => {
  const el = await mount(t, {
    advancedConfig: { systemSettings: [{ parameter: 'A', type: 'string', value: 'x' }] },
  }, { isActiveConnection: true });
  type(q<HTMLInputElement>(el, '.setting-row input[type=text]'), 'y');
  await el.updateComplete;
  assert.equal(q(el, '.scope-count').textContent, 'Reconnect required',
    'the count is replaced while reconnect-relevant changes are pending');
});

test('DatabaseEditor: key order in a JSON setting value does not count as changed', async t => {
  const el = await mount(t, {
    advancedConfig: {
      systemSettings: [{ parameter: 'D', type: 'json', value: { list: [1, 2], m: { a: 1 } } }],
    },
  }, { isActiveConnection: true });
  const textarea = q<HTMLTextAreaElement>(el, '.setting-row textarea');

  type(textarea, '{"m":{"a":1},"list":[1,2]}');
  await el.updateComplete;
  assert.equal(el.shadowRoot!.querySelector('.setting-warning'), null,
    'reordered keys compare equal');

  type(textarea, '{"m":{"a":1},"list":[1,3]}');
  await el.updateComplete;
  const warning = q(el, '.setting-warning');
  assert.match(warning.textContent ?? '', /Reconnect required/);
  assert.match(warning.textContent ?? '', /1 changed/);
});

test('DatabaseEditor: non-string persisted values render as editable text', async t => {
  const el = await mount(t, {
    advancedConfig: {
      systemSettings: [
        { parameter: 'OBJ', type: 'string', value: { a: 1 } },
        { parameter: 'NIL', type: 'string', value: null },
        { parameter: 'BOOL', type: 'string', value: true },
      ],
    },
  });
  const inputs = el.shadowRoot!.querySelectorAll<HTMLInputElement>('.setting-row input[type=text]:not([id^=setting-parameter])');
  // Object values stringify for editing instead of rendering "[object Object]".
  const values = [...inputs].map(i => i.value);
  assert.ok(values.includes('{"a":1}'), 'object value is JSON-stringified into the field');
  assert.ok(values.includes(''), 'null value renders as empty');
  assert.ok(values.includes('true'), 'boolean value renders as "true"');
});
