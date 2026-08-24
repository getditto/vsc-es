// webview-ui/inspector/query-favorites-element.ts
//
// Renders the favorite-queries list. Mirrors the history element but with
// a single hover-action: remove from favorites.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { postToHost } from '../shared/messaging.js';
import { codiconStyles } from './codicon-styles.js';

interface QueryFavoriteEntry { id: string; query: string; timestamp?: number; }

@customElement('query-favorites-element')
export class QueryFavoritesElement extends LitElement {
  @property({ type: Array }) entries: QueryFavoriteEntry[] = [];

  static override styles = [codiconStyles, css`
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
  `];

  override render() {
    if (!this.entries?.length) {
      return html`
        <div class="empty">
          <span class="codicon codicon-star" style="font-size: 32px"></span>
          <div>No favorite queries saved yet.</div>
        </div>
      `;
    }
    return html`${this.entries.map(e => html`
      <div class="row" @click=${() => this.load(e.query)}>
        <span class="codicon codicon-star" style="margin-top: 3px; opacity: 0.7"></span>
        <div class="q">${e.query}</div>
        <div class="actions">
          <button title="Remove from Favorites"
                  @click=${(ev: Event) => { ev.stopPropagation(); this.removeFavorite(e.id); }}>
            <span class="codicon codicon-chrome-close"></span>
          </button>
        </div>
      </div>
    `)}`;
  }

  private load(query: string): void {
    postToHost({ type: 'inspector.loadQueryInEditor', query });
  }
  private removeFavorite(id: string): void {
    postToHost({ type: 'inspector.removeFavorite', id });
  }
}
