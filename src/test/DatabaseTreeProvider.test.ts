import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ConfigStore } from '../storage/ConfigStore.js';
import { DatabaseTreeProvider, type CollectionsSource, type DatabaseStatus } from '../tree/DatabaseTreeProvider.js';
import type { DatabaseTreeNode } from '../tree/DatabaseTreeItem.js';
import type { LifecycleState } from '../ditto/lifecycle-state.js';
import type { DittoCollection } from '../models/DittoCollection.js';
import { newConfig } from '../models/DittoConfig.js';
import { SubscriptionStore } from '../storage/SubscriptionStore.js';
import { ObserverStore } from '../storage/ObserverStore.js';

class FakeMemento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.map.delete(key); } else { this.map.set(key, value); }
  }
  keys(): readonly string[] { return [...this.map.keys()]; }
}

function makeStore(): ConfigStore { return new ConfigStore(new FakeMemento()); }
function emptySubs(): SubscriptionStore { return new SubscriptionStore(new FakeMemento()); }
function emptyObservers(): ObserverStore { return new ObserverStore(new FakeMemento()); }

test('getRootChildren returns [] when no configs', async () => {
  const cfg = makeStore();
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs(), emptyObservers());
  assert.deepEqual(await provider.getRootChildren(), []);
});

test('getRootChildren returns one database node per stored config (idle by default)', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs(), emptyObservers());
  const roots = await provider.getRootChildren();
  assert.equal(roots.length, 2);
  assert.equal(roots[0]?.kind, 'database');
  assert.equal(roots[0]?.kind === 'database' && roots[0].status, 'idle');
  assert.equal(roots[1]?.kind === 'database' && roots[1].config.name, 'B');
});

test('idle database has no children', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs(), emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children, []);
});

test('active database has a single databaseDetails wrapper child', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', emptySubs(), emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const children = await provider.getNodeChildren(root);
  assert.deepEqual(children.map(c => c.kind), ['databaseDetails']);
});

test('databaseDetails expands to subs + inline collections + section + peers + query', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const collections = {
    current: () => [
      { name: 'tasks', documentCount: 3, indexes: [] },
      { name: 'users', documentCount: 7, indexes: [] },
    ],
    onChange: () => ({ dispose: () => {} }),
  };
  const provider = new DatabaseTreeProvider(
    cfg, () => 'active', emptySubs(), emptyObservers(), undefined, collections as any,
  );
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const grandchildren = await provider.getNodeChildren(details);
  // Collections render directly between Subscriptions and the features
  // divider — no "Collections" wrapper any more.
  assert.deepEqual(grandchildren.map(c => c.kind), [
    'subscriptionsParent',
    'collection',
    'collection',
    'observersParent',
    'sectionHeader',
    'peerListing',
    'queryEditor',
    'queryMetrics',
    'databaseMetrics',
    'systemMetrics',
    'logAnalyzer',
    // Second blank-rule divider, then the Import Data bulk action.
    'sectionHeader',
    'importData',
  ]);
});

test('collection expands to documentsLeaf + indexesParent', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const collections = {
    current: () => [{ name: 'tasks', documentCount: 3, indexes: [] }],
    onChange: () => ({ dispose: () => {} }),
  };
  const provider = new DatabaseTreeProvider(
    cfg, () => 'active', emptySubs(), emptyObservers(), undefined, collections as any,
  );
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const dbChildren = await provider.getNodeChildren(details);
  const collection = dbChildren.find(n => n.kind === 'collection')!;
  const leaves = await provider.getNodeChildren(collection);
  assert.deepEqual(leaves.map(n => n.kind), ['documentsLeaf', 'indexesParent']);
});

test('indexesParent expands to one index node per declared index', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const collections = {
    current: () => [{
      name: 'tasks',
      documentCount: 3,
      indexes: [{ id: 'idx1', displayName: 'by_due', fields: ['dueDate'] }],
    }],
    onChange: () => ({ dispose: () => {} }),
  };
  const provider = new DatabaseTreeProvider(
    cfg, () => 'active', emptySubs(), emptyObservers(), undefined, collections as any,
  );
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const dbChildren = await provider.getNodeChildren(details);
  const collection = dbChildren.find(n => n.kind === 'collection')!;
  const collChildren = await provider.getNodeChildren(collection);
  const indexes = collChildren.find(n => n.kind === 'indexesParent')!;
  const idxNodes = await provider.getNodeChildren(indexes);
  assert.equal(idxNodes.length, 1);
  assert.equal(idxNodes[0]?.kind, 'index');
  assert.equal(idxNodes[0]?.kind === 'index' && idxNodes[0].index.displayName, 'by_due');
});

test('Subscriptions parent expands to leaves from SubscriptionStore', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const subs = new SubscriptionStore(new FakeMemento());
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', subs, emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const dbChildren = await provider.getNodeChildren(details);
  const subsParent = dbChildren.find(n => n.kind === 'subscriptionsParent')!;
  const leaves = await provider.getNodeChildren(subsParent);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0]?.kind, 'subscription');
  assert.equal(leaves[0]?.kind === 'subscription' && leaves[0].sub.name, 'tasks-all');
});

