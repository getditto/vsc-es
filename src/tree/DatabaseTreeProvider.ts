import * as vscode from 'vscode';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { DatabaseTreeNode } from './DatabaseTreeItem.js';

export type DatabaseStatus = 'idle' | 'activating' | 'active' | 'error';
export type StatusResolver = (databaseId: string) => DatabaseStatus;

export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly _changeEmitter = new vscode.EventEmitter<DatabaseTreeNode | undefined>();
  readonly onDidChangeTreeData = this._changeEmitter.event;

  constructor(
    private readonly configs: ConfigStore,
    private readonly statusFor: StatusResolver,
    private readonly subs: SubscriptionStore
  ) {
    configs.onDidChange(() => this._changeEmitter.fire(undefined));
    subs.onDidChange(() => this._changeEmitter.fire(undefined));
  }

  refresh(node?: DatabaseTreeNode) { this._changeEmitter.fire(node); }

  async getRootChildren(): Promise<DatabaseTreeNode[]> {
    return this.configs.list().map(config => ({
      kind: 'database' as const,
      config,
      status: this.statusFor(config.id)
    }));
  }

  async getNodeChildren(node: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    if (node.kind === 'database') {
      if (node.status !== 'active') { return []; }
      return [
        { kind: 'subscriptionsParent', databaseId: node.config.id },
        { kind: 'peerListing', databaseId: node.config.id },
        { kind: 'queryEditor', databaseId: node.config.id },
      ];
    }
    if (node.kind === 'subscriptionsParent') {
      return this.subs.list(node.databaseId).map(sub => ({
        kind: 'subscription' as const,
        databaseId: node.databaseId,
        sub
      }));
    }
    return [];
  }

  // ─── vscode.TreeDataProvider ─────────────────────────────────
  async getChildren(element?: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    return element ? this.getNodeChildren(element) : this.getRootChildren();
  }

  getTreeItem(node: DatabaseTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'database': {
        const dot = node.status === 'active' ? '●'
                  : node.status === 'activating' ? '◐'
                  : node.status === 'error' ? '⊗'
                  : '○';
        const item = new vscode.TreeItem(
          `${dot} ${node.config.name || '(unnamed)'}`,
          node.status === 'active'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );
        item.description = `${node.config.mode === 'server' ? 'Server' : 'SmallPeers'} · ${node.config.databaseId.slice(0, 6)}…`;
        item.contextValue = `database.${node.status}`;
        item.tooltip = node.config.name;
        item.id = `db.${node.config.id}`;
        item.command = node.status === 'idle' || node.status === 'error'
          ? { command: 'dittoVsce.connect', title: 'Connect', arguments: [node] }
          : undefined;
        return item;
      }
      case 'subscriptionsParent': {
        const item = new vscode.TreeItem('Subscriptions', vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'subscriptionsParent';
        item.id = `subs.${node.databaseId}`;
        return item;
      }
      case 'subscription': {
        const item = new vscode.TreeItem(node.sub.name);
        item.description = node.sub.query;
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.sub.query, 'sql');
        item.contextValue = 'subscription';
        item.id = `sub.${node.databaseId}.${node.sub.id}`;
        return item;
      }
      case 'peerListing': {
        const item = new vscode.TreeItem('Peer Listing');
        item.iconPath = new vscode.ThemeIcon('broadcast');
        item.contextValue = 'peerListing';
        item.id = `peers.${node.databaseId}`;
        item.command = { command: 'dittoVsce.openPeerListing', title: 'Open Peer Listing', arguments: [node.databaseId] };
        return item;
      }
      case 'queryEditor': {
        const item = new vscode.TreeItem('Query Editor');
        item.iconPath = new vscode.ThemeIcon('terminal');
        item.contextValue = 'queryEditor';
        item.id = `query.${node.databaseId}`;
        item.command = { command: 'dittoVsce.openQueryEditor', title: 'Open Query Editor', arguments: [node.databaseId] };
        return item;
      }
    }
  }
}
