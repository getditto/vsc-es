import * as vscode from 'vscode';
import type {
  InspectorContent, QueryInspectorTab, QueryResultMetadata,
} from './inspector-state.js';

const QUERY_TAB_KEY = 'dittoInspectorQueryTab.v1.';

export type ActiveFeature =
  | { kind: 'subscriptions'; databaseId: string }
  | { kind: 'peers'; databaseId: string }
  | { kind: 'query'; databaseId: string }
  | { kind: 'metrics'; databaseId: string }
  | { kind: 'databaseMetrics'; databaseId: string }
  | { kind: 'systemMetrics'; databaseId: string }
  | { kind: 'logAnalyzer'; databaseId: string }
  | { kind: 'patternEditor' }
  | { kind: 'observers'; databaseId: string; observerId: string; tab: 'json' | 'help' };

export class InspectorController {
  private content: InspectorContent = { kind: 'none' };
  private readonly _onChange = new vscode.EventEmitter<InspectorContent>();
  readonly onContentChange = this._onChange.event;

  constructor(private readonly state: vscode.Memento) {}

  getContent(): InspectorContent { return this.content; }

  setActiveFeature(feat: ActiveFeature): void {
    if (feat.kind === 'query') {
      const tab = (this.state.get<QueryInspectorTab>(QUERY_TAB_KEY + feat.databaseId)) ?? 'history';
      this.content = { kind: 'query', databaseId: feat.databaseId, tab };
    } else if (feat.kind === 'observers') {
      this.content = {
        kind: 'observers',
        databaseId: feat.databaseId,
        observerId: feat.observerId,
        tab: feat.tab,
      };
    } else if (feat.kind === 'patternEditor') {
      // The pattern editor is global — not tied to a database. Stays
      // available even when no connection is active so the inspector's
      // help tab can render the editor docs.
      this.content = { kind: 'patternEditor' };
    } else {
      this.content = { kind: feat.kind, databaseId: feat.databaseId };
    }
    this._onChange.fire(this.content);
  }

  async setQueryTab(tab: QueryInspectorTab): Promise<void> {
    if (this.content.kind !== 'query') return;
    await this.state.update(QUERY_TAB_KEY + this.content.databaseId, tab);
    this.content = { ...this.content, tab };
    this._onChange.fire(this.content);
  }

  /** Mirrors `setQueryTab` for the observer-content kind. No-op if
   *  the current content isn't an observer. Observer tabs aren't
   *  persisted (unlike query tabs) — the panel re-asserts 'json' on
   *  every focus change, so there's no global preference to remember. */
  async setObserverTab(tab: 'json' | 'help'): Promise<void> {
    const c = this.content;
    if (c.kind !== 'observers') return;
    this.content = { ...c, tab };
    this._onChange.fire(this.content);
  }

  setSelectedRowJson(json: string | null): void {
    if (this.content.kind !== 'query' && this.content.kind !== 'observers') return;
    this.content = { ...this.content, selectedRowJson: json ?? undefined };
    this._onChange.fire(this.content);
  }

  setLastResultMetadata(md: QueryResultMetadata): void {
    if (this.content.kind !== 'query') return;
    this.content = { ...this.content, lastResultMetadata: md };
    this._onChange.fire(this.content);
  }

  clearOnDisconnect(): void {
    this.content = { kind: 'none' };
    this._onChange.fire(this.content);
  }

  /**
   * Remove every globalState key the controller persists for this DB —
   * currently just the per-DB query-tab preference. Called from the
   * delete-connection flow so deleted connections don't leave orphan
   * preference keys behind. Safe to call when no key exists.
   */
  async clearForDatabase(databaseId: string): Promise<void> {
    await this.state.update(QUERY_TAB_KEY + databaseId, undefined);
  }
}