test('Subscription expands to a single subscriptionQuery leaf carrying the full DQL', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  const subs = new SubscriptionStore(new FakeMemento());
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks WHERE done = false' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', subs, emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const dbChildren = await provider.getNodeChildren(details);
  const subsParent = dbChildren.find(n => n.kind === 'subscriptionsParent')!;
  const [sub] = await provider.getNodeChildren(subsParent);
  assert.ok(sub);
  const queryLeaves = await provider.getNodeChildren(sub);
  assert.equal(queryLeaves.length, 1);
  assert.equal(queryLeaves[0]?.kind, 'subscriptionQuery');
  assert.equal(
    queryLeaves[0]?.kind === 'subscriptionQuery' && queryLeaves[0].sub.query,
    'SELECT * FROM tasks WHERE done = false',
  );
});

// ─── shared helpers for the rendering/structure suites ────────

function collectionsSource(list: DittoCollection[]) {
  const emitter = new vscode.EventEmitter<DittoCollection[]>();
  let current = list;
  const source: CollectionsSource = {
    current: () => current,
    onChange: emitter.event,
  };
  return {
    source,
    fire(next: DittoCollection[]) { current = next; emitter.fire(next); },
  };
}

function coll(name: string, over: Partial<DittoCollection> = {}): DittoCollection {
  return { _id: name, name, indexes: [], ...over };
}

function iconOf(item: vscode.TreeItem): { id: string | undefined; colorId: string | undefined } {
  const icon = item.iconPath as { id?: string; color?: { id?: string } } | undefined;
  return { id: icon?.id, colorId: icon?.color?.id };
}

/** The chip renders `<text> <FIG>count<FIG>` with the count span highlighted. */
function assertChipLabel(label: unknown, text: string, count: string): void {
  assert.equal(typeof label, 'object', `expected a TreeItemLabel chip for ${text}`);
  const chip = label as vscode.TreeItemLabel;
  assert.ok(chip.label.startsWith(`${text} `), `chip label starts with the row text: ${chip.label}`);
  assert.equal(chip.highlights?.length, 1, 'exactly one highlighted range');
  const hl = chip.highlights?.[0];
  assert.ok(hl, 'highlight range present');
  const [start, end] = hl;
  assert.equal(end, chip.label.length, 'highlight runs to the end of the label');
  assert.equal(chip.label.slice(start, end).trim(), count, 'highlight covers exactly the count');
}

const ACTIVE = 'active' as const;

/** One-config store + provider whose single root row is expanded (active). */
async function activeWorld(opts: {
  statusFor?: (id: string) => DatabaseStatus;
  subs?: SubscriptionStore;
  observers?: ObserverStore;
  lifecycle?: () => LifecycleState;
  collections?: CollectionsSource;
} = {}) {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'Alpha', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(
    cfg,
    opts.statusFor ?? (() => ACTIVE),
    opts.subs ?? emptySubs(),
    opts.observers ?? emptyObservers(),
    opts.lifecycle,
    opts.collections,
  );
  return { cfg, provider };
}

// ─── getChildren routing ───────────────────────────────────────

test('getChildren with no element returns roots; with an element returns its children', async () => {
  const { provider } = await activeWorld();
  const roots = await provider.getChildren();
  assert.equal(roots.length, 1);
  const root = roots[0];
  assert.ok(root);
  assert.equal(root.kind, 'database');
  const children = await provider.getChildren(root);
  assert.deepEqual(children.map(c => c.kind), ['databaseDetails']);
});

test('a database row only expands when active', async () => {
  for (const status of ['idle', 'activating', 'error'] as const) {
    const { provider } = await activeWorld({ statusFor: () => status });
    const [root] = await provider.getRootChildren();
    assert.ok(root);
    assert.deepEqual(await provider.getNodeChildren(root), [], `${status} database must not expand`);
  }
});

test('statusFor is consulted per config', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  const statuses: Record<string, DatabaseStatus> = { '1': 'error', '2': 'active' };
  const provider = new DatabaseTreeProvider(cfg, id => statuses[id] ?? 'idle', emptySubs(), emptyObservers());
  const roots = await provider.getRootChildren();
  assert.deepEqual(
    roots.map(r => (r.kind === 'database' ? r.status : '?')),
    ['error', 'active'],
  );
});

// ─── database row rendering ────────────────────────────────────

test('getTreeItem(database): idle row renders an outline circle with a connect command', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'Alpha', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs(), emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.equal(item.label, 'Alpha');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(item), { id: 'circle-outline', colorId: undefined });
  assert.equal(item.contextValue, 'database.idle');
  assert.equal(item.description, undefined, 'no "connected" description while idle');
  assert.equal(item.tooltip, 'Alpha');
  assert.equal(item.id, 'db.1');
  assert.equal(item.command?.command, 'dittoVsce.connect');
  assert.deepEqual(item.command?.arguments, [root]);
});

