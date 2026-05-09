// Minimal vscode stub for unit tests. Only the names imported at module
// top-level need to exist; tests don't exercise getTreeItem() so the stubs
// can be no-ops.
export class EventEmitter {
  constructor() { this._listeners = []; }
  fire(value) { for (const l of this._listeners) l(value); }
  event = (listener) => {
    this._listeners.push(listener);
    return { dispose: () => { this._listeners = this._listeners.filter(x => x !== listener); } };
  };
  dispose() { this._listeners = []; }
}

export const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };

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
