import * as vscode from 'vscode';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { DatabaseTreeNode } from './DatabaseTreeItem.js';
import type { LifecycleState } from '../ditto/lifecycle-state.js';
import type { DittoCollection } from '../models/DittoCollection.js';

export type DatabaseStatus = 'idle' | 'activating' | 'active' | 'error';
export type StatusResolver = (databaseId: string) => DatabaseStatus;
export type LifecycleResolver = () => LifecycleState;

export interface CollectionsSource {
  current(): DittoCollection[];
  onChange: vscode.Event<DittoCollection[]>;
}

export class DatabaseTreeProvider implements vscode.TreeDataProvider<DatabaseTreeNode> {
  private readonly _changeEmitter = new vscode.EventEmitter<DatabaseTreeNode | undefined>();
  readonly onDidChangeTreeData = this._changeEmitter.event;

  constructor(
    private readonly configs: ConfigStore,
    private readonly statusFor: StatusResolver,
    private readonly subs: SubscriptionStore,
    private readonly lifecycleFor?: LifecycleResolver,
    private readonly collections?: CollectionsSource,
  ) {
    configs.onDidChange(() => this._changeEmitter.fire(undefined));
    subs.onDidChange(() => this._changeEmitter.fire(undefined));
    collections?.onChange(() => this._changeEmitter.fire(undefined));
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
      const dbId = node.config.id;
      return [
        // Data section: things the user drills into.
        { kind: 'sectionHeader', databaseId: dbId, id: 'data', label: 'Data' },
        { kind: 'subscriptionsParent', databaseId: dbId },
        { kind: 'collectionsParent', databaseId: dbId },
        // Feature section: things the user opens as editor tabs.
        { kind: 'sectionHeader', databaseId: dbId, id: 'features', label: 'Features' },
        { kind: 'peerListing', databaseId: dbId },
        { kind: 'queryEditor', databaseId: dbId },
      ];
    }
    if (node.kind === 'subscriptionsParent') {
      return this.subs.list(node.databaseId).map(sub => ({
        kind: 'subscription' as const,
        databaseId: node.databaseId,
        sub
      }));
    }
    if (node.kind === 'collectionsParent') {
      if (!this.collections) { return []; }
      return this.collections.current().map(c => ({
        kind: 'collection' as const,
        databaseId: node.databaseId,
        collection: c,
      }));
    }
    if (node.kind === 'collection') {
      return node.collection.indexes.map(idx => ({
        kind: 'index' as const,
        databaseId: node.databaseId,
        collectionName: node.collection.name,
        index: idx,
      }));
    }
    if (node.kind === 'index') {
      return node.index.fields.map(f => ({
        kind: 'indexField' as const,
        databaseId: node.databaseId,
        collectionName: node.collectionName,
        indexId: node.index.id,
        field: f,
      }));
    }
    return [];
  }

  // ─── vscode.TreeDataProvider ─────────────────────────────────
  async getChildren(element?: DatabaseTreeNode): Promise<DatabaseTreeNode[]> {
    return element ? this.getNodeChildren(element) : this.getRootChildren();
  }

  /** Required for TreeView.reveal to walk the tree. */
  getParent(element: DatabaseTreeNode): DatabaseTreeNode | undefined {
    if (element.kind === 'database') { return undefined; }
    const config = this.configs.list().find(c => c.id === element.databaseId);
    if (!config) { return undefined; }
    const dbNode: DatabaseTreeNode = {
      kind: 'database',
      config,
      status: this.statusFor(config.id),
    };
    if (element.kind === 'sectionHeader'
      || element.kind === 'subscriptionsParent'
      || element.kind === 'collectionsParent'
      || element.kind === 'peerListing'
      || element.kind === 'queryEditor') {
      return dbNode;
    }
    if (element.kind === 'subscription') {
      return { kind: 'subscriptionsParent', databaseId: element.databaseId };
    }
    if (element.kind === 'collection') {
      return { kind: 'collectionsParent', databaseId: element.databaseId };
    }
    if (element.kind === 'index') {
      const collection = this.collections?.current().find(c => c.name === element.collectionName);
      if (!collection) { return undefined; }
      return { kind: 'collection', databaseId: element.databaseId, collection };
    }
    if (element.kind === 'indexField') {
      const collection = this.collections?.current().find(c => c.name === element.collectionName);
      if (!collection) { return undefined; }
      const index = collection.indexes.find(i => i.id === element.indexId);
      if (!index) { return undefined; }
      return { kind: 'index', databaseId: element.databaseId, collectionName: element.collectionName, index };
    }
    return undefined;
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

        const ls = this.lifecycleFor?.();
        let transitionLabel: string | undefined;
        if (ls) {
          if (ls.kind === 'connecting' && ls.targetConfigId === node.config.id) transitionLabel = 'connecting…';
          else if (ls.kind === 'switching' && ls.toConfigId === node.config.id) transitionLabel = 'switching to…';
          else if (ls.kind === 'switching' && ls.fromConfigId === node.config.id) transitionLabel = 'switching from…';
          else if (ls.kind === 'disconnecting' && ls.configId === node.config.id) transitionLabel = 'disconnecting…';
        }
        if (transitionLabel) {
          item.iconPath = new vscode.ThemeIcon('sync~spin');
          item.description = `${transitionLabel} · ${node.config.databaseId.slice(0, 6)}…`;
          item.contextValue = 'database.transitioning';
          item.command = undefined;
        }
        return item;
      }
      case 'sectionHeader': {
        // Non-clickable, dimmed row used to visually group the data-related
        // children (Subscriptions, future Collections) apart from the
        // feature shortcuts (Peer Listing, Query Editor) below.
        const item = new vscode.TreeItem(node.label.toUpperCase(), vscode.TreeItemCollapsibleState.None);
        item.description = '─';
        item.contextValue = 'sectionHeader';
        item.id = `section.${node.databaseId}.${node.id}`;
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
      case 'collectionsParent': {
        const item = new vscode.TreeItem('Collections', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'collectionsParent';
        item.id = `cols.${node.databaseId}`;
        return item;
      }
      case 'collection': {
        const hasIndexes = node.collection.indexes.length > 0;
        const item = new vscode.TreeItem(
          node.collection.name,
          hasIndexes ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('book');
        item.description = node.collection.documentCount?.toString() ?? '';
        item.contextValue = 'collection';
        item.id = `col.${node.databaseId}.${node.collection.name}`;
        item.command = {
          command: 'dittoVsce.queryAllInCollection',
          title: 'SELECT * FROM …',
          arguments: [node.databaseId, node.collection.name],
        };
        return item;
      }
      case 'index': {
        const hasFields = node.index.fields.length > 0;
        const item = new vscode.TreeItem(
          node.index.displayName,
          hasFields ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'index';
        item.id = `idx.${node.databaseId}.${node.collectionName}.${node.index.id}`;
        return item;
      }
      case 'indexField': {
        const item = new vscode.TreeItem(node.field, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.contextValue = 'indexField';
        item.id = `idxF.${node.databaseId}.${node.collectionName}.${node.indexId}.${node.field}`;
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
