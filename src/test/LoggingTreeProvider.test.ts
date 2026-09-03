// src/test/LoggingTreeProvider.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LoggingTreeProvider } from '../tree/LoggingTreeProvider.js';

function fakeLogger() {
  let app: any = 'info', sdk: any = 'info';
  const appE = new vscode.EventEmitter();
  const sdkE = new vscode.EventEmitter();
  return {
    api: {
      getChannelLevel: () => app,
      setChannelLevel: (l: any) => { app = l; (appE as any).fire(l); },
      onDidChangeChannelLevel: appE.event,
      getSdkLevel: () => sdk,
      setSdkLevel: (l: any) => { sdk = l; (sdkE as any).fire(l); },
      onDidChangeSdkLevel: sdkE.event,
    } as any,
    setApp(l: any) { app = l; (appE as any).fire(l); },
    setSdk(l: any) { sdk = l; (sdkE as any).fire(l); },
  };
}

test('LoggingTreeProvider: returns 6 root nodes in fixed order', async () => {
  // Note: openAnalyzer is intentionally NOT here — the Log Analyzer is
  // per-database and lives in the database tree row, not the global
  // Logging sidebar. Pattern Editor stays here because patterns apply
  // to all logs across connections.
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const nodes = p.getChildren();
  assert.equal(nodes.length, 6);
  assert.deepEqual(nodes.map(n => n.kind), ['appLevel', 'sdkLevel', 'openOutput', 'exportLogs', 'showLogFile', 'openPatternEditor']);
});

test('LoggingTreeProvider: appLevel item description shows current level', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const [app] = p.getChildren();
  assert.ok(app);
  const item = p.getTreeItem(app);
  assert.match(String(item.description), /info/);
});

test('LoggingTreeProvider: fires onDidChange when channel level changes', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  let fired = 0;
  p.onDidChangeTreeData(() => { fired++; });
  f.setApp('debug');
  assert.equal(fired, 1);
});

test('LoggingTreeProvider: openOutput item has command id dittoVsce.openOutputChannel', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const nodes = p.getChildren();
  const oo = nodes.find(n => n.kind === 'openOutput')!;
  const item = p.getTreeItem(oo);
  assert.equal(item.command?.command, 'dittoVsce.openOutputChannel');
});

test('LoggingTreeProvider: exposes openPatternEditor node', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const nodes = p.getChildren();
  const editor = nodes.find(n => n.kind === 'openPatternEditor');
  assert.ok(editor, 'openPatternEditor node missing');
  const item = p.getTreeItem(editor);
  assert.equal(item.command?.command, 'dittoVsce.openLogPatternEditor');
  assert.equal(item.label, 'Manage Log Patterns');
});

test('LoggingTreeProvider: sdkLevel item shows current SDK level, icon, and command', async () => {
  const f = fakeLogger();
  f.setSdk('debug');
  const p = new LoggingTreeProvider(f.api);
  const sdk = p.getChildren().find(n => n.kind === 'sdkLevel')!;
  const item = p.getTreeItem(sdk);
  assert.equal(item.label, 'Ditto SDK Log Level');
  assert.equal(item.description, 'debug');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.equal((item.iconPath as vscode.ThemeIcon).id, 'database');
  assert.equal(item.command?.command, 'dittoVsce.setDittoSdkLogLevel');
  assert.equal(item.command?.title, 'Set Ditto SDK Log Level');
});

test('LoggingTreeProvider: appLevel row wiring (label, icon, command)', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const app = p.getChildren().find(n => n.kind === 'appLevel')!;
  const item = p.getTreeItem(app);
  assert.equal(item.label, 'Application Log Level');
  assert.equal((item.iconPath as vscode.ThemeIcon).id, 'output');
  assert.equal(item.command?.command, 'dittoVsce.setApplicationLogLevel');
  assert.equal(item.command?.title, 'Set Application Log Level');
});

test('LoggingTreeProvider: level descriptions track logger state on re-render', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const [app, sdk] = p.getChildren();
  assert.ok(app && sdk);
  assert.equal(p.getTreeItem(app).description, 'info');
  assert.equal(p.getTreeItem(sdk).description, 'info');
  f.setApp('error');
  f.setSdk('trace');
  assert.equal(p.getTreeItem(app).description, 'error');
  assert.equal(p.getTreeItem(sdk).description, 'trace');
});

test('LoggingTreeProvider: fires onDidChange when the SDK level changes', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  let fired = 0;
  p.onDidChangeTreeData(() => { fired++; });
  f.setSdk('verbose');
  assert.equal(fired, 1);
});

test('LoggingTreeProvider: fires once per level change, not per node', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  let fired = 0;
  p.onDidChangeTreeData(() => { fired++; });
  f.setApp('warn');
  f.setSdk('error');
  f.setApp('debug');
  assert.equal(fired, 3);
});

test('LoggingTreeProvider: exportLogs row wiring', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const node = p.getChildren().find(n => n.kind === 'exportLogs')!;
  const item = p.getTreeItem(node);
  assert.equal(item.label, 'Export Logs for Bug Report…');
  assert.equal((item.iconPath as vscode.ThemeIcon).id, 'save');
  assert.equal(item.command?.command, 'dittoVsce.exportLogs');
  assert.equal(item.command?.title, 'Export Logs');
});

test('LoggingTreeProvider: showLogFile row wiring', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const node = p.getChildren().find(n => n.kind === 'showLogFile')!;
  const item = p.getTreeItem(node);
  assert.equal(item.label, 'Show Log File in Finder');
  assert.equal((item.iconPath as vscode.ThemeIcon).id, 'folder');
  assert.equal(item.command?.command, 'dittoVsce.showLogFile');
  assert.equal(item.command?.title, 'Show Log File');
});

test('LoggingTreeProvider: openOutput and openPatternEditor rows are iconed leaves', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const nodes = p.getChildren();
  const oo = p.getTreeItem(nodes.find(n => n.kind === 'openOutput')!);
  assert.equal(oo.label, 'Open Output Channel');
  assert.equal((oo.iconPath as vscode.ThemeIcon).id, 'go-to-file');
  const pe = p.getTreeItem(nodes.find(n => n.kind === 'openPatternEditor')!);
  assert.equal((pe.iconPath as vscode.ThemeIcon).id, 'settings-gear');
});

test('LoggingTreeProvider: every row is a non-collapsible leaf with a command', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  for (const node of p.getChildren()) {
    const item = p.getTreeItem(node);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None, `${node.kind} is a leaf`);
    assert.ok(item.command?.command, `${node.kind} has a command`);
    assert.ok(item.command.title, `${node.kind} command has a title`);
  }
});
