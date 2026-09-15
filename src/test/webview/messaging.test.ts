import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

/** The api must exist before the module runs — `messaging.ts` calls
 *  acquireVsCodeApi() at import time and holds the result. */
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage() { /* unused here */ },
  getState() { return undefined; },
  setState() {},
});

const { isTrustedHostOrigin, HostMessages } = await import('../../../webview-ui/shared/messaging.js');

// ─── Origin predicate ──────────────────────────────────────────
//
// The listener drops any message whose origin isn't the editor's. These
// assert the predicate directly, because the jsdom shim in setup.ts stamps a
// trusted origin onto every MessageEvent by default — without a test that
// supplies a hostile origin explicitly, the guard could be deleted and the
// whole suite would still pass.

test('isTrustedHostOrigin: accepts the desktop webview origin', () => {
  assert.equal(isTrustedHostOrigin('vscode-webview://1a2b3c4d-5e6f'), true);
});

test('isTrustedHostOrigin: accepts a browser-hosted editor origin', () => {
  // Codespaces / a remote workspace opened over the web serves the same
  // webview content over https.
  assert.equal(isTrustedHostOrigin('https://abc123.vscode-cdn.net'), true);
});

test('isTrustedHostOrigin: rejects other schemes and a null origin', () => {
  for (const origin of [
    'http://evil.example',
    'file:///tmp/evil.html',
    'data:text/html,<script>1</script>',
    'vscode-webview-evil://spoof', // must not pass on a prefix-ish name
    'null',
    '',
  ]) {
    assert.equal(isTrustedHostOrigin(origin), false, `expected ${origin || '<empty>'} to be untrusted`);
  }
});

// ─── The listener actually applies it ──────────────────────────

/** Minimal ReactiveControllerHost — HostMessages only ever calls addController. */
function fakeHost() {
  const controllers: { hostConnected?: () => void; hostDisconnected?: () => void }[] = [];
  return {
    controllers,
    addController(c: any) { controllers.push(c); },
    removeController() { /* unused */ },
    requestUpdate() { /* unused */ },
    get updateComplete() { return Promise.resolve(true); },
  };
}

test('HostMessages: delivers a message from a trusted origin', () => {
  const host = fakeHost();
  const seen: unknown[] = [];
  const controller = new HostMessages<{ type: string }>(host, m => seen.push(m));
  controller.hostConnected();

  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ok' } }));
  assert.deepEqual(seen, [{ type: 'ok' }]);

  controller.hostDisconnected();
});

test('HostMessages: drops a message from an untrusted origin', () => {
  const host = fakeHost();
  const seen: unknown[] = [];
  const controller = new HostMessages<{ type: string }>(host, m => seen.push(m));
  controller.hostConnected();

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'spoofed' },
    origin: 'http://evil.example',
  }));
  assert.deepEqual(seen, [], 'handler must not run for a foreign origin');

  // …and the listener is still live for legitimate traffic afterwards.
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'ok' } }));
  assert.deepEqual(seen, [{ type: 'ok' }]);

  controller.hostDisconnected();
});

test('HostMessages: drops a same-scheme message that did not come from the host window', () => {
  const host = fakeHost();
  const seen: unknown[] = [];
  const controller = new HostMessages<{ type: string }>(host, m => seen.push(m));
  controller.hostConnected();

  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'spoofed' },
    origin: 'vscode-webview://another-webview',
    source: null,
  }));
  assert.deepEqual(seen, [], 'handler must only accept messages from window.parent');

  controller.hostDisconnected();
});
