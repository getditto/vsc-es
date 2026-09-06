import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/** Identifiers for the Log Analyzer source tabs. Match the `source` field
 *  on `analyzer.queryLines` and `AnalyzerSource` in
 *  src/logAnalyzer/log-sources.ts. */
export type SourceKey = 'all' | 'transport' | 'connectionRequests';

/** Source-tab strip in the toolbar (to the right of the action buttons) —
 *  the VS Code equivalent of the SwiftUI/Android Log Analyzer source row
 *  ("Ditto SDK" / "Transport Conditions" / "Connection Requests"). The VS
 *  Code analyzer has a single unified log buffer, so 'all' shows every
 *  line; the other two tabs show only the log-only SDK observer streams
 *  (installed on the Ditto session by the host — see
 *  src/ditto/session-log-observers.ts) and badge themselves with their
 *  buffered line counts.
 *
 *  Emits a `source-change` CustomEvent (composed, bubbling) whose
 *  `detail.key` is one of the SourceKey values. */
@customElement('source-tabs')
export class SourceTabs extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      align-items: center;
      /* Push off the action buttons by more than the toolbar's 8px gap
         when the row doesn't wrap. */
      margin-left: 8px;
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
  `;

  @property({ type: String }) active: SourceKey = 'all';
  /** Buffered line counts per event source, from the summary diff. */
  @property({ type: Object }) sourceCounts: { transport: number; connectionRequests: number } =
    { transport: 0, connectionRequests: 0 };

  override connectedCallback(): void {
    super.connectedCallback();
    // No visual group label (toolbar space is deliberate); keep the group
    // identifiable to assistive tech instead.
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Log source');
  }

  private select(key: SourceKey): void {
    this.dispatchEvent(new CustomEvent('source-change', { detail: { key }, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    const tab = (key: SourceKey, label: string, count?: number): TemplateResult => html`
      <button
        class="tab ${this.active === key ? 'active' : ''}"
        @click=${(): void => this.select(key)}
      >
        ${label}${count !== undefined ? html`<span class="badge">${count}</span>` : ''}
      </button>
    `;
    return html`
      ${tab('all', 'Logs')}
      ${tab('transport', 'Transport Conditions', this.sourceCounts.transport)}
      ${tab('connectionRequests', 'Connection Requests', this.sourceCounts.connectionRequests)}
    `;
  }
}
