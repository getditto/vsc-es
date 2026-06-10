import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';
import './components/summary-header.js';
import './components/problems-list.js';
import './components/histograms-row.js';
import './components/connection-timeline.js';
import './components/live-tail.js';
import type { AnalyzerOut } from '../../src/ipc/messages.js';
import type {
  AnalyzerState,
  LogLine,
  ProblemInstance,
  Session,
} from '../../src/logAnalyzer/types.js';

/** Root element for the Log Analyzer panel. Owns the IPC message
 *  listener and the aggregate analyzer state derived from
 *  `AnalyzerOut` diffs. All child components (`summary-header`,
 *  `problems-list`, `histograms-row`, `connection-timeline`,
 *  `live-tail`) are pure presentation.
 *
 *  Message wire-up: messages from the host are coalesced incremental
 *  diffs (`analyzer.summary`, `analyzer.problemsAdded`,
 *  `analyzer.histogramsUpdated`, `analyzer.sessionsUpdated`,
 *  `analyzer.live`, …). The webview keeps its own grouped map of
 *  problems keyed by pattern, rebuilt only when needed for render.
 *  The host owns the source of truth — `analyzer.reset` wipes our
 *  local view.
 *
 *  Note: `reinits` is not currently emitted as a separate message —
 *  it's kept as state so future versions can push reinit markers from
 *  the host without changing the component contract. */
@customElement('ditto-log-analyzer')
export class DittoLogAnalyzer extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 12px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      box-sizing: border-box;
    }
    .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0;
      padding: 4px 10px;
      cursor: pointer;
      font: inherit;
      border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .banner {
      color: var(--vscode-inputValidation-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 6px 10px;
      margin: 6px 0;
      border-radius: 4px;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; }
  `;

  @state() private counts: AnalyzerState['counts'] | null = null;
  @state() private problems: Map<string, ProblemInstance[]> = new Map();
  @state() private tags: string[] = [];
  @state() private sdkVersion: string | null = null;
  @state() private errorBanner: string | null = null;
  @state() private histograms: AnalyzerState['histograms'] = {
    volumeByLevel: [],
    problemsOverTime: [],
    connectionDurations: [],
  };
  @state() private sessions: Session[] = [];
  @state() private reinits: Date[] = [];
  @state() private liveLines: LogLine[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<AnalyzerOut>(this.handleMessage);
    this.addEventListener('reveal-line', this.onRevealLine as EventListener);
  }

  disconnectedCallback(): void {
    this.removeEventListener('reveal-line', this.onRevealLine as EventListener);
    super.disconnectedCallback();
  }

  private onRevealLine = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { id: number };
    postToHost({ type: 'analyzer.revealLine', lineId: detail.id });
  };

  private handleMessage = (m: AnalyzerOut): void => {
    if (!m) { return; }
    switch (m.type) {
      case 'analyzer.summary':
        this.counts = m.counts;
        break;
      case 'analyzer.problemsAdded': {
        // Append to an existing group or open a new one. We mutate the
        // map in place then call requestUpdate() since @state on a Map
        // doesn't trigger on internal mutations.
        for (const it of m.items) {
          const arr = this.problems.get(it.patternKey) ?? [];
          arr.push(it);
          this.problems.set(it.patternKey, arr);
        }
        this.requestUpdate();
        break;
      }
      case 'analyzer.reset':
        this.counts = null;
        this.problems = new Map();
        this.histograms = {
          volumeByLevel: [],
          problemsOverTime: [],
          connectionDurations: [],
        };
        this.sessions = [];
        this.reinits = [];
        this.liveLines = [];
        this.errorBanner = null;
        this.requestUpdate();
        break;
      case 'analyzer.error':
        this.errorBanner = `[${m.stage}] ${m.message}`;
        this.requestUpdate();
        break;
      case 'analyzer.histogramsUpdated':
        this.histograms = m.histograms;
        break;
      case 'analyzer.sessionsUpdated':
        this.sessions = m.sessions;
        break;
      case 'analyzer.live':
        // Cap the buffer at 1000 lines; the child component clips to
        // the most recent 200 for render but we retain a longer tail
        // here so the user can scroll back briefly.
        this.liveLines = [...this.liveLines, ...m.lines].slice(-1000);
        break;
      default:
        break;
    }
  };

  /** Sort groups by max severity (5 → 1) so CRITICAL/HIGH float to
   *  the top. Ties keep insertion order, which roughly maps to
   *  first-seen-first. */
  private problemGroups(): { key: string; items: ProblemInstance[] }[] {
    return [...this.problems.entries()]
      .map(([key, items]) => ({ key, items }))
      .sort((a, b) => (b.items[0]?.severity ?? 0) - (a.items[0]?.severity ?? 0));
  }

  render(): TemplateResult {
    return html`
      <div class="toolbar">
        <button @click=${() => postToHost({ type: 'analyzer.pause' })}>⏸ Pause</button>
        <button @click=${() => postToHost({ type: 'analyzer.resume' })}>▶ Resume</button>
        <button @click=${() => postToHost({ type: 'analyzer.clear' })}>⨯ Clear</button>
        <button @click=${() => postToHost({ type: 'analyzer.openPatternEditor' })}>⚙ Patterns</button>
      </div>
      ${this.errorBanner ? html`<div class="banner">${this.errorBanner}</div>` : ''}
      <div class="stack">
        <summary-header
          .counts=${this.counts}
          .tags=${this.tags}
          .sdkVersion=${this.sdkVersion}
        ></summary-header>
        <problems-list .groups=${this.problemGroups()}></problems-list>
        <histograms-row .histograms=${this.histograms}></histograms-row>
        <connection-timeline .sessions=${this.sessions} .reinits=${this.reinits}></connection-timeline>
        <live-tail .lines=${this.liveLines}></live-tail>
      </div>
    `;
  }
}
