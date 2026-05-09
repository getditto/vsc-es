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

test('LoggingTreeProvider: returns 5 root nodes in fixed order', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const nodes = await p.getChildren();
  assert.equal(nodes.length, 5);
  assert.deepEqual(nodes.map(n => n.kind), ['appLevel', 'sdkLevel', 'openOutput', 'exportLogs', 'showLogFile']);
});

test('LoggingTreeProvider: appLevel item description shows current level', async () => {
  const f = fakeLogger();
  const p = new LoggingTreeProvider(f.api);
  const [app] = await p.getChildren();
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
  const nodes = await p.getChildren();
  const oo = nodes.find(n => n.kind === 'openOutput')!;
  const item = p.getTreeItem(oo);
  assert.equal(item.command?.command, 'dittoVsce.openOutputChannel');
});
