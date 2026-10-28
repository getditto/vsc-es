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

// The host version string (vscode.version) — surfaces in diagnostics like
// the bug-report README. A fixed stub value keeps test output deterministic.
export const version = '1.106.0-stub';

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
}

export class ThemeColor {
  constructor(id) { this.id = id; }
}

export class MarkdownString {
  appendCodeblock(_value, _language) { return this; }
}

export class Disposable {
  constructor(callOnDispose) { this._cb = callOnDispose; }
  static from(...items) { return new Disposable(() => { for (const i of items) i?.dispose?.(); }); }
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
// this shared stub about product settings. For the few production call sites
// that read a setting directly (no seam), `configValues` is a generic
// per-section override map — it names no product setting itself, and
// __resetStub() clears it so overrides never leak between tests.
export const workspace = {
  configValues: {},
  // Open workspace folders (the fetch_attachment root allowlist reads
  // this). Tests set it per case; __resetStub() clears it.
  workspaceFolders: [],
  getConfiguration(section) {
    const values = workspace.configValues[section] ?? {};
    return {
      get(key, defaultValue) {
        return Object.hasOwn(values, key) ? values[key] : defaultValue;
      },
      update(key, value) {
        (workspace.configValues[section] ??= {})[key] = value;
        return Promise.resolve();
      },
    };
  },
  onDidChangeConfiguration() { return { dispose() {} }; },
  // Tests that drive a file-size gate set workspace.fsStatSize before the
  // action (default 0 = an empty file). The map isn't needed — one size per
  // test is enough because dialogs return one file at a time.
  fsStatSize: 0,
  fs: {
    async stat() { return { size: workspace.fsStatSize }; },
  },
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

/** No real progress UI in tests — run the task inline and resolve. */
export const ProgressLocation = { Notification: 15 };

export const window = {
  createWebviewPanel(viewType, title, viewColumn, options) {
    const panel = new FakeWebviewPanel(viewType, title, viewColumn, options);
    createdWebviewPanels.push(panel);
    return panel;
  },
  showErrorMessage(message) { window.shownErrors.push(message); return Promise.resolve(undefined); },
  showWarningMessage(message) {
    window.shownWarnings.push(message);
    // Modal confirmations (e.g. Delete) await the user's choice; tests
    // set window.warningResponse to the button label they want pressed.
    const response = window.warningResponse;
    window.warningResponse = undefined;
    return Promise.resolve(response);
  },
  showInformationMessage(message) { window.shownInfos.push(message); return Promise.resolve(undefined); },
  /** Tests set window.openDialogResult to an array of Uri-like values
   *  to simulate picking files; undefined/null = user cancelled. */
  showOpenDialog() { return Promise.resolve(window.openDialogResult); },
  /** Tests set window.saveDialogResult to a Uri to simulate the user
   *  picking a save destination; undefined = user cancelled. */
  showSaveDialog(options) {
    window.lastSaveDialogOptions = options;
    return Promise.resolve(window.saveDialogResult);
  },
  /** Tests set window.quickPickResult to the item array the user "picked". */
  showQuickPick() { return Promise.resolve(window.quickPickResult); },
  /** Records the last validateInput callback so a test can exercise it, and
   *  resolves to window.inputBoxResult (undefined = dismissed). */
  showInputBox(options) {
    window.lastInputBoxValidate = options?.validateInput;
    return Promise.resolve(window.inputBoxResult);
  },
  withProgress(_options, task) {
    return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } });
  },
  createStatusBarItem(alignment, priority) {
    const item = {
      alignment, priority, text: '', tooltip: '', command: undefined,
      shown: false,
      show() { item.shown = true; },
      hide() { item.shown = false; },
      dispose() { item.shown = false; },
    };
    createdStatusBarItems.push(item);
    return item;
  },
  shownErrors: [],
  shownWarnings: [],
  shownInfos: [],
  openDialogResult: undefined,
  saveDialogResult: undefined,
  lastSaveDialogOptions: undefined,
  quickPickResult: undefined,
  inputBoxResult: undefined,
  warningResponse: undefined,
  lastInputBoxValidate: undefined,
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

/** Status bar item fake — records text/tooltip so tests can assert the
 *  MCP controller's running indicator. */
export const createdStatusBarItems = [];

export const env = {
  clipboard: {
    writeText(text) { env.clipboardText = text; return Promise.resolve(); },
    readText() { return Promise.resolve(env.clipboardText ?? ''); },
  },
  clipboardText: '',
  openExternal() { return Promise.resolve(true); },
};

/** MCP definition-provider fake: registrations land here so tests can
 *  interrogate what an extension would have published to vscode.lm. */
export class McpHttpServerDefinition {
  constructor(label, uri, headers, version) {
    this.label = label;
    this.uri = uri;
    this.headers = headers ?? {};
    this.version = version;
  }
}

export class McpStdioServerDefinition {
  constructor(label, command, args = [], envVars = {}, version) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.env = envVars;
    this.version = version;
  }
}

export const lm = {
  registeredMcpProviders: [],
  registerMcpServerDefinitionProvider(id, provider) {
    const entry = { id, provider };
    lm.registeredMcpProviders.push(entry);
    return { dispose() { lm.registeredMcpProviders = lm.registeredMcpProviders.filter(e => e !== entry); } };
  },
};

export const commands = {
  executed: [],
  /** Tests set commands.executeCommandError to an Error to make the next (and
   *  subsequent, until cleared) executeCommand calls reject with it — the
   *  failure path of command fan-outs. __resetStub() clears it. */
  executeCommandError: undefined,
  executeCommand(command, ...args) {
    commands.executed.push({ command, args });
    if (commands.executeCommandError) {
      return Promise.reject(commands.executeCommandError);
    }
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
  window.openDialogResult = undefined;
  window.saveDialogResult = undefined;
  window.lastSaveDialogOptions = undefined;
  window.quickPickResult = undefined;
  window.inputBoxResult = undefined;
  window.warningResponse = undefined;
  window.lastInputBoxValidate = undefined;
  workspace.fsStatSize = 0;
  workspace.configValues = {};
  workspace.workspaceFolders = [];
  commands.executed.length = 0;
  commands.executeCommandError = undefined;
  env.clipboardText = '';
  lm.registeredMcpProviders.length = 0;
  createdStatusBarItems.length = 0;
}
