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
  | { kind: 'databaseMetrics'; databaseId: string };

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
    } else {
      this.content = { kind: feat.kind, databaseId: feat.databaseId } as InspectorContent;
    }
    this._onChange.fire(this.content);
  }

  async setQueryTab(tab: QueryInspectorTab): Promise<void> {
    if (this.content.kind !== 'query') return;
    await this.state.update(QUERY_TAB_KEY + this.content.databaseId, tab);
    this.content = { ...this.content, tab };
    this._onChange.fire(this.content);
  }

  setSelectedRowJson(json: string | null): void {
    if (this.content.kind !== 'query') return;
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
