import * as vscode from 'vscode';

interface HelpNode { label: string; icon: string; url: string; }

const ITEMS: HelpNode[] = [
  { label: "What's New",              icon: 'star',      url: 'https://docs.ditto.live/release-notes' },
  { label: 'Extension Documentation', icon: 'book',      url: 'https://docs.ditto.live' },                          // TBD: replace with project README URL when available
  { label: 'Ditto Documentation',     icon: 'book',      url: 'https://docs.ditto.live' },
  { label: 'Ditto Portal',            icon: 'cloud',     url: 'https://portal.ditto.live' },
  { label: 'Quickstart Repos',        icon: 'package',   url: 'https://github.com/getditto/quickstart' },
  { label: 'Suggest a Feature',       icon: 'lightbulb', url: 'https://github.com/getditto/quickstart/issues/new' }, // TBD: replace with project's issues URL
  { label: 'Report a Bug',            icon: 'bug',       url: 'https://github.com/getditto/quickstart/issues/new' }, // TBD: replace
];

export class HelpTreeProvider implements vscode.TreeDataProvider<HelpNode> {
  getChildren(): HelpNode[] { return ITEMS; }
  getTreeItem(n: HelpNode): vscode.TreeItem {
    const it = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    it.iconPath = new vscode.ThemeIcon(n.icon);
    it.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(n.url)] };
    return it;
  }
}
