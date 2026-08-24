import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Identifiers for the five Log Analyzer filter tabs. Match the
 *  `filter` field on `analyzer.queryLines`. */
export type FilterKey = 'all' | 'critical' | 'error' | 'warn' | 'problem';

/** Tab strip across the top of the log-viewer section. Emits a
 *  `filter-change` CustomEvent (composed, bubbling) whose `detail.key`
 *  is one of the FilterKey values. */
@customElement('filter-tabs')
export class FilterTabs extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      padding: 8px 0;
    }
    .tab {
      padding: 4px 10px;
      cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: transparent;
      user-select: none;
      font: inherit;
    }
    .tab:hover { background: var(--vscode-list-hoverBackground); }
    .tab.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-focusBorder);
    }
    .badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 0 6px;
      border-radius: 10px;
      margin-left: 6px;
      font-size: 11px;
    }
    .crit { color: var(--vscode-errorForeground); }
    .err  { color: var(--vscode-errorForeground); }
    .warn { color: var(--vscode-editorWarning-foreground); }
  `;

  @property({ type: String }) active: FilterKey = 'all';
  @property({ type: Object }) counts: {
    critical: number;
    errors: number;
    warnings: number;
    problems: number;
    totalLines: number;
  } = { critical: 0, errors: 0, warnings: 0, problems: 0, totalLines: 0 };

  private select(key: FilterKey): void {
    this.dispatchEvent(new CustomEvent('filter-change', { detail: { key }, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    const tab = (key: FilterKey, label: string, count: number, cls?: string): TemplateResult => html`
      <button
        class="tab ${this.active === key ? 'active' : ''} ${cls ?? ''}"
        @click=${(): void => this.select(key)}
      >
        ${label}<span class="badge">${count}</span>
      </button>
    `;
    return html`
      ${tab('all',      'All',      this.counts.totalLines)}
      ${tab('critical', 'Critical', this.counts.critical, 'crit')}
      ${tab('error',    'Errors',   this.counts.errors,   'err')}
      ${tab('warn',     'Warnings', this.counts.warnings, 'warn')}
      ${tab('problem',  'Problems', this.counts.problems)}
    `;
  }
}
