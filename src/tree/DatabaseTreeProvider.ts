import * as vscode from 'vscode';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { DatabaseTreeNode } from './DatabaseTreeItem.js';
import type { LifecycleState } from '../ditto/lifecycle-state.js';
import type { DittoCollection } from '../models/DittoCollection.js';

/**
 * Build a `TreeItemLabel` whose count portion is wrapped in
 * `TreeItemLabel.highlights`. VS Code renders highlighted ranges with
 * the editor's match-highlight background — the closest TreeView
 * affordance to a "chip" — so the count reads as a styled pill at the
 * end of the label.
 *
 * The label is a single nbsp-padded string (`<text> <count>`) so
 * the highlight has visible padding on the left of the number,
 * approximating chip whitespace. Counts are formatted with locale
 * thousands separators because the previous 2-char badge cap forced
 * truncation for collections in the hundreds/thousands.
 */
function labelWithCountChip(text: string, count: number): vscode.TreeItemLabel {
  const formatted = count.toLocaleString();
  // Surround the count with figure spaces (U+2007) so the highlighted
  // pill has padding on both sides, and the result still copies as a
  // plain readable string ("Documents  247  ").
  const FIG = ' ';
  const chip = `${FIG}${formatted}${FIG}`;
  const label = `${text} ${chip}`;
  const start = label.length - chip.length;
  const end = label.length;
  return { label, highlights: [[start, end]] };
}

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
      // Wrap the data + feature children inside a single `databaseDetails`
      // node (label "<databaseId> - <mode>") so the tree mirrors MongoDB's
      // "Connection → Database → ..." shape: the outer row is the friendly
      // connection name, the inner row exposes the technical details.
      return [{ kind: 'databaseDetails', config: node.config }];
    }
    if (node.kind === 'databaseDetails') {
      const dbId = node.config.id;
      // Collections list inline (no "Collections" wrapper) so the tree
      // mirrors MongoDB's "Database → Collection → ..." shape — the
      // wrapper added a click without surfacing anything new.
      const collectionRows = (this.collections?.current() ?? []).map(c => ({
        kind: 'collection' as const,
        databaseId: dbId,
        collection: c,
      }));
      return [
        { kind: 'subscriptionsParent', databaseId: dbId },
        ...collectionRows,
        // Blank divider visually separates the data drill-ins above from the
        // feature shortcuts below (rendered as a thin rule, no label).
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
    if (node.kind === 'subscription') {
      // Show the full DQL text as a child leaf — putting it in the
      // description truncates with "…" for long queries, which makes
      // long subscriptions unreadable. The chevron lets the user choose
      // whether to see the body.
      return [{ kind: 'subscriptionQuery', databaseId: node.databaseId, sub: node.sub }];
    }
    if (node.kind === 'collection') {
      // Collections expand to a Documents leaf (right-click → query
      // editor) and an Indexes parent that owns the index drill-ins.
      // The "Documents" leaf intentionally has no further children —
      // it's the entry point to the actual data view.
      return [
        { kind: 'documentsLeaf', databaseId: node.databaseId, collection: node.collection },
        { kind: 'indexesParent', databaseId: node.databaseId, collection: node.collection },
      ];
    }
    if (node.kind === 'indexesParent') {
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
    if (element.kind === 'databaseDetails') {
      return { kind: 'database', config: element.config, status: this.statusFor(element.config.id) };
    }
    const config = this.configs.list().find(c => c.id === element.databaseId);
    if (!config) { return undefined; }
    if (element.kind === 'sectionHeader'
      || element.kind === 'subscriptionsParent'
      || element.kind === 'collection'
      || element.kind === 'peerListing'
      || element.kind === 'queryEditor') {
      return { kind: 'databaseDetails', config };
    }
    if (element.kind === 'subscription') {
      return { kind: 'subscriptionsParent', databaseId: element.databaseId };
    }
    if (element.kind === 'subscriptionQuery') {
      return { kind: 'subscription', databaseId: element.databaseId, sub: element.sub };
    }
    if (element.kind === 'documentsLeaf' || element.kind === 'indexesParent') {
      return { kind: 'collection', databaseId: element.databaseId, collection: element.collection };
    }
    if (element.kind === 'index') {
      const collection = this.collections?.current().find(c => c.name === element.collectionName);
      if (!collection) { return undefined; }
      return { kind: 'indexesParent', databaseId: element.databaseId, collection };
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
        const item = new vscode.TreeItem(
          node.config.name || '(unnamed)',
          node.status === 'active'
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );
        // Match MongoDB's connection-row look: a status-colored circle, the
        // friendly connection name, and "connected" only when active. The
        // technical mode + databaseId have moved into the inner
        // `databaseDetails` row so the top-level row stays scannable.
        item.iconPath = node.status === 'active'
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
          : node.status === 'error'
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
            : new vscode.ThemeIcon('circle-outline');
        item.description = node.status === 'active' ? 'connected' : undefined;
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
          item.description = transitionLabel;
          item.contextValue = 'database.transitioning';
          item.command = undefined;
        }
        return item;
      }
      case 'databaseDetails': {
        // Inner "database" row that mirrors MongoDB's "Connection → Database"
        // shape. Label is `<databaseId> - <mode>` so operators can read off
        // the technical identity while the outer row keeps the friendly name.
        const mode = node.config.mode === 'server' ? 'Server' : 'SmallPeers';
        const item = new vscode.TreeItem(
          `${node.config.databaseId} - ${mode}`,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'databaseDetails';
        item.tooltip = `${node.config.databaseId} (${mode})`;
        item.id = `dbDetails.${node.config.id}`;
        return item;
      }
      case 'sectionHeader': {
        // Non-clickable, dimmed row used to visually group children. The
        // 'features' section gets an empty label (just a thin rule) so the
        // shortcut rows below read as their own group without a heading.
        const showLabel = node.id !== 'features';
        const item = new vscode.TreeItem(
          showLabel ? node.label.toUpperCase() : '',
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = showLabel ? '─' : '─────';
        item.contextValue = 'sectionHeader';
        item.id = `section.${node.databaseId}.${node.id}`;
        return item;
      }
      case 'subscriptionsParent': {
        const count = this.subs.list(node.databaseId).length;
        const item = new vscode.TreeItem(
          count > 0 ? labelWithCountChip('Subscriptions', count) : 'Subscriptions',
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('sync');
        item.contextValue = 'subscriptionsParent';
        item.id = `subs.${node.databaseId}`;
        return item;
      }
      case 'subscription': {
        const item = new vscode.TreeItem(node.sub.name, vscode.TreeItemCollapsibleState.Collapsed);
        // pulse reads as "actively syncing data" — a wavy heartbeat-like
        // line, distinct from the parent Subscriptions row's circular
        // `sync` icon.
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.sub.query, 'sql');
        item.contextValue = 'subscription';
        item.id = `sub.${node.databaseId}.${node.sub.id}`;
        // Single-click on the row's label opens the editor; clicking the
        // chevron expands to show the full query text instead. (VS Code
        // tree-views don't fire on double-click — single-click is the
        // closest equivalent for "open detail view".)
        item.command = {
          command: 'dittoVsce.editSubscription',
          title: 'Edit Subscription',
          arguments: [node],
        };
        return item;
      }
      case 'subscriptionQuery': {
        // Body row that shows the full DQL text — no truncation, no
        // command, no further drill-in. Tooltip duplicates the body so
        // hover-over also reveals it inline.
        const item = new vscode.TreeItem(node.sub.query, vscode.TreeItemCollapsibleState.None);
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.sub.query, 'sql');
        item.contextValue = 'subscriptionQuery';
        item.id = `subQ.${node.databaseId}.${node.sub.id}`;
        return item;
      }
      case 'collection': {
        // Collections always Collapsible — even with zero indexes, the
        // Documents leaf is always present underneath, so the chevron is
        // always meaningful.
        const item = new vscode.TreeItem(node.collection.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'collection';
        item.id = `col.${node.databaseId}.${node.collection.name}`;
        // No description (drops the doc-count chip — the count now lives on
        // the Documents leaf instead) and no `command` so single-click on
        // the row label expands instead of running a query.
        return item;
      }
      case 'documentsLeaf': {
        const docCount = node.collection.documentCount;
        const item = new vscode.TreeItem(
          docCount !== undefined && docCount > 0
            ? labelWithCountChip('Documents', docCount)
            : 'Documents',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('note');
        item.contextValue = 'documentsLeaf';
        item.id = `docs.${node.databaseId}.${node.collection.name}`;
        // Single-click opens the Query Editor with `SELECT * FROM <coll>`,
        // matching MongoDB's "click Documents to view them" affordance.
        item.command = {
          command: 'dittoVsce.queryAllInCollection',
          title: 'SELECT * FROM …',
          arguments: [node.databaseId, node.collection.name],
        };
        return item;
      }
      case 'indexesParent': {
        const count = node.collection.indexes.length;
        const item = new vscode.TreeItem(
          count > 0 ? labelWithCountChip('Indexes', count) : 'Indexes',
          count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('key');
        item.contextValue = 'indexesParent';
        item.id = `idxs.${node.databaseId}.${node.collection.name}`;
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
        const item = new vscode.TreeItem('Presence');
        item.iconPath = new vscode.ThemeIcon('broadcast');
        item.contextValue = 'peerListing';
        item.id = `peers.${node.databaseId}`;
        item.command = { command: 'dittoVsce.openPeerListing', title: 'Open Presence', arguments: [node.databaseId] };
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
