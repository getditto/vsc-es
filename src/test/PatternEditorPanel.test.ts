import test from 'node:test';
import assert from 'node:assert/strict';
test('PatternEditorPanel: module loads', async () => {
  const mod = await import('../panels/PatternEditorPanel.js');
  assert.ok(mod.PatternEditorPanel);
});
