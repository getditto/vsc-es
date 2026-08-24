import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { QueryProfileOperator, QueryProfileStats } from '../../src/ditto/QueryProfile.js';
import { formatNs } from '../../src/util/profileTimeFormatter.js';
import '../shared/pill.js';

function formatDocs(n: number): string {
  return n.toLocaleString();
}

@customElement('ditto-profile-card-list')
export class DittoProfileCardList extends LitElement {
  @property({ attribute: false }) root!: QueryProfileOperator;

  static override styles = css`
    :host { display: block; }
    .card {
      padding: 12px;
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
    }
    .child-wrap { padding-left: 12px; margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
    .header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }
    .name {
      font-family: var(--vscode-editor-font-family);
      font-weight: 600;
      font-size: 13px;
    }
    .badges { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .attrs {
      margin-top: 8px;
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 4px 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .attr-key { color: var(--vscode-descriptionForeground); }
    .attr-val { color: var(--vscode-foreground); word-break: break-word; user-select: text; }
  `;

  override render() {
    return this.renderNode(this.root);
  }

  private renderNode(node: QueryProfileOperator): TemplateResult {
    return html`
      <div>
        <div class="card">
          <div class="header">
            <span class="name">${node.name}</span>
            <span class="badges">${this.renderBadges(node.stats)}</span>
          </div>
          ${node.attributes.length > 0 ? html`
            <div class="attrs">
              ${node.attributes.map(a => html`
                <span class="attr-key">${a.key}</span>
                <span class="attr-val">${a.value}</span>
              `)}
            </div>
          ` : nothing}
        </div>
        ${node.children.length > 0 ? html`
          <div class="child-wrap">
            ${node.children.map(c => this.renderNode(c))}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderBadges(stats: QueryProfileStats | undefined): TemplateResult | typeof nothing {
    if (!stats) { return nothing; }
    return html`
      ${stats.documentsIn !== undefined ? html`<ditto-pill label="in" .value=${formatDocs(stats.documentsIn)} color="blue"></ditto-pill>` : nothing}
      ${stats.documentsOut !== undefined ? html`<ditto-pill label="out" .value=${formatDocs(stats.documentsOut)} color="green"></ditto-pill>` : nothing}
      ${stats.execNs !== undefined ? html`<ditto-pill label="exec" .value=${formatNs(stats.execNs)} color="red"></ditto-pill>` : nothing}
      ${stats.recvNs !== undefined ? html`<ditto-pill label="recv" .value=${formatNs(stats.recvNs)} color="orange"></ditto-pill>` : nothing}
      ${stats.sendNs !== undefined ? html`<ditto-pill label="send" .value=${formatNs(stats.sendNs)} color="purple"></ditto-pill>` : nothing}
    `;
  }
}
