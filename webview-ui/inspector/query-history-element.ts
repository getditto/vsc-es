// webview-ui/inspector/query-history-element.ts
//
// Renders the query history list with hover actions: load into editor,
// add to favorites, delete entry.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { postToHost } from '../shared/messaging.js';

interface QueryHistoryEntry { id: string; query: string; timestamp?: number; }

@customElement('query-history-element')
export class QueryHistoryElement extends LitElement {
  @property({ type: Array }) entries: QueryHistoryEntry[] = [];

  static styles = css`
    :host { display: block; padding: 8px; color: var(--vscode-foreground); }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      background: var(--vscode-textCodeBlock-background);
      margin-bottom: 6px;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .q {
      flex: 1;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .actions { display: none; gap: 4px; }
    .row:hover .actions { display: flex; }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 24px;
      text-align: center;
    }
    button {
      background: transparent;
      border: 0;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
    }
    button:hover {
      background: var(--vscode-toolbar-hoverBackground);
      border-radius: 3px;
    }
  `;

  render() {
    if (!this.entries?.length) {
      return html`
        <div class="empty">
          <span class="codicon codicon-clock" style="font-size: 32px"></span>
          <div>No queries have been run yet.</div>
        </div>
      `;
    }
    return html`${this.entries.map(e => html`
      <div class="row" @click=${() => this.load(e.query)}>
        <span class="codicon codicon-clock" style="margin-top: 3px; opacity: 0.7"></span>
        <div class="q">${e.query}</div>
        <div class="actions">
          <button title="Add to Favorites"
                  @click=${(ev: Event) => { ev.stopPropagation(); this.fav(e.query); }}>
            <span class="codicon codicon-star"></span>
          </button>
          <button title="Delete"
                  @click=${(ev: Event) => { ev.stopPropagation(); this.del(e.id); }}>
            <span class="codicon codicon-trash"></span>
          </button>
        </div>
      </div>
    `)}`;
  }

  private load(query: string): void {
    postToHost({ type: 'inspector.loadQueryInEditor', query });
  }
  private fav(query: string): void {
    postToHost({ type: 'inspector.addFavorite', query });
  }
  private del(id: string): void {
    postToHost({ type: 'inspector.deleteHistoryEntry', id });
  }
}
