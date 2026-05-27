// webview-ui/query/profile-viewer.ts
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { QueryProfile } from '../../src/ditto/QueryProfile.js';
import { formatNs } from '../../src/util/profileTimeFormatter.js';
import { isSelectStatement } from '../../src/ditto/QueryProfileParser.js';
import './profile-card-list.js';
import './profile-plan-tree.js';

type PlanMode = 'card' | 'plan';

/** What the parent passes in for the three empty-state branches. */
export type ProfileMode = 'local' | 'http';

function stripProfilePrefix(text: string): string {
  const trimmed = text.trim();
  if (trimmed.toUpperCase().startsWith('PROFILE ')) {
    return trimmed.slice('PROFILE '.length);
  }
  return text;
}

function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

@customElement('ditto-profile-viewer')
export class DittoProfileViewer extends LitElement {
  /** The parsed profile, or undefined for any of the empty-state branches. */
  @property({ attribute: false }) profile?: QueryProfile;
  /** Where the query ran. HTTP mode never profiles for v1 (PROFILE is
   *  local-only). When mode === 'http', the empty state explains that. */
  @property({ type: String }) mode: ProfileMode = 'local';
  /** The last query text the user ran. Used to differentiate "non-SELECT"
   *  from "no query yet" empty states. */
  @property({ type: String }) lastQueryText = '';

  @state() private planMode: PlanMode = 'card';

  static styles = css`
    :host {
      display: block;
      padding: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }
    .stack { display: flex; flex-direction: column; gap: 16px; max-width: 920px; }
    .section-title {
      font-size: 11px;
      letter-spacing: 0.05em;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .query-box {
      padding: 10px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      user-select: text;
      white-space: pre-wrap;
    }
    .timestamp { color: var(--vscode-descriptionForeground); font-size: 11px; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 8px;
    }
    .cell {
      padding: 10px;
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      box-sizing: border-box;
    }
    .cell .label {
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .cell .value {
      margin-top: 4px;
      font-size: 17px;
      font-weight: 600;
      font-family: var(--vscode-editor-font-family);
      font-variant-numeric: tabular-nums;
    }

    .plan-toggle { display: inline-flex; gap: 2px; }
    .plan-toggle button {
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .plan-toggle button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      user-select: text;
    }
    .footer .field-key { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
    .footer .sep { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }

    .legend { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
    .legend-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .swatch {
      display: inline-block;
      width: 56px;
      text-align: center;
      font-weight: 600;
      padding: 1px 0;
      border-radius: 999px;
    }
    .swatch.blue   { background: rgba( 41,121,255,0.16); color: var(--vscode-charts-blue, #2979ff); }
    .swatch.green  { background: rgba( 46,160, 67,0.16); color: var(--vscode-charts-green, #2ea043); }
    .swatch.red    { background: rgba(229, 57, 53,0.16); color: var(--vscode-charts-red, #e53935); }
    .swatch.orange { background: rgba(245,124,  0,0.16); color: var(--vscode-charts-orange, #f57c00); }
    .swatch.purple { background: rgba(142, 36,170,0.16); color: var(--vscode-charts-purple, #8e24aa); }

    .empty {
      padding: 48px 24px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .empty .title { font-size: 15px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 8px; }
    .empty .body { font-size: 13px; max-width: 520px; margin: 0 auto; }
    .empty code  { font-family: var(--vscode-editor-font-family); }
  `;

  render() {
    if (this.profile) { return this.renderPopulated(this.profile); }
    if (this.mode === 'http') { return this.renderHttpState(); }
    if (this.lastQueryText && !isSelectStatement(this.lastQueryText)) { return this.renderNonSelectState(); }
    return this.renderNoQueryYetState();
  }

  private renderPopulated(p: QueryProfile) {
    return html`
      <div class="stack">
        <!-- Header card -->
        <div>
          <div class="header-row">
            <span class="section-title">Execution Profile</span>
            <span class="timestamp">captured ${formatLocalTime(p.capturedAtMs)}</span>
          </div>
          <div class="query-box" style="margin-top:6px;">${stripProfilePrefix(p.text)}</div>
        </div>

        <!-- Summary strip -->
        <div class="grid">
          ${this.renderCell('Elapsed', formatNs(p.times.elapsedNs))}
          ${this.renderCell('Parse', formatNs(p.times.parseNs))}
          ${this.renderCell('Plan', formatNs(p.times.planNs))}
          ${this.renderCell('Result Count', p.resultCount.toLocaleString())}
          ${this.renderCell('FeatureFlags', p.featureFlags || '—')}
          ${this.renderCell('QueryType', p.queryType || '—')}
        </div>

        <!-- Card / Plan toggle -->
        <div>
          <div class="header-row">
            <span class="section-title">Execution Plan</span>
            <span class="plan-toggle">
              <button class=${this.planMode === 'card' ? 'active' : ''} @click=${() => this.planMode = 'card'}>Card</button>
              <button class=${this.planMode === 'plan' ? 'active' : ''} @click=${() => this.planMode = 'plan'}>Plan</button>
            </span>
          </div>
          <div style="margin-top:8px;">
            ${this.planMode === 'card'
              ? html`<ditto-profile-card-list .root=${p.plan}></ditto-profile-card-list>`
              : html`<ditto-profile-plan-tree .root=${p.plan}></ditto-profile-plan-tree>`}
          </div>
        </div>

        <!-- Footer -->
        <div class="footer">
          <span><span class="field-key">profile:</span> ${p.id}</span>
          <span class="sep">·</span>
          <span><span class="field-key">db:</span> ${p.appId || '—'}</span>
          <span class="sep">·</span>
          <span><span class="field-key">state:</span> ${p.state || '—'}</span>
        </div>

        <!-- Legend -->
        <div class="legend">
          <span class="section-title">Reading the badges</span>
          ${this.renderLegendRow('in', 'documents flowing in', 'blue')}
          ${this.renderLegendRow('out', 'documents flowing out', 'green')}
          ${this.renderLegendRow('exec', 'CPU time inside this operator', 'red')}
          ${this.renderLegendRow('recv', 'time waiting on upstream operators', 'orange')}
          ${this.renderLegendRow('send', 'time pushing output downstream', 'purple')}
        </div>
      </div>
    `;
  }

  private renderCell(label: string, value: string) {
    return html`<div class="cell"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  }

  private renderLegendRow(label: string, description: string, color: string) {
    return html`<div class="legend-row"><span class=${`swatch ${color}`}>${label}</span><span>${description}</span></div>`;
  }

  private renderHttpState() {
    return html`
      <div class="empty">
        <div class="title">Profiling runs on Local only</div>
        <div class="body">
          PROFILE is currently captured only when the query runs on the local SDK store.
          Switch the run mode to <code>Local</code> and re-run your SELECT to see an execution plan here.
        </div>
      </div>
    `;
  }

  private renderNonSelectState() {
    return html`
      <div class="empty">
        <div class="title">Profile is only captured for SELECT statements</div>
        <div class="body">
          Ditto's <code>PROFILE</code> keyword only supports <code>SELECT</code>.
          INSERT, UPDATE, DELETE, and EVICT have no profile.
        </div>
      </div>
    `;
  }

  private renderNoQueryYetState() {
    return html`
      <div class="empty">
        <div class="title">Run a query to capture a profile</div>
        <div class="body">
          Type a <code>SELECT</code> statement in the editor above and click Run.
          The execution plan will appear here.
        </div>
      </div>
    `;
  }
}
