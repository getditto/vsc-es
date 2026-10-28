// src/tree/LoggingTreeProvider.ts
import * as vscode from 'vscode';
import type { Logger } from '../logging/types.js';

export type LoggingNode =
  | { kind: 'appLevel' }
  | { kind: 'sdkLevel' }
  | { kind: 'openOutput' }
  | { kind: 'exportLogs' }
  | { kind: 'showLogFile' }
  | { kind: 'clearLogs' }
  | { kind: 'openPatternEditor' };

export class LoggingTreeProvider implements vscode.TreeDataProvider<LoggingNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly logger: Logger) {
    logger.onDidChangeChannelLevel(() => this._onDidChange.fire());
    logger.onDidChangeSdkLevel(() => this._onDidChange.fire());
  }

  getChildren(): LoggingNode[] {
    return [
      { kind: 'appLevel' },
      { kind: 'sdkLevel' },
      { kind: 'openOutput' },
      { kind: 'exportLogs' },
      { kind: 'showLogFile' },
      { kind: 'clearLogs' },
      { kind: 'openPatternEditor' },
    ];
  }

  getTreeItem(node: LoggingNode): vscode.TreeItem {
    switch (node.kind) {
      case 'appLevel': {
        const it = new vscode.TreeItem('Application Log Level', vscode.TreeItemCollapsibleState.None);
        it.description = this.logger.getChannelLevel();
        it.iconPath = new vscode.ThemeIcon('output');
        it.command = { command: 'dittoVsce.setApplicationLogLevel', title: 'Set Application Log Level' };
        return it;
      }
      case 'sdkLevel': {
        const it = new vscode.TreeItem('Ditto SDK Log Level', vscode.TreeItemCollapsibleState.None);
        it.description = this.logger.getSdkLevel();
        it.iconPath = new vscode.ThemeIcon('database');
        it.command = { command: 'dittoVsce.setDittoSdkLogLevel', title: 'Set Ditto SDK Log Level' };
        return it;
      }
      case 'openOutput': {
        const it = new vscode.TreeItem('Open Output Channel', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('go-to-file');
        it.command = { command: 'dittoVsce.openOutputChannel', title: 'Open Output Channel' };
        return it;
      }
      case 'exportLogs': {
        const it = new vscode.TreeItem('Export Logs for Bug Report…', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('save');
        it.command = { command: 'dittoVsce.exportLogs', title: 'Export Logs' };
        return it;
      }
      case 'showLogFile': {
        const it = new vscode.TreeItem('Show Log File in Finder', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('folder');
        it.command = { command: 'dittoVsce.showLogFile', title: 'Show Log File' };
        return it;
      }
      case 'clearLogs': {
        const it = new vscode.TreeItem('Clear Application Log…', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('trash');
        it.command = { command: 'dittoVsce.clearApplicationLog', title: 'Clear Application Log' };
        return it;
      }
      case 'openPatternEditor': {
        const it = new vscode.TreeItem('Manage Log Patterns', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('settings-gear');
        it.command = { command: 'dittoVsce.openLogPatternEditor', title: 'Manage Log Patterns' };
        return it;
      }
    }
  }
}
