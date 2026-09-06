import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

/** The api must exist before any main module runs — each main imports its
 *  elements, which import `messaging.ts`, which calls acquireVsCodeApi()
 *  at import time and holds the result. */
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) { posted.push(msg); },
  getState() { return undefined; },
  setState() {},
});

/** The presence graph (registered through the peers chain) constructs a
 *  ResizeObserver when it has data to show; jsdom has none. */
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;

// Every main mounts its root element into #root when the host page provides
// one — give them one so the smoke test covers the mount path and the
// initial render, not just module evaluation.
const root = document.createElement('div');
root.id = 'root';
document.body.appendChild(root);

await import('../../../webview-ui/addIndex/main.js');
await import('../../../webview-ui/databaseMetrics/main.js');
await import('../../../webview-ui/debugConsole/main.js');
await import('../../../webview-ui/editor/main.js');
await import('../../../webview-ui/import-subscriptions/main.js');
await import('../../../webview-ui/importData/main.js');
await import('../../../webview-ui/inspector/main.js');
await import('../../../webview-ui/logAnalyzer/main.js');
await import('../../../webview-ui/observer/main.js');
await import('../../../webview-ui/patternEditor/main.js');
await import('../../../webview-ui/peers/main.js');
await import('../../../webview-ui/query/main.js');
await import('../../../webview-ui/queryMetrics/main.js');
await import('../../../webview-ui/subscription/main.js');
await import('../../../webview-ui/systemMetrics/main.js');
await import('../../../webview-ui/welcome/main.js');

/** [directory, tag the directory's main.ts mounts into #root]. */
const MAINS: ReadonlyArray<readonly [string, string]> = [
  ['addIndex', 'ditto-add-index'],
  ['databaseMetrics', 'ditto-database-metrics'],
  ['debugConsole', 'ditto-debug-console'],
  ['editor', 'ditto-database-editor'],
  ['import-subscriptions', 'ditto-import-subscriptions'],
  ['importData', 'ditto-import-data'],
  ['inspector', 'ditto-inspector'],
  ['logAnalyzer', 'ditto-log-analyzer'],
  ['observer', 'ditto-observer-panel'],
  ['patternEditor', 'ditto-pattern-editor'],
  ['peers', 'ditto-peer-listing'],
  ['query', 'ditto-query-editor'],
  ['queryMetrics', 'ditto-query-metrics'],
  ['subscription', 'ditto-subscription-editor'],
  ['systemMetrics', 'ditto-system-metrics'],
  ['welcome', 'ditto-welcome'],
];

/** Elements registered as a side effect of a main's import chain rather
 *  than mounted by it — notably the presence graph, which has no main.ts
 *  of its own and ships inside the peers webview. */
const EXTRA_REGISTERED: ReadonlyArray<readonly [string, string]> = [
  ['inspector', 'help-content-element'],
  ['inspector', 'query-history-element'],
  ['inspector', 'query-favorites-element'],
  ['inspector', 'query-json-element'],
  ['inspector', 'query-metrics-element'],
  ['inspector', 'attachment-viewer-element'],
  ['query', 'ditto-profile-viewer'],
  ['peers', 'ditto-presence-graph'],
];

// Disconnect everything on the way out: rAF loops, the peers tick interval,
// and every HostMessages subscription live on detached elements' teardown.
test.after(() => { root.remove(); });

test('every webview main registers its root custom element', () => {
  for (const [dir, tag] of MAINS) {
    assert.ok(customElements.get(tag), `${dir}/main.ts should register <${tag}>`);
  }
});

test('every webview main mounts its root element into #root', async () => {
  for (const [dir, tag] of MAINS) {
    const el = root.querySelector(tag) as unknown as
      (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
    assert.ok(el, `${dir}/main.ts should mount <${tag}> into #root`);
    // Flushing the first render is the point: a render-time throw rejects
    // updateComplete and fails here, not in some user's panel.
    await el.updateComplete;
  }
});

test('import chains register the secondary elements too', () => {
  for (const [dir, tag] of EXTRA_REGISTERED) {
    assert.ok(customElements.get(tag), `${dir}/main.ts's import chain should register <${tag}>`);
  }
});

test('mounted mains only post envelope-shaped messages', () => {
  // Several elements announce themselves on connect (e.g. the log analyzer
  // kicks off an initial lines request). Whatever they say must carry a
  // discriminating `type` — that is the whole IPC contract.
  for (const msg of posted) {
    assert.ok(
      msg !== null && typeof msg === 'object' && 'type' in msg && typeof msg.type === 'string',
      `posted message missing a type: ${JSON.stringify(msg)}`,
    );
  }
});
