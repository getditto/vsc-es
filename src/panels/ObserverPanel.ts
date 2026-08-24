import * as vscode from 'vscode';
import { panelHtml, autoRevealInspectorOnce, webviewMessageHandler } from './webview-utils.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { Logger } from '../logging/types.js';
import type { InspectorController } from '../inspector/InspectorController.js';
import type { StoredObserver } from '../models/StoredObserver.js';
import type { ObserverIn, ObserverOut } from '../ipc/messages.js';
import type { ObserverEvent } from '../ditto/ObserverEventStore.js';

/** Per-database observer panel registry. We allow multiple observer
 *  panels open at once (one per observer), so this is a Map keyed by
 *  databaseId + observerId rather than a singleton. */
const _open = new Map<string, ObserverPanel>();

function keyOf(databaseId: string, observerId: string): string {
  return `${databaseId}:${observerId}`;
}

export class ObserverPanel {
  static show(
    context: vscode.ExtensionContext,
    manager: DittoManager,
    databaseId: string,
    observer: StoredObserver,
    inspector: InspectorController,
    logger: Logger,
  ): ObserverPanel {
    const k = keyOf(databaseId, observer.id);
    const existing = _open.get(k);
    if (existing) {
      // The tree may hold a newer observer object (renamed, query
      // rewritten) than the one this panel captured at construction
      // time — sync it before revealing so the title/toolbar reflect
      // the latest save.
      existing.updateObserver(observer);
      existing.panel.reveal();
      return existing;
    }
    const inst = new ObserverPanel(context, manager, databaseId, observer, inspector, logger);
    _open.set(k, inst);
    autoRevealInspectorOnce(context);
    return inst;
  }

  /** Sync an open panel (if any) to the latest StoredObserver. Called
   *  from the editor after `save()` so a rename/query-rewrite while
   *  the panel is open immediately retitles + restarts the SDK
   *  observer against the new query. No-op when no panel is open. */
  static refreshIfOpen(databaseId: string, observer: StoredObserver): void {
    const existing = _open.get(keyOf(databaseId, observer.id));
    if (existing) { existing.updateObserver(observer); }
  }

  /** Dispose every open panel for a given database (called from the
   *  lifecycle orchestrator when the active database changes). */
  static disposeForDatabase(databaseId: string): void {
    for (const [k, p] of _open) {
      if (p.databaseId === databaseId) { p.dispose(); _open.delete(k); }
    }
  }

  /** Dispose a single observer's panel (called from the delete-observer
   *  handler so deleting one observer doesn't close every other
   *  open observer panel for the same database). */
  static disposeOne(databaseId: string, observerId: string): void {
    const existing = _open.get(keyOf(databaseId, observerId));
    if (existing) { existing.dispose(); }
  }

