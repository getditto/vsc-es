import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
// Side-effect import registers the <level-histogram> custom element.
await import('../../../webview-ui/logAnalyzer/components/level-histogram.js');

test('LevelHistogram: empty state shows placeholder', async () => {
  const el = document.createElement('level-histogram') as any;
  el.bins = [];
  document.body.appendChild(el);
  await el.updateComplete;
  assert.match(el.shadowRoot.innerHTML, /No volume data yet/);
  el.remove();
});

test('LevelHistogram: renders rects when bins populated', async () => {
  const el = document.createElement('level-histogram') as any;
  el.bins = [
    { binStartMs: 0, counts: { error: 2, warn: 0, info: 5, debug: 0, trace: 0 } },
    { binStartMs: 1000, counts: { error: 1, warn: 1, info: 3, debug: 0, trace: 0 } },
  ];
  document.body.appendChild(el);
  await el.updateComplete;
  const rects = el.shadowRoot.querySelectorAll('rect');
  assert.ok(rects.length >= 2, `expected >=2 rects, got ${rects.length}`);
  el.remove();
});
