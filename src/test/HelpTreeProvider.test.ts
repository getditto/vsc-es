// coverage.test.ts — HelpTreeProvider is a flat, static tree; this smoke test
// keeps it out of the never-loaded list and pins the link-vs-action wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HelpTreeProvider } from '../tree/HelpTreeProvider.js';

test('HelpTreeProvider: getChildren returns the static flat list', () => {
  const provider = new HelpTreeProvider();
  const children = provider.getChildren();
  assert.ok(children.length > 0);
  for (const node of children) {
    assert.ok(typeof node.label === 'string' && node.label.length > 0);
  }
  // Flat tree: links and actions are both represented.
  assert.ok(children.some(n => n.kind === 'link'));
  assert.ok(children.some(n => n.kind === 'action'));
});

test('HelpTreeProvider: actions map to their command; links map to vscode.open', () => {
  const provider = new HelpTreeProvider();
  for (const node of provider.getChildren()) {
    const item = provider.getTreeItem(node);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(item.label, node.label);
    assert.equal(typeof item.iconPath, 'object');
    if (node.kind === 'action') {
      assert.equal(item.command?.command, node.command);
    } else {
      assert.equal(item.command?.command, 'vscode.open');
      const uri = item.command?.arguments?.[0] as { scheme?: string } | undefined;
      assert.equal(uri?.scheme, 'https');
    }
  }
});
