import test from 'node:test';
import assert from 'node:assert/strict';
// Lightweight: this file only verifies the module loads + exports the class.
// Real behavior validated by the integration test in Task 22.
test('LogAnalyzerPanel: module loads', async () => {
  const mod = await import('../panels/LogAnalyzerPanel.js');
  assert.ok(mod.LogAnalyzerPanel);
});
