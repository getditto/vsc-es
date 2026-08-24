// webview-ui/inspector/query-json-element.ts
//
// Pretty-prints the currently-selected query result row as JSON, and
// surfaces any embedded attachments via <attachment-viewer-element>.

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { codiconStyles } from './codicon-styles.js';
import '../shared/json-viewer.js';

@customElement('query-json-element')
export class QueryJsonElement extends LitElement {
  @property() json: string | undefined;

  static override styles = [codiconStyles, css`
    :host { display: block; padding: 12px; color: var(--vscode-foreground); }
    .empty {
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 32px;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .viewer {
      display: block;
      max-height: 60vh;
      overflow: auto;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
      margin-bottom: 8px;
    }
  `];

  override render() {
    if (!this.json) {
      return html`
        <div class="empty">
          <span class="codicon codicon-code" style="font-size: 36px"></span>
          <div>Select a JSON result to view it here.</div>
        </div>
      `;
    }
    let pretty: string;
    try {
      pretty = JSON.stringify(JSON.parse(this.json), null, 2);
    } catch {
      pretty = this.json;
    }
    return html`
      <json-viewer class="viewer" .value=${pretty} wrap></json-viewer>
      <attachment-viewer-element .json=${this.json}></attachment-viewer-element>
    `;
  }
}