  /** Dispose every open observer panel (called when the active
   *  database is closed entirely). */
  static disposeAll(): void {
    for (const [, p] of _open) { p.dispose(); }
    _open.clear();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private cancelObserver?: { cancel(): void } | undefined;
  /** Coalescing buffer for events pushed to the webview. Matches the
   *  SwiftUI 100ms flush window. */
  private pendingEvents: ObserverEvent[] = [];
  private flushTimer?: NodeJS.Timeout | undefined;
  private static readonly flushIntervalMs = 100;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly manager: DittoManager,
    private readonly databaseId: string,
    private observer: StoredObserver,
    private readonly inspector: InspectorController,
    private readonly logger: Logger,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dittoObserver',
      `Observer — ${observer.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui')],
      },
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'ditto-icon-dark.svg'),
    };
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview-ui', 'observer.js'),
    );
    this.panel.webview.html = panelHtml({
      title: 'Observer',
      scriptUri,
      cspSource: this.panel.webview.cspSource,
    });

    this.panel.webview.onDidReceiveMessage(
      webviewMessageHandler<ObserverIn>(
        this.logger, 'ext:observer', 'Observer action failed', (msg) => this.handle(msg),
      ),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Activate the Inspector for this observer when the panel gains focus.
    this.disposables.push(
      this.panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active) {
          this.inspector.setActiveFeature({
            kind: 'observers',
            databaseId: this.databaseId,
            observerId: this.observer.id,
            tab: 'json',
          });
        }
      }),
    );

    setTimeout(() => this.pushInit(), 50);
  }

  /** Re-push init after a save (the editor may have renamed the
   *  observer or rewritten the query while this panel was open). */
  updateObserver(observer: StoredObserver): void {
    this.observer = observer;
    this.panel.title = `Observer — ${observer.name}`;
    this.pushInit();
    // If currently active, the query may have changed — restart.
    if (this.cancelObserver) {
      this.stop();
      void this.activate();
    }
  }

  private pushInit(): void {
    this.post({
      type: 'observer.init',
      observer: { id: this.observer.id, name: this.observer.name, query: this.observer.query },
    });
    this.post({ type: 'observer.statusChanged', active: !!this.cancelObserver });
  }

  private post(msg: ObserverOut): void {
    this.panel.webview.postMessage(msg);
  }

  private async handle(msg: ObserverIn): Promise<void> {
    switch (msg.type) {
      case 'observer.activate': {
        await this.activate();
        return;
      }
      case 'observer.stop': {
        this.stop();
        return;
      }
      case 'observer.eventSelected': {
        // The webview tracks event selection; we don't need to do
        // anything host-side beyond optionally surfacing the rowJson
        // to the inspector (handled via observer.rowSelected).
        return;
      }
      case 'observer.rowSelected': {
        this.inspector.setSelectedRowJson(msg.rowJson);
        return;
      }
    }
  }

  private async activate(): Promise<void> {
    if (this.cancelObserver) { return; }
    if (this.manager.getActiveConfigId() !== this.databaseId) {
      vscode.window.showWarningMessage('Connect to this database first.');
      return;
    }
    const handle = this.manager.registerObserver(this.observer.query, (event) => {
      const oe: ObserverEvent = {
        id: randomEventId(),
        eventTimeISO: new Date().toISOString(),
        // `rows` is already capped on the host (OBSERVER_ROW_CAP);
        // `totalRows` lets the webview show "first N of M".
        data: event.rows,
        totalRows: event.totalRows,
        insertions: event.insertions,
        updates: event.updates,
        deletions: event.deletions,
        moves: event.moves,
      };
      this.enqueue(oe);
    });
    if (!handle) {
      vscode.window.showWarningMessage('Could not register observer — no active session.');
      this.post({ type: 'observer.statusChanged', active: false });
      return;
    }
    this.cancelObserver = handle;
    this.post({ type: 'observer.statusChanged', active: true });
  }

  private stop(): void {
    this.cancelObserver?.cancel();
    this.cancelObserver = undefined;
    this.cancelFlush();
    this.post({ type: 'observer.cleared' });
    this.post({ type: 'observer.statusChanged', active: false });
  }

  /** Enqueue an event onto the pending buffer and (re)schedule a
   *  flush. Coalescing across a 100ms window keeps the webview from
   *  re-rendering on every individual SDK callback during
   *  high-frequency sync. */
  private enqueue(event: ObserverEvent): void {
    this.pendingEvents.push(event);
    if (this.flushTimer) { return; }
    this.flushTimer = setTimeout(() => this.flush(), ObserverPanel.flushIntervalMs);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.pendingEvents.length === 0) { return; }
    const batch = this.pendingEvents;
    this.pendingEvents = [];
    // The webview owns the 500-cap ring buffer (see
    // observer-element.ts:appendEvents); the host doesn't need its
    // own mirror because it never reads back from one.
    this.post({ type: 'observer.events', events: batch });
  }

  private cancelFlush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.pendingEvents = [];
  }

  private dispose(): void {
    _open.delete(keyOf(this.databaseId, this.observer.id));
    this.stop();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
    this.panel.dispose();
  }
}

function randomEventId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
