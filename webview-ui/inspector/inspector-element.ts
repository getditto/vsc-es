// webview-ui/inspector/inspector-element.ts
//
// Router element for the Inspector view. Switches on the active
// `InspectorContent.kind` pushed from the host and hosts the right child.

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';
import { assertNever } from '../shared/assert-never.js';
import { codiconStyles } from './codicon-styles.js';
import type { InspectorContent, QueryInspectorTab } from '../../src/inspector/inspector-state.js';
import type { InspectorOut } from '../../src/ipc/messages.js';
import type { QueryHistoryEntry } from '../../src/storage/QueryHistoryStore.js';
import type { QueryFavoriteEntry } from '../../src/storage/QueryFavoritesStore.js';

// Narrowed alias for the 'query' branch — used as the parameter type
// for `renderTab` so it can access `lastResultMetadata` / `selectedRowJson`
// without re-discriminating.
type InspectorContentQuery = Extract<InspectorContent, { kind: 'query' }>;

@customElement('ditto-inspector')
export class DittoInspectorElement extends LitElement {
  @state() private content: InspectorContent = { kind: 'none' };
  @state() private history: QueryHistoryEntry[] = [];
  @state() private favorites: QueryFavoriteEntry[] = [];
  @state() private helpUris: { subscription?: string; query?: string; presence?: string; metrics?: string; databaseMetrics?: string; observers?: string; logAnalyzer?: string; patternEditor?: string } = {};
  // Inspector preferences (per-installation, pushed by the host on
  // resolve and on every dismiss/reset). Defaults to "show all tips"
  // until the host's first push lands.
  @state() private prefs: { hideLimitHint: boolean } = { hideLimitHint: false };
  // Workspace settings that gate Inspector UI. `collectMetrics`
  // controls whether the Metrics tab is offered. Defaults to true so
  // a fresh install sees the tab until the host's first push lands.
  @state() private settings: { collectMetrics: boolean } = { collectMetrics: true };

  static override styles = [codiconStyles, css`
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

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<InspectorOut>(this, msg => this.onHostMessage(msg));

  private onHostMessage(m: InspectorOut | undefined): void {
    if (!m) { return; }
    switch (m.type) {
      case 'inspector.contentChanged':
        this.content = m.content;
        break;
      case 'inspector.historyChanged':
        this.history = m.entries ?? [];
        break;
      case 'inspector.favoritesChanged':
        this.favorites = m.entries ?? [];
        break;
      case 'inspector.helpHtml':
        this.helpUris = { ...this.helpUris, [m.kind]: m.uri };
        break;
      case 'inspector.preferences':
        this.prefs = { hideLimitHint: !!m.hideLimitHint };
        break;
      case 'inspector.settings':
        this.settings = { collectMetrics: !!m.collectMetrics };
        // If the user just turned metrics off while the Metrics tab is
        // selected, the tab is about to disappear from the row — flip
        // back to History so they don't end up on a stale empty body.
        if (!this.settings.collectMetrics
            && this.content.kind === 'query'
            && this.content.tab === 'metrics') {
          this.switchTab('history');
        }
        break;
      case 'inspector.attachmentProgress':
      case 'inspector.attachmentLoaded':
      case 'inspector.attachmentSaved':
      case 'inspector.attachmentError':
        // Attachment lifecycle messages are consumed by <query-json-element>
        // via its own postMessage subscription; the router doesn't need to
        // react to them here.
        break;
      default:
        // Compile-time exhaustiveness — adding a new InspectorOut
        // variant without handling it here fails typechecking.
        assertNever(m);
    }
  }

  private switchTab(tab: QueryInspectorTab): void {
    postToHost({ type: 'inspector.tabSelected', tab });
  }

  override render(): TemplateResult {
    const c = this.content;
    switch (c.kind) {
      case 'none':
        return html`<div class="empty">No active database.</div>`;
      case 'subscriptions':
        return html`<help-content-element .uri=${this.helpUris.subscription ?? ''}></help-content-element>`;
      case 'peers':
        return html`<help-content-element .uri=${this.helpUris.presence ?? ''}></help-content-element>`;
      case 'metrics':
        return html`<help-content-element .uri=${this.helpUris.metrics ?? ''}></help-content-element>`;
      case 'databaseMetrics':
        return html`<help-content-element .uri=${this.helpUris.databaseMetrics ?? ''}></help-content-element>`;
      case 'logAnalyzer':
        return html`<help-content-element .uri=${this.helpUris.logAnalyzer ?? ''}></help-content-element>`;
      case 'patternEditor':
        return html`<help-content-element .uri=${this.helpUris.patternEditor ?? ''}></help-content-element>`;
      case 'query': {
        // Filter the Metrics tab out when the workspace setting is off —
        // the user opted out of metrics collection entirely so the tab
        // has nothing to show.
        const tabs: QueryInspectorTab[] = this.settings.collectMetrics
          ? ['history', 'favorites', 'json', 'metrics', 'help']
          : ['history', 'favorites', 'json', 'help'];
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
      case 'observers': {
        const tabs: Array<'json' | 'help'> = ['json', 'help'];
        return html`
          <div class="tabs" role="tablist">
            ${tabs.map(t => html`
              <button
                class="tab"
                role="tab"
                aria-selected=${c.tab === t}
                title=${t}
                @click=${() => this.switchObserverTab(t)}
              >${this.tabIcon(t)}</button>
            `)}
          </div>
          <div class="body">${this.renderObserverTab(c)}</div>
        `;
      }
      default: {
        // Exhaustiveness — adding a new InspectorContent variant
        // without handling it here fails typechecking.
        assertNever(c);
        return html``;
      }
    }
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

  private switchObserverTab(tab: 'json' | 'help'): void {
    postToHost({ type: 'inspector.tabSelected', tab });
  }

  private renderObserverTab(c: Extract<InspectorContent, { kind: 'observers' }>) {
    switch (c.tab) {
      case 'json':
        return html`<query-json-element .json=${c.selectedRowJson}></query-json-element>`;
      case 'help':
        return html`<help-content-element .uri=${this.helpUris.observers ?? ''}></help-content-element>`;
      default:
        return html``;
    }
  }
}
