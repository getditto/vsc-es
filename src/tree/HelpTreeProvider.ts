import * as vscode from 'vscode';

/**
 * Items in the Help tree are either external links (`url`) that open
 * in the system browser via `vscode.open`, or in-extension actions
 * (`command`) that fire a registered command. Discriminated by which
 * field is set; the renderer wires the right `TreeItem.command`
 * regardless.
 */
type HelpNode =
  | { kind: 'link'; label: string; icon: string; url: string }
  | { kind: 'action'; label: string; icon: string; command: string };

const ITEMS: HelpNode[] = [
  { kind: 'link', label: "What's New",              icon: 'star',      url: 'https://docs.ditto.live/release-notes' },
  { kind: 'link', label: 'Extension Documentation', icon: 'book',      url: 'https://docs.ditto.live' },
  { kind: 'link', label: 'Ditto Documentation',     icon: 'book',      url: 'https://docs.ditto.live' },
  { kind: 'link', label: 'Ditto Portal',            icon: 'cloud',     url: 'https://portal.ditto.live' },
  { kind: 'link', label: 'Quickstart Repos',        icon: 'package',   url: 'https://github.com/getditto/quickstart' },
  { kind: 'link', label: 'Suggest a Feature',       icon: 'lightbulb', url: 'https://github.com/getditto/quickstart/issues/new' },
  { kind: 'link', label: 'Report a Bug',            icon: 'bug',       url: 'https://github.com/getditto/quickstart/issues/new' },
  // In-extension action — re-enables every dismissable tip the user
  // has hidden. Sits with the help links because that's where users
  // look when they want to "make this thing show up again."
  { kind: 'action', label: 'Reset Warnings',        icon: 'refresh',   command: 'dittoVsce.resetWarnings' },
];

export class HelpTreeProvider implements vscode.TreeDataProvider<HelpNode> {
  getChildren(): HelpNode[] { return ITEMS; }
  getTreeItem(n: HelpNode): vscode.TreeItem {
    const it = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
    it.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.kind === 'link') {
      it.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.parse(n.url)] };
    } else {
      it.command = { command: n.command, title: n.label };
    }
    return it;
  }
}
