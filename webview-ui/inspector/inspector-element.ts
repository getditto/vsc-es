// webview-ui/inspector/inspector-element.ts
//
// Router element for the Inspector view. Switches on the active
// `InspectorContent.kind` pushed from the host and hosts the right child.

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost } from '../shared/messaging.js';
import { codiconStyles } from './codicon-styles.js';

type QueryInspectorTab = 'history' | 'favorites' | 'json' | 'metrics' | 'help';

interface InspectorContentNone { kind: 'none'; }
interface InspectorContentSub  { kind: 'subscriptions'; databaseId: string; }
interface InspectorContentPeers { kind: 'peers'; databaseId: string; }
interface InspectorContentQuery {
  kind: 'query';
  databaseId: string;
  tab: QueryInspectorTab;
  lastResultMetadata?: Record<string, unknown>;
  selectedRowJson?: string;
}
type InspectorContent =
  | InspectorContentNone
  | InspectorContentSub
  | InspectorContentPeers
  | InspectorContentQuery;

interface QueryHistoryEntry { id: string; query: string; timestamp?: number; }
interface QueryFavoriteEntry { id: string; query: string; timestamp?: number; }

@customElement('ditto-inspector')
export class DittoInspectorElement extends LitElement {
  @state() private content: InspectorContent = { kind: 'none' };
  @state() private history: QueryHistoryEntry[] = [];
  @state() private favorites: QueryFavoriteEntry[] = [];
  @state() private helpUris: { subscription?: string; query?: string; presence?: string } = {};
  // Inspector preferences (per-installation, pushed by the host on
  // resolve and on every dismiss/reset). Defaults to "show all tips"
  // until the host's first push lands.
  @state() private prefs: { hideLimitHint: boolean } = { hideLimitHint: false };

  static styles = [codiconStyles, css`
    :host {
      display: block;
      height: 100%;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 24px;
      text-align: center;
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tab {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
    }
    .tab[aria-selected="true"] {
      background: var(--vscode-list-activeSelectionBackground);
      border-color: var(--vscode-focusBorder);
    }
    .body {
      height: calc(100% - 40px);
      overflow: auto;
    }
  `];

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', this.onMessage);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('message', this.onMessage);
  }

  private onMessage = (e: MessageEvent): void => {
    const m = e.data;
    if (!m) { return; }
    switch (m.type) {
      case 'inspector.contentChanged':
        this.content = m.content as InspectorContent;
        break;
      case 'inspector.historyChanged':
        this.history = (m.entries ?? []) as QueryHistoryEntry[];
        break;
      case 'inspector.favoritesChanged':
        this.favorites = (m.entries ?? []) as QueryFavoriteEntry[];
        break;
      case 'inspector.helpHtml':
        this.helpUris = { ...this.helpUris, [m.kind]: m.uri };
        break;
      case 'inspector.preferences':
        this.prefs = { hideLimitHint: !!m.hideLimitHint };
        break;
    }
  };

  private switchTab(tab: QueryInspectorTab): void {
    postToHost({ type: 'inspector.tabSelected', tab });
  }

  render() {
    const c = this.content;
    if (c.kind === 'none') {
      return html`<div class="empty">No active database.</div>`;
    }
    if (c.kind === 'subscriptions') {
      return html`<help-content-element .uri=${this.helpUris.subscription ?? ''}></help-content-element>`;
    }
    if (c.kind === 'peers') {
      return html`<help-content-element .uri=${this.helpUris.presence ?? ''}></help-content-element>`;
    }
    if (c.kind === 'query') {
      const tabs: QueryInspectorTab[] = ['history', 'favorites', 'json', 'metrics', 'help'];
      return html`
        <div class="tabs" role="tablist">
          ${tabs.map(t => html`
            <button
              class="tab"
              role="tab"
              aria-selected=${c.tab === t}
              title=${t}
              @click=${() => this.switchTab(t)}
            >${this.tabIcon(t)}</button>
          `)}
        </div>
        <div class="body">${this.renderTab(c)}</div>
      `;
    }
    return html``;
  }

  private tabIcon(t: QueryInspectorTab) {
    const map: Record<QueryInspectorTab, string> = {
      history: 'history',
      favorites: 'star',
      json: 'json',
      metrics: 'dashboard',
      help: 'question',
    };
    return html`<span class="codicon codicon-${map[t]}"></span>`;
  }

  private renderTab(c: InspectorContentQuery) {
    switch (c.tab) {
      case 'history':
        return html`<query-history-element .entries=${this.history}></query-history-element>`;
      case 'favorites':
        return html`<query-favorites-element .entries=${this.favorites}></query-favorites-element>`;
      case 'json':
        return html`<query-json-element .json=${c.selectedRowJson}></query-json-element>`;
      case 'metrics':
        return html`<query-metrics-element .metadata=${c.lastResultMetadata} .hideLimitHint=${this.prefs.hideLimitHint}></query-metrics-element>`;
      case 'help':
        return html`<help-content-element .uri=${this.helpUris.query ?? ''}></help-content-element>`;
      default:
        return html``;
    }
  }
}
