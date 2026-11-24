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
  // Top of the list — the onboarding panel. Lives at the top because
  // it's the most useful row for users who are still learning the
  // extension, and lining it up next to "What's New" reads as
  // "orientation material." The dedicated Welcome panel + the
  // per-screen help that the Inspector renders is the extension's
  // documentation, so there's no separate "Extension Documentation"
  // row — Welcome is it.
  { kind: 'action', label: 'Welcome to Ditto',      icon: 'rocket',         command: 'dittoVsce.openWelcome' },
  { kind: 'action', label: 'Get Quickstarts',       icon: 'cloud-download', command: 'dittoVsce.getQuickstarts' },
  { kind: 'link', label: "What's New",              icon: 'star',      url: 'https://docs.ditto.live/release-notes' },
  { kind: 'link', label: 'Ditto Documentation',     icon: 'book',      url: 'https://docs.ditto.live/sdk/latest/tools/vsc-es' },
  { kind: 'link', label: 'Ditto Portal',            icon: 'cloud',     url: 'https://portal.ditto.live' },
  { kind: 'link', label: 'Quickstart Repos',        icon: 'package',   url: 'https://github.com/getditto/quickstart' },
  // GitHub issue-form templates so the user lands directly in the
  // right form. The `template=` query string param is matched against
  // the filenames in .github/ISSUE_TEMPLATE/ on the repo. If a
  // template is renamed or removed, the link still works — GitHub
  // falls back to the issue chooser page.
  { kind: 'link', label: 'Suggest a Feature',       icon: 'lightbulb', url: 'https://github.com/getditto/vsc-es/issues/new?template=feature_request.yml' },
  { kind: 'link', label: 'Report a Bug',            icon: 'bug',       url: 'https://github.com/getditto/vsc-es/issues/new?template=bug_report.yml' },
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