test('getTreeItem(database): active row renders a green filled circle, expanded, no command', async () => {
  const { provider } = await activeWorld();
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.deepEqual(iconOf(item), { id: 'circle-filled', colorId: 'charts.green' });
  assert.equal(item.contextValue, 'database.active');
  assert.equal(item.description, 'connected');
  assert.equal(item.command, undefined, 'an active connection is not clickable-to-connect');
});

test('getTreeItem(database): error row renders a red error icon and keeps the connect command', async () => {
  const { provider } = await activeWorld({ statusFor: () => 'error' });
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.deepEqual(iconOf(item), { id: 'error', colorId: 'charts.red' });
  assert.equal(item.contextValue, 'database.error');
  assert.equal(item.command?.command, 'dittoVsce.connect');
});

test('getTreeItem(database): activating row renders an outline circle with no command', async () => {
  const { provider } = await activeWorld({ statusFor: () => 'activating' });
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.deepEqual(iconOf(item), { id: 'circle-outline', colorId: undefined });
  assert.equal(item.contextValue, 'database.activating');
  assert.equal(item.command, undefined, 'no connect click while a connect is in flight');
});

test('getTreeItem(database): an empty config name falls back to "(unnamed)"', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: '', databaseId: 'dbA' });
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', emptySubs(), emptyObservers());
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.equal(item.label, '(unnamed)');
  assert.equal(item.tooltip, '');
});

test('getTreeItem(database): lifecycle transitions override icon, description, contextValue and command', async () => {
  const cases: Array<[LifecycleState, string]> = [
    [{ kind: 'connecting', targetConfigId: '1' }, 'connecting…'],
    [{ kind: 'switching', fromConfigId: '9', toConfigId: '1' }, 'switching to…'],
    [{ kind: 'switching', fromConfigId: '1', toConfigId: '9' }, 'switching from…'],
    [{ kind: 'disconnecting', configId: '1' }, 'disconnecting…'],
  ];
  for (const [state, label] of cases) {
    const { provider } = await activeWorld({ lifecycle: () => state });
    const [root] = await provider.getRootChildren();
    assert.ok(root);
    const item = provider.getTreeItem(root);
    assert.equal(item.description, label, `${state.kind} description`);
    assert.deepEqual(iconOf(item), { id: 'sync~spin', colorId: undefined }, `${state.kind} spinner`);
    assert.equal(item.contextValue, 'database.transitioning');
    assert.equal(item.command, undefined, `${state.kind} strips the connect command`);
  }
});

test('getTreeItem(database): a lifecycle state targeting another config does not mark this row', async () => {
  const { provider } = await activeWorld({
    statusFor: () => 'idle',
    lifecycle: () => ({ kind: 'connecting', targetConfigId: 'someone-else' }),
  });
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const item = provider.getTreeItem(root);
  assert.equal(item.contextValue, 'database.idle');
  assert.equal(item.description, undefined);
  assert.equal(item.command?.command, 'dittoVsce.connect');
});

// ─── databaseDetails / section headers ─────────────────────────

