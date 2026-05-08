// Minimal vscode stub for unit tests. Only the names imported at module
// top-level need to exist; tests don't exercise getTreeItem() so the stubs
// can be no-ops.
export class EventEmitter {
  fire() {}
  event = () => ({ dispose() {} });
}

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeIcon {
  constructor(id) { this.id = id; }
}

export class MarkdownString {
  appendCodeblock(_value, _language) { return this; }
}

export class Disposable {
  constructor(callOnDispose) { this._cb = callOnDispose; }
  dispose() { this._cb?.(); }
}
