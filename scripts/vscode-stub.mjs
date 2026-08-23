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

// Minimal Uri stub — just enough surface for production code paths
// that build/inspect URIs (CountBadgeDecorationProvider uses Uri.from
// and the .scheme/.path/.query accessors). Real vscode.Uri is much
// richer; we only stub what's exercised in tests.
export const Uri = {
  from(parts) {
    return { scheme: parts.scheme, path: parts.path ?? '', query: parts.query ?? '', fsPath: parts.path ?? '' };
  },
  parse(value) {
    const m = String(value).match(/^([^:]+):(?:\/\/[^/]*)?(\/[^?#]*)?(?:\?([^#]*))?/);
    if (!m) { return { scheme: 'unknown', path: '', query: '', fsPath: '' }; }
    return { scheme: m[1], path: m[2] ?? '', query: m[3] ?? '', fsPath: m[2] ?? '' };
  },
  file(p) { return { scheme: 'file', path: p, query: '', fsPath: p }; },
  joinPath(base, ...segments) {
    const path = [base?.path ?? '', ...segments].filter(Boolean).join('/').replace(/\/+/g, '/');
    return { scheme: base?.scheme ?? 'file', path, query: '', fsPath: path };
  },
};

// Default-only configuration surface used by tree/provider unit tests. Tests
// that need explicit values should supply their own seam rather than teaching
// this shared stub about product settings.
export const workspace = {
  getConfiguration() {
    return {
      get(_key, defaultValue) { return defaultValue; },
    };
  },
  onDidChangeConfiguration() { return { dispose() {} }; },
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

/**
 * Webview panel fake.
 *
 * Panels are where the extension's lifecycle bugs live — undisposed
 * subscriptions, tracker slots that outlive their panel — so they need to be
 * testable without an Extension Development Host. This models only what a
 * panel constructor and dispose path actually touch, and records enough
 * (`posted`, `disposed`, the message/dispose listeners) for a test to drive
 * the panel and assert on what it did.
 *
 * `createdWebviewPanels` is the seam: a test reads the panel its subject
 * created, calls `fireMessage`/`fireDispose`, and inspects the result. Reset
 * it in the test's setup — it is module-global, like the real editor's panel
 * registry.
 */
export const createdWebviewPanels = [];

class FakeWebview {
  constructor() {
    this.html = '';
    this.cspSource = 'vscode-webview://stub';
    this.posted = [];
    this._messageListeners = [];
  }

  asWebviewUri(uri) { return { ...uri, scheme: 'https', toString: () => `https://stub${uri?.path ?? ''}` }; }

  postMessage(msg) { this.posted.push(msg); return Promise.resolve(true); }

  onDidReceiveMessage(listener, _thisArg, disposables) {
    this._messageListeners.push(listener);
    const sub = { dispose: () => {
      this._messageListeners = this._messageListeners.filter(l => l !== listener);
    } };
    disposables?.push(sub);
    return sub;
  }
}

class FakeWebviewPanel {
  constructor(viewType, title, viewColumn, options) {
    this.viewType = viewType;
    this.title = title;
    this.viewColumn = viewColumn;
    this.options = options ?? {};
    this.webview = new FakeWebview();
    this.active = true;
    this.visible = true;
    this.disposed = false;
    this.revealCount = 0;
    this._disposeListeners = [];
    this._viewStateListeners = [];
  }

  onDidDispose(listener, _thisArg, disposables) {
    this._disposeListeners.push(listener);
    const sub = { dispose: () => {
      this._disposeListeners = this._disposeListeners.filter(l => l !== listener);
    } };
    disposables?.push(sub);
    return sub;
  }

  onDidChangeViewState(listener, _thisArg, disposables) {
    this._viewStateListeners.push(listener);
    const sub = { dispose: () => {
      this._viewStateListeners = this._viewStateListeners.filter(l => l !== listener);
    } };
    disposables?.push(sub);
    return sub;
  }

  reveal() { this.revealCount += 1; }

  /** Close the panel the way the user's X button does: VS Code fires
   *  onDidDispose, and the panel's own handler runs from there. */
  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const l of [...this._disposeListeners]) { l(); }
  }

  /** Deliver a message from the webview to the host.
   *
   *  The listeners live on the webview, not the panel — reading them from
   *  `this` here silently delivered nothing, which made every message-handling
   *  assertion fail with "not iterable" rather than with a useful diff. */
  fireMessage(msg) { for (const l of [...this.webview._messageListeners]) { l(msg); } }

  /** Drive a focus change. */
  fireViewState(active) {
    this.active = active;
    for (const l of [...this._viewStateListeners]) { l({ webviewPanel: this }); }
  }
}

export const window = {
  createWebviewPanel(viewType, title, viewColumn, options) {
    const panel = new FakeWebviewPanel(viewType, title, viewColumn, options);
    createdWebviewPanels.push(panel);
    return panel;
  },
  showErrorMessage(message) { window.shownErrors.push(message); return Promise.resolve(undefined); },
  showWarningMessage(message) { window.shownWarnings.push(message); return Promise.resolve(undefined); },
  showInformationMessage(message) { window.shownInfos.push(message); return Promise.resolve(undefined); },
  shownErrors: [],
  shownWarnings: [],
  shownInfos: [],
};

export const commands = {
  executed: [],
  executeCommand(command, ...args) {
    commands.executed.push({ command, args });
    return Promise.resolve(undefined);
  },
  registerCommand() { return { dispose() {} }; },
};

/** Clear every module-global recorder. Call from a test's setup so panels
 *  created by an earlier test don't leak into this one's assertions. */
export function __resetStub() {
  createdWebviewPanels.length = 0;
  window.shownErrors.length = 0;
  window.shownWarnings.length = 0;
  window.shownInfos.length = 0;
  commands.executed.length = 0;
}