test('getTreeItem(databaseDetails): server and smallPeersOnly modes render the technical identity', async () => {
  const cfg = makeStore();
  await cfg.save({ ...newConfig(), id: '1', name: 'Alpha', databaseId: 'dbA', mode: 'server' });
  await cfg.save({ ...newConfig(), id: '2', name: 'Beta', databaseId: 'dbB', mode: 'smallPeersOnly' });
  const provider = new DatabaseTreeProvider(cfg, () => 'active', emptySubs(), emptyObservers());

  const server = provider.getTreeItem({ kind: 'databaseDetails', config: cfg.get('1')! });
  assert.equal(server.label, 'dbA - Server');
  assert.equal(server.tooltip, 'dbA (Server)');
  assert.equal(server.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.deepEqual(iconOf(server), { id: 'database', colorId: undefined });
  assert.equal(server.contextValue, 'databaseDetails');
  assert.equal(server.id, 'dbDetails.1');

  const smallPeers = provider.getTreeItem({ kind: 'databaseDetails', config: cfg.get('2')! });
  assert.equal(smallPeers.label, 'dbB - SmallPeers');
  assert.equal(smallPeers.tooltip, 'dbB (SmallPeers)');
  assert.equal(smallPeers.id, 'dbDetails.2');
});

test('getTreeItem(sectionHeader): known groups render as a blank rule, custom ids as an uppercased label', async () => {
  const { provider } = await activeWorld();
  for (const id of ['features', 'importGroup'] as const) {
    const item = provider.getTreeItem({ kind: 'sectionHeader', databaseId: '1', id, label: 'X' });
    assert.equal(item.label, '', `${id} has no visible label`);
    assert.equal(item.description, '─────', `${id} renders the long rule`);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(item.contextValue, 'sectionHeader');
    assert.equal(item.id, `section.1.${id}`);
  }
  // A future section id renders its label rather than a blank rule.
  const custom = provider.getTreeItem({
    kind: 'sectionHeader', databaseId: '1', id: 'data' as never, label: 'Data',
  });
  assert.equal(custom.label, 'DATA');
  assert.equal(custom.description, '─', 'labelled sections get the short rule');
});

// ─── subscriptions / observers rendering ───────────────────────

test('getTreeItem(subscriptionsParent): count chip appears only with subscriptions', async () => {
  const subs = new SubscriptionStore(new FakeMemento());
  await subs.save('1', { id: 's1', name: 'one', query: 'SELECT * FROM a' });
  await subs.save('1', { id: 's2', name: 'two', query: 'SELECT * FROM b' });
  const { provider } = await activeWorld({ subs });

  const item = provider.getTreeItem({ kind: 'subscriptionsParent', databaseId: '1' });
  assertChipLabel(item.label, 'Subscriptions', '2');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
  assert.deepEqual(iconOf(item), { id: 'sync', colorId: undefined });
  assert.equal(item.contextValue, 'subscriptionsParent');
  assert.equal(item.id, 'subs.1');

  const empty = provider.getTreeItem({ kind: 'subscriptionsParent', databaseId: 'nobody' });
  assert.equal(empty.label, 'Subscriptions', 'no chip when the store is empty');
});

test('getTreeItem(subscription): row opens the editor on click and shows the query on hover', async () => {
  const { provider } = await activeWorld();
  const node: DatabaseTreeNode = {
    kind: 'subscription', databaseId: '1',
    sub: { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks' },
  };
  const item = provider.getTreeItem(node);
  assert.equal(item.label, 'tasks-all');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.deepEqual(iconOf(item), { id: 'pulse', colorId: undefined });
  assert.equal(item.contextValue, 'subscription');
  assert.equal(item.id, 'sub.1.s1');
  assert.equal(item.command?.command, 'dittoVsce.editSubscription');
  assert.deepEqual(item.command?.arguments, [node]);
  assert.ok(item.tooltip, 'query markdown tooltip present');
});

test('getTreeItem(subscriptionQuery): full DQL body leaf with no command', async () => {
  const { provider } = await activeWorld();
  const node: DatabaseTreeNode = {
    kind: 'subscriptionQuery', databaseId: '1',
    sub: { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks WHERE done = false' },
  };
  const item = provider.getTreeItem(node);
  assert.equal(item.label, 'SELECT * FROM tasks WHERE done = false');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(item), { id: 'code', colorId: undefined });
  assert.equal(item.contextValue, 'subscriptionQuery');
  assert.equal(item.id, 'subQ.1.s1');
  assert.equal(item.command, undefined);
  assert.ok(item.tooltip);
});

test('getTreeItem(observersParent + observer + observerQuery): icons, ids and commands', async () => {
  const observers = new ObserverStore(new FakeMemento());
  await observers.save('1', { id: 'o1', name: 'watch tasks', query: 'SELECT * FROM tasks' });
  const { provider } = await activeWorld({ observers });

  const parent = provider.getTreeItem({ kind: 'observersParent', databaseId: '1' });
  assertChipLabel(parent.label, 'Observers', '1');
  assert.equal(parent.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.deepEqual(iconOf(parent), { id: 'eye', colorId: undefined });
  assert.equal(parent.contextValue, 'observersParent');
  assert.equal(parent.id, 'obs.1');

  const empty = provider.getTreeItem({ kind: 'observersParent', databaseId: 'nobody' });
  assert.equal(empty.label, 'Observers');

  const node: DatabaseTreeNode = {
    kind: 'observer', databaseId: '1',
    observer: { id: 'o1', name: 'watch tasks', query: 'SELECT * FROM tasks' },
  };
  const obs = provider.getTreeItem(node);
  assert.equal(obs.label, 'watch tasks');
  assert.equal(obs.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(obs.contextValue, 'observer');
  assert.equal(obs.id, 'obs.1.o1');
  assert.equal(obs.command?.command, 'dittoVsce.openObserver');
  assert.deepEqual(obs.command?.arguments, [node]);

  const query = provider.getTreeItem({
    kind: 'observerQuery', databaseId: '1',
    observer: { id: 'o1', name: 'watch tasks', query: 'SELECT * FROM tasks' },
  });
  assert.equal(query.label, 'SELECT * FROM tasks');
  assert.equal(query.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(query), { id: 'note', colorId: undefined });
  assert.equal(query.contextValue, 'observerQuery');
  assert.equal(query.id, 'obsQ.1.o1');
  assert.equal(query.tooltip, 'SELECT * FROM tasks');
  assert.equal(query.command, undefined);
});

test('observersParent expands to stored observers, observer expands to its query leaf', async () => {
  const observers = new ObserverStore(new FakeMemento());
  await observers.save('1', { id: 'o1', name: 'watch tasks', query: 'SELECT * FROM tasks' });
  await observers.save('1', { id: 'o2', name: 'watch users', query: 'SELECT * FROM users' });
  const { provider } = await activeWorld({ observers });

  const rows = await provider.getNodeChildren({ kind: 'observersParent', databaseId: '1' });
  assert.deepEqual(rows.map(r => r.kind), ['observer', 'observer']);
  assert.deepEqual(
    rows.map(r => (r.kind === 'observer' ? r.observer.name : '?')),
    ['watch tasks', 'watch users'],
  );

  const leaves = await provider.getNodeChildren(rows[0]!);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0]?.kind, 'observerQuery');
  assert.equal(
    leaves[0]?.kind === 'observerQuery' && leaves[0].observer.query,
    'SELECT * FROM tasks',
  );
});

// ─── collections / indexes rendering ───────────────────────────

test('getTreeItem(collection): collapsed folder row with no command and no count chip', async () => {
  const { provider } = await activeWorld();
  const item = provider.getTreeItem({ kind: 'collection', databaseId: '1', collection: coll('tasks', { documentCount: 5 }) });
  assert.equal(item.label, 'tasks');
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.deepEqual(iconOf(item), { id: 'folder', colorId: undefined });
  assert.equal(item.contextValue, 'collection');
  assert.equal(item.id, 'col.1.tasks');
  assert.equal(item.command, undefined, 'single-click expands rather than querying');
  assert.equal(item.description, undefined, 'the doc count lives on the Documents leaf');
});

test('getTreeItem(documentsLeaf): count chip only for a positive count, always queries on click', async () => {
  const { provider } = await activeWorld();

  const withDocs = provider.getTreeItem({ kind: 'documentsLeaf', databaseId: '1', collection: coll('tasks', { documentCount: 247 }) });
  assertChipLabel(withDocs.label, 'Documents', '247');
  assert.equal(withDocs.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(withDocs), { id: 'note', colorId: undefined });
  assert.equal(withDocs.contextValue, 'documentsLeaf');
  assert.equal(withDocs.id, 'docs.1.tasks');
  assert.equal(withDocs.command?.command, 'dittoVsce.queryAllInCollection');
  assert.deepEqual(withDocs.command?.arguments, ['1', 'tasks']);

  for (const documentCount of [0, undefined] as const) {
    const collection = documentCount === undefined ? coll('tasks') : coll('tasks', { documentCount });
    const item = provider.getTreeItem({ kind: 'documentsLeaf', databaseId: '1', collection });
    assert.equal(item.label, 'Documents', `no chip for documentCount=${documentCount}`);
  }
});

test('getTreeItem(indexesParent): empty stays a plain leaf, non-empty gets a chip and a chevron', async () => {
  const { provider } = await activeWorld();
  const empty = provider.getTreeItem({ kind: 'indexesParent', databaseId: '1', collection: coll('tasks') });
  assert.equal(empty.label, 'Indexes');
  assert.equal(empty.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(empty), { id: 'key', colorId: undefined });
  assert.equal(empty.contextValue, 'indexesParent');
  assert.equal(empty.id, 'idxs.1.tasks');

  const withIndexes = provider.getTreeItem({
    kind: 'indexesParent', databaseId: '1',
    collection: coll('tasks', {
      indexes: [
        { id: 'tasks.a', collection: 'tasks', displayName: 'a', fields: [{ name: 'a', ascending: true }] },
        { id: 'tasks.b', collection: 'tasks', displayName: 'b', fields: [{ name: 'b', ascending: false }] },
      ],
    }),
  });
  assertChipLabel(withIndexes.label, 'Indexes', '2');
  assert.equal(withIndexes.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
});

test('getTreeItem(index): composite keys are described inline, single keys are not prefixed', async () => {
  const { provider } = await activeWorld();
  const composite = provider.getTreeItem({
    kind: 'index', databaseId: '1', collectionName: 'tasks',
    index: {
      id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due',
      fields: [{ name: 'dueDate', ascending: true }, { name: 'createdAt', ascending: false }],
    },
  });
  assert.equal(composite.label, 'by_due');
  assert.equal(composite.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.deepEqual(iconOf(composite), { id: 'symbol-namespace', colorId: undefined });
  assert.equal(composite.contextValue, 'index');
  assert.equal(composite.description, 'dueDate ASC, createdAt DESC');
  assert.equal(composite.tooltip, 'Composite index: dueDate ASC, createdAt DESC');
  assert.equal(composite.id, 'idx.1.tasks.tasks.by_due');

  const single = provider.getTreeItem({
    kind: 'index', databaseId: '1', collectionName: 'tasks',
    index: { id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [{ name: 'dueDate', ascending: true }] },
  });
  assert.equal(single.description, 'dueDate ASC');
  assert.equal(single.tooltip, 'dueDate ASC', 'no "Composite" prefix for a single key');
  assert.equal(single.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

  const fieldless = provider.getTreeItem({
    kind: 'index', databaseId: '1', collectionName: 'tasks',
    index: { id: 'tasks.empty', collection: 'tasks', displayName: 'empty', fields: [] },
  });
  assert.equal(fieldless.collapsibleState, vscode.TreeItemCollapsibleState.None, 'nothing to expand');
  assert.equal(fieldless.description, '');
});

test('getTreeItem(indexField): direction rides in the description', async () => {
  const { provider } = await activeWorld();
  const asc = provider.getTreeItem({
    kind: 'indexField', databaseId: '1', collectionName: 'tasks', indexId: 'tasks.by_due',
    field: { name: 'dueDate', ascending: true },
  });
  assert.equal(asc.label, 'dueDate');
  assert.equal(asc.description, 'ASC');
  assert.equal(asc.collapsibleState, vscode.TreeItemCollapsibleState.None);
  assert.deepEqual(iconOf(asc), { id: 'symbol-field', colorId: undefined });
  assert.equal(asc.contextValue, 'indexField');
  assert.equal(asc.id, 'idxF.1.tasks.tasks.by_due.dueDate');

  const desc = provider.getTreeItem({
    kind: 'indexField', databaseId: '1', collectionName: 'tasks', indexId: 'tasks.by_due',
    field: { name: 'createdAt', ascending: false },
  });
  assert.equal(desc.description, 'DESC');
});

test('an index node expands to its fields in declared order', async () => {
  const { provider } = await activeWorld();
  const fields = [
    { name: 'dueDate', ascending: true },
    { name: 'createdAt', ascending: false },
  ];
  const nodes = await provider.getNodeChildren({
    kind: 'index', databaseId: '1', collectionName: 'tasks',
    index: { id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields },
  });
  assert.deepEqual(nodes.map(n => n.kind), ['indexField', 'indexField']);
  assert.deepEqual(
    nodes.map(n => (n.kind === 'indexField' ? n.field.name : '?')),
    ['dueDate', 'createdAt'],
    'key order is significant to the optimizer — never re-sorted for display',
  );
});

test('leaf rows have no children', async () => {
  const { provider } = await activeWorld();
  const leaves: DatabaseTreeNode[] = [
    { kind: 'documentsLeaf', databaseId: '1', collection: coll('tasks') },
    { kind: 'indexField', databaseId: '1', collectionName: 'tasks', indexId: 'i', field: { name: 'f', ascending: true } },
    { kind: 'sectionHeader', databaseId: '1', id: 'features', label: 'Features' },
    { kind: 'peerListing', databaseId: '1' },
    { kind: 'subscriptionQuery', databaseId: '1', sub: { id: 's', name: 's', query: 'SELECT 1' } },
    { kind: 'observerQuery', databaseId: '1', observer: { id: 'o', name: 'o', query: 'SELECT 1' } },
    { kind: 'queryEditor', databaseId: '1' },
    { kind: 'importData', databaseId: '1' },
  ];
  for (const leaf of leaves) {
    assert.deepEqual(await provider.getNodeChildren(leaf), [], `${leaf.kind} must be a leaf`);
  }
});

// ─── feature-shortcut rows ─────────────────────────────────────

test('getTreeItem(feature rows): labels, icons, ids and commands are wired', async () => {
  const { provider } = await activeWorld();
  const cases: Array<[DatabaseTreeNode, string, string, string, string]> = [
    [{ kind: 'peerListing', databaseId: '1' }, 'Presence', 'broadcast', 'peers.1', 'dittoVsce.openPeerListing'],
    [{ kind: 'queryEditor', databaseId: '1' }, 'Query Editor', 'terminal', 'query.1', 'dittoVsce.openQueryEditor'],
    [{ kind: 'queryMetrics', databaseId: '1' }, 'Query Metrics', 'dashboard', 'qmetrics.1', 'dittoVsce.openQueryMetrics'],
    [{ kind: 'databaseMetrics', databaseId: '1' }, 'Database Metrics', 'pie-chart', 'dbmetrics.1', 'dittoVsce.openDatabaseMetrics'],
    [{ kind: 'systemMetrics', databaseId: '1' }, 'System Metrics', 'pulse', 'sysmetrics.1', 'dittoVsce.openSystemMetrics'],
    [{ kind: 'logAnalyzer', databaseId: '1' }, 'Log Analyzer', 'search', 'logAnalyzer.1', 'dittoVsce.openLogAnalyzer'],
    [{ kind: 'importData', databaseId: '1' }, 'Import Data', 'cloud-upload', 'importData.1', 'dittoVsce.openImportData'],
  ];
  for (const [node, label, icon, id, command] of cases) {
    const item = provider.getTreeItem(node);
    assert.equal(item.label, label, `${node.kind} label`);
    assert.deepEqual(iconOf(item), { id: icon, colorId: undefined }, `${node.kind} icon`);
    assert.equal(item.contextValue, node.kind);
    assert.equal(item.id, id, `${node.kind} id`);
    assert.equal(item.command?.command, command, `${node.kind} command`);
    assert.deepEqual(item.command?.arguments, ['1'], `${node.kind} passes the databaseId`);
  }
});

// ─── configuration-gated children ──────────────────────────────

test('the Query Metrics row is hidden when dittoVsce.collectMetrics is off', async () => {
  const ws = vscode.workspace as unknown as { configValues: Record<string, Record<string, unknown>> };
  ws.configValues = { dittoVsce: { collectMetrics: false } };
  try {
    const { provider } = await activeWorld();
    const [root] = await provider.getRootChildren();
    assert.ok(root);
    const [details] = await provider.getNodeChildren(root);
    assert.ok(details);
    const children = await provider.getNodeChildren(details);
    assert.ok(!children.some(c => c.kind === 'queryMetrics'), 'metrics row hidden by setting');
    assert.ok(children.some(c => c.kind === 'databaseMetrics'), 'other feature rows still present');
  } finally {
    ws.configValues = {};
  }
});

test('databaseDetails without a collections source renders no collection rows', async () => {
  const { provider } = await activeWorld(); // no collections passed
  const [root] = await provider.getRootChildren();
  assert.ok(root);
  const [details] = await provider.getNodeChildren(root);
  assert.ok(details);
  const children = await provider.getNodeChildren(details);
  assert.ok(!children.some(c => c.kind === 'collection'), 'collections list defaults to empty');
  assert.ok(children.some(c => c.kind === 'subscriptionsParent'));
});

// ─── getParent ─────────────────────────────────────────────────

test('getParent: database rows are roots', async () => {
  const { cfg, provider } = await activeWorld();
  assert.equal(provider.getParent({ kind: 'database', config: cfg.get('1')!, status: 'active' }), undefined);
});

test('getParent: databaseDetails resolves back to its database with the live status', async () => {
  const { cfg, provider } = await activeWorld({ statusFor: () => 'error' });
  const parent = provider.getParent({ kind: 'databaseDetails', config: cfg.get('1')! });
  assert.ok(parent);
  assert.equal(parent.kind, 'database');
  assert.equal(parent.kind === 'database' && parent.status, 'error', 'status is re-resolved, not remembered');
  assert.equal(parent.kind === 'database' && parent.config.id, '1');
});

test('getParent: first-level detail rows resolve to databaseDetails', async () => {
  const { provider } = await activeWorld();
  const rows: DatabaseTreeNode[] = [
    { kind: 'sectionHeader', databaseId: '1', id: 'features', label: 'Features' },
    { kind: 'subscriptionsParent', databaseId: '1' },
    { kind: 'observersParent', databaseId: '1' },
    { kind: 'collection', databaseId: '1', collection: coll('tasks') },
    { kind: 'peerListing', databaseId: '1' },
    { kind: 'queryEditor', databaseId: '1' },
    { kind: 'queryMetrics', databaseId: '1' },
    { kind: 'databaseMetrics', databaseId: '1' },
    { kind: 'systemMetrics', databaseId: '1' },
    { kind: 'logAnalyzer', databaseId: '1' },
    { kind: 'importData', databaseId: '1' },
  ];
  for (const row of rows) {
    const parent = provider.getParent(row);
    assert.equal(parent?.kind, 'databaseDetails', `${row.kind} → databaseDetails`);
    assert.equal(parent?.kind === 'databaseDetails' && parent.config.id, '1');
  }
});

test('getParent: rows for an unknown database resolve to undefined', async () => {
  const { provider } = await activeWorld();
  assert.equal(provider.getParent({ kind: 'queryEditor', databaseId: 'missing' }), undefined);
  assert.equal(provider.getParent({ kind: 'subscription', databaseId: 'missing', sub: { id: 's', name: 's', query: 'q' } }), undefined);
});

test('getParent: subscription and observer drill-ins resolve to their parents', async () => {
  const { provider } = await activeWorld();
  const sub = { id: 's1', name: 's', query: 'SELECT 1' };
  const observer = { id: 'o1', name: 'o', query: 'SELECT 1' };

  const subParent = provider.getParent({ kind: 'subscription', databaseId: '1', sub });
  assert.deepEqual(subParent, { kind: 'subscriptionsParent', databaseId: '1' });

  const subQParent = provider.getParent({ kind: 'subscriptionQuery', databaseId: '1', sub });
  assert.deepEqual(subQParent, { kind: 'subscription', databaseId: '1', sub });

  const obsParent = provider.getParent({ kind: 'observer', databaseId: '1', observer });
  assert.deepEqual(obsParent, { kind: 'observersParent', databaseId: '1' });

  const obsQParent = provider.getParent({ kind: 'observerQuery', databaseId: '1', observer });
  assert.deepEqual(obsQParent, { kind: 'observer', databaseId: '1', observer });
});

test('getParent: collection drill-ins resolve to their collection', async () => {
  const { provider } = await activeWorld();
  const collection = coll('tasks');
  for (const kind of ['documentsLeaf', 'indexesParent'] as const) {
    const parent = provider.getParent({ kind, databaseId: '1', collection });
    assert.deepEqual(parent, { kind: 'collection', databaseId: '1', collection }, `${kind} → collection`);
  }
});

test('getParent: index rows resolve through the live collections source', async () => {
  const { source } = collectionsSource([
    coll('tasks', {
      indexes: [{ id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [{ name: 'dueDate', ascending: true }] }],
    }),
  ]);
  const { provider } = await activeWorld({ collections: source });
  const index = { id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [{ name: 'dueDate', ascending: true }] };

  const idxParent = provider.getParent({ kind: 'index', databaseId: '1', collectionName: 'tasks', index });
  assert.equal(idxParent?.kind, 'indexesParent');
  assert.equal(idxParent?.kind === 'indexesParent' && idxParent.collection.name, 'tasks');

  const fieldParent = provider.getParent({
    kind: 'indexField', databaseId: '1', collectionName: 'tasks', indexId: 'tasks.by_due',
    field: { name: 'dueDate', ascending: true },
  });
  assert.equal(fieldParent?.kind, 'index');
  assert.equal(fieldParent?.kind === 'index' && fieldParent.index.id, 'tasks.by_due');
});

test('getParent: index rows with no matching collection or index resolve to undefined', async () => {
  const { source } = collectionsSource([
    coll('tasks', {
      indexes: [{ id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [{ name: 'dueDate', ascending: true }] }],
    }),
  ]);
  const { provider } = await activeWorld({ collections: source });

  assert.equal(
    provider.getParent({
      kind: 'index', databaseId: '1', collectionName: 'ghosts',
      index: { id: 'ghosts.g', collection: 'ghosts', displayName: 'g', fields: [] },
    }),
    undefined,
    'collection no longer listed (e.g. dropped mid-session)',
  );
  assert.equal(
    provider.getParent({
      kind: 'indexField', databaseId: '1', collectionName: 'tasks', indexId: 'tasks.missing',
      field: { name: 'f', ascending: true },
    }),
    undefined,
    'index no longer listed',
  );
  assert.equal(
    provider.getParent({
      kind: 'indexField', databaseId: '1', collectionName: 'ghosts', indexId: 'x',
      field: { name: 'f', ascending: true },
    }),
    undefined,
  );

  // No collections source at all — the defensive `?.` path.
  const { provider: bare } = await activeWorld();
  assert.equal(
    bare.getParent({
      kind: 'index', databaseId: '1', collectionName: 'tasks',
      index: { id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [] },
    }),
    undefined,
  );
});

// ─── findNodeById ──────────────────────────────────────────────

test('findNodeById maps a saved tree id back to the live node, at any depth', async () => {
  const subs = new SubscriptionStore(new FakeMemento());
  await subs.save('1', { id: 's1', name: 'tasks-all', query: 'SELECT * FROM tasks' });
  const { source } = collectionsSource([
    coll('tasks', {
      documentCount: 3,
      indexes: [{ id: 'tasks.by_due', collection: 'tasks', displayName: 'by_due', fields: [{ name: 'dueDate', ascending: true }] }],
    }),
  ]);
  const { provider } = await activeWorld({ subs, collections: source });

  const root = await provider.findNodeById('db.1');
  assert.equal(root?.kind, 'database');

  const details = await provider.findNodeById('dbDetails.1');
  assert.equal(details?.kind, 'databaseDetails');

  const subRow = await provider.findNodeById('sub.1.s1');
  assert.equal(subRow?.kind, 'subscription');

  const collection = await provider.findNodeById('col.1.tasks');
  assert.equal(collection?.kind, 'collection');

  const index = await provider.findNodeById('idx.1.tasks.tasks.by_due');
  assert.equal(index?.kind, 'index');

  const field = await provider.findNodeById('idxF.1.tasks.tasks.by_due.dueDate');
  assert.equal(field?.kind, 'indexField');

  assert.equal(await provider.findNodeById('db.999'), undefined, 'unknown id → undefined');
});

test('findNodeById does not descend into a non-active database', async () => {
  const { provider } = await activeWorld({ statusFor: () => 'idle' });
  assert.equal(await provider.findNodeById('db.1')?.then(n => n?.kind), 'database');
  assert.equal(await provider.findNodeById('dbDetails.1'), undefined, 'details row only exists under an active database');
});

// ─── change propagation / teardown ─────────────────────────────

test('refresh fires onDidChangeTreeData with the given node', async () => {
  const { provider } = await activeWorld();
  const seen: Array<DatabaseTreeNode | undefined> = [];
  provider.onDidChangeTreeData(n => { seen.push(n); });
  const node: DatabaseTreeNode = { kind: 'queryEditor', databaseId: '1' };
  provider.refresh(node);
  provider.refresh();
  assert.deepEqual(seen, [node, undefined]);
});

test('config, subscription, observer and collection changes refire until dispose', async () => {
  const cfg = makeStore();
  const subs = new SubscriptionStore(new FakeMemento());
  const observers = new ObserverStore(new FakeMemento());
  const { source, fire } = collectionsSource([]);
  const provider = new DatabaseTreeProvider(cfg, () => 'idle', subs, observers, undefined, source);

  let fired = 0;
  provider.onDidChangeTreeData(() => { fired += 1; });

  await cfg.save({ ...newConfig(), id: '1', name: 'A', databaseId: 'dbA' });
  await subs.save('1', { id: 's1', name: 's', query: 'SELECT 1' });
  await observers.save('1', { id: 'o1', name: 'o', query: 'SELECT 1' });
  fire([coll('tasks')]);
  assert.equal(fired, 4, 'every source change propagates');

  provider.dispose();
  await cfg.save({ ...newConfig(), id: '2', name: 'B', databaseId: 'dbB' });
  await subs.save('1', { id: 's2', name: 's2', query: 'SELECT 2' });
  await observers.save('1', { id: 'o2', name: 'o2', query: 'SELECT 2' });
  fire([coll('users')]);
  provider.refresh();
  assert.equal(fired, 4, 'a disposed provider listens to nothing');
});
