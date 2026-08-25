// webview-ui/databaseMetrics/database-metrics-element.ts
//
// On-demand storage panel. Top: 7 category cards for the on-disk
// breakdown plus a "total on disk" header. Bottom: sortable
// per-collection CBOR-payload table. Refresh button + last-refreshed
// timestamp; nothing polls.

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, HostMessages } from '../shared/messaging.js';

interface CollectionStats {
  name: string;
  documentCount: number;
  cborPayloadBytes: number;
}

interface DbMetricsSnapshot {
  storeBytes: number;
  replicationBytes: number;
  attachmentsBytes: number;
  authBytes: number;
  walShmBytes: number;
  logsBytes: number;
  otherBytes: number;
  collectionBreakdown: CollectionStats[];
  collectionPayloadBytes: number;
  totalDiskBytes: number;
  computedAt: number;
}

// ─── System metrics wire shapes (mirror of src/ipc/messages.ts) ──
interface SystemMetricSample {
  key: string;
  labels: Record<string, string>;
  description: string;
  unit: string;
  kind: 'counter' | 'histogram';
  sinceConnect: number;
  periodDelta: number;
  sumSinceConnect?: number;
  absMax?: number;
}

interface SystemMetricsSnapshot {
  samples: SystemMetricSample[];
  sinceMs: number;
  polledAtMs: number;
  pollIntervalMs: number;
}

type SystemMetricsStatus =
  | { kind: 'working'; snapshot: SystemMetricsSnapshot }
  | { kind: 'settingDisabled' }
  | { kind: 'exporterDisabled' }
  | { kind: 'noConnection' }
  | { kind: 'unavailable'; message: string };

type In =
  | { type: 'dbMetrics.loading' }
  | { type: 'dbMetrics.snapshot'; snapshot: DbMetricsSnapshot }
  | { type: 'dbMetrics.error'; message: string }
  | { type: 'dbMetrics.systemMetrics'; status: SystemMetricsStatus };

type ViewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; snapshot: DbMetricsSnapshot }
  | { kind: 'error'; message: string };

type SortKey = 'name' | 'documentCount' | 'cborPayloadBytes';
type SortDir = 'asc' | 'desc';

function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / (1024 * 1024)).toFixed(2)} MB`; }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function percent(part: number, whole: number): string {
  if (whole === 0) { return '0%'; }
  return `${((part / whole) * 100).toFixed(1)}%`;
}

const CATEGORY_LABEL: Record<string, string> = {
  storeBytes: 'Store',
  replicationBytes: 'Replication',
  attachmentsBytes: 'Attachments',
  authBytes: 'Auth',
  walShmBytes: 'WAL / SHM',
  logsBytes: 'Logs',
  otherBytes: 'Other',
};

const CATEGORY_DESCRIPTION: Record<string, string> = {
  storeBytes: 'Primary document store (the SQLite file). Grows with document count and field richness.',
  replicationBytes: 'Sync state — what this peer has told other peers it has, what it expects from them.',
  attachmentsBytes: 'Binary blobs linked from documents. Lives outside the document store.',
  authBytes: 'Auth tokens and session material. Usually tiny.',
  walShmBytes: 'SQLite write-ahead log + shared-memory files. Spikes mid-transaction; reclaimed on checkpoint.',
  logsBytes: 'SDK and extension log files. Safe to delete if you need disk space.',
  otherBytes: 'Lock files, metrics scratch, anything Ditto writes outside the named buckets.',
};

// ─── System metrics dashboard sections ─────────────────────────
// Exact metric keys (all Info level), per the SDK 5.1 source
// (ditto-link2/ditto-backend-sqlite3/ditto-sync-docs metrics.rs).
const DSOQ_KEYS = [
  'ditto.network.dsoq.connection.opened',
  'ditto.network.dsoq.connection.closed',
  'ditto.network.dsoq.handshake_failed',
  'ditto.network.dsoq.endpoint.connect_failed',
  'ditto.network.dsoq.tlv.decode_invalid',
  'ditto.network.dsoq.tlv.unknown_type_fatal',
  'ditto.network.dsoq.tlv.unknown_type_optional',
  'ditto.network.dsoq.stream.unreliable.datagram_dropped_no_stream',
  'ditto.network.dsoq.stream.reliable.implicit_refused',
];

const SQLITE_KEYS = [
  'ditto.backend.sqlite3.fsync_total',
  'ditto.backend.sqlite3.fsync_duration_secs',
  'ditto.backend.sqlite3.wal_size_pages',
  'ditto.backend.sqlite3.checkpoint_duration_secs',
];

const RECOVERY_KEYS = [
  'ditto.replication.metadata_corrupt_recoveries',
  'ditto.replication.session_resets',
];

/** `ditto.network.dsoq.connection.opened` → `connection.opened` */
function shortKey(key: string): string {
  const lastDotOfPrefix = key.lastIndexOf('.', key.indexOf('.', key.indexOf('.') + 1) + 1);
  return key.slice(lastDotOfPrefix + 1);
}

function formatNum(n: number, unit: string): string {
  if (unit === 'seconds') {
    if (n < 0.001) { return `${(n * 1_000_000).toFixed(0)} µs`; }
    if (n < 1) { return `${(n * 1000).toFixed(1)} ms`; }
    return `${n.toFixed(2)} s`;
  }
  return n.toLocaleString();
}

@customElement('ditto-database-metrics')
export class DatabaseMetricsElement extends LitElement {
  @state() private view: ViewState = { kind: 'idle' };
  @state() private sortKey: SortKey = 'cborPayloadBytes';
  @state() private sortDir: SortDir = 'desc';
  /** Latest system:metrics status from the host. `null` until the first
   *  poll/publish lands — the section shows a collecting state briefly. */
  @state() private systemMetrics: SystemMetricsStatus | null = null;

  static override styles = css`
    :host {
      display: block;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      box-sizing: border-box;
    }
    .header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 16px;
    }
    .header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .header .total {
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    .header .spacer { flex: 1; }
    .header .stamp {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .header button {
      padding: 4px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font: inherit;
    }
    .header button[disabled] { opacity: 0.5; cursor: not-allowed; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-bottom: 24px;
    }
    .card {
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .card .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .card .value {
      font-family: var(--vscode-editor-font-family);
      font-size: 14px;
      font-weight: 600;
      margin: 4px 0;
    }
    .card .pct {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .bar {
      height: 4px;
      background: var(--vscode-progressBar-background, var(--vscode-panel-border));
      border-radius: 2px;
      margin-top: 6px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    }
    .card-tooltip {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.35;
    }

    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .section-head h2 { margin: 0; font-size: 13px; font-weight: 600; }
    .section-head .sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    th {
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    th.sorted { color: var(--vscode-foreground); }
    th.numeric, td.numeric {
      text-align: right;
      font-family: var(--vscode-editor-font-family);
    }
    tr:hover td { background: var(--vscode-list-hoverBackground); }

    .empty {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .error {
      padding: 12px;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
    }

    .sys-section { margin-top: 28px; }
    .sys-note {
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
    .sys-note code {
      font-family: var(--vscode-editor-font-family);
      color: var(--vscode-foreground);
    }
    .sys-alert {
      margin: 8px 0;
      padding: 8px 12px;
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      border-radius: 4px;
      color: var(--vscode-editorWarning-foreground, #cca700);
      font-size: 12px;
    }
    .sys-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 4px 0 8px;
    }
    .sys-table th { cursor: default; }
    .sys-table td.labels {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
    }
    .sys-none {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 6px 0;
    }
  `;

  /** Host-message subscription. The controller owns its own lifetime, so a
   *  re-attach cannot leave a second handler bound to the stale element. */
  readonly hostMessages = new HostMessages<In>(this, msg => this.onHostMessage(msg));

  private onHostMessage(m: In): void {
    if (m.type === 'dbMetrics.loading') {
      this.view = { kind: 'loading' };
    } else if (m.type === 'dbMetrics.snapshot') {
      this.view = { kind: 'loaded', snapshot: m.snapshot };
    } else if (m.type === 'dbMetrics.error') {
      this.view = { kind: 'error', message: m.message };
    } else if (m.type === 'dbMetrics.systemMetrics') {
      this.systemMetrics = m.status;
    }
  }

  private refresh(): void {
    postToHost({ type: 'dbMetrics.refresh' });
  }

  private setSort(key: SortKey): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = key === 'name' ? 'asc' : 'desc';
    }
  }

  override render(): TemplateResult {
    const loading = this.view.kind === 'loading';
    const snap = this.view.kind === 'loaded' ? this.view.snapshot : undefined;
    const stamp = snap ? new Date(snap.computedAt).toLocaleTimeString() : null;
    return html`
      <div class="header">
        <h1>Database Metrics</h1>
        ${snap ? html`<span class="total">${formatBytes(snap.totalDiskBytes)} on disk</span>` : nothing}
        <span class="spacer"></span>
        ${stamp ? html`<span class="stamp">Refreshed at ${stamp}</span>` : nothing}
        <button ?disabled=${loading} @click=${this.refresh}>
          ${loading ? 'Computing…' : 'Refresh'}
        </button>
      </div>
      ${this.renderBody()}
      ${this.renderSystemMetrics()}
    `;
  }

  private renderBody(): TemplateResult {
    switch (this.view.kind) {
      case 'idle':
        return html`<div class="empty">Click Refresh to compute storage metrics.</div>`;
      case 'loading':
        return html`<div class="empty">Walking the data directory and scanning collections… this can take a moment for large databases.</div>`;
      case 'error':
        return html`<div class="error">${this.view.message}</div>`;
      case 'loaded':
        return this.renderLoaded(this.view.snapshot);
    }
  }

  private renderLoaded(s: DbMetricsSnapshot): TemplateResult {
    const cats: { key: keyof typeof CATEGORY_LABEL; bytes: number }[] = [
      { key: 'storeBytes',         bytes: s.storeBytes },
      { key: 'replicationBytes',   bytes: s.replicationBytes },
      { key: 'attachmentsBytes',   bytes: s.attachmentsBytes },
      { key: 'authBytes',          bytes: s.authBytes },
      { key: 'walShmBytes',        bytes: s.walShmBytes },
      { key: 'logsBytes',          bytes: s.logsBytes },
      { key: 'otherBytes',         bytes: s.otherBytes },
    ];
    return html`
      <div class="grid">
        ${cats.map(c => html`
          <div class="card">
            <div class="label">${CATEGORY_LABEL[c.key]}</div>
            <div class="value">${formatBytes(c.bytes)}</div>
            <div class="pct">${percent(c.bytes, s.totalDiskBytes)} of total</div>
            <div class="bar">
              <div class="bar-fill" style=${`width: ${s.totalDiskBytes === 0 ? 0 : (c.bytes / s.totalDiskBytes) * 100}%;`}></div>
            </div>
            <div class="card-tooltip">${CATEGORY_DESCRIPTION[c.key]}</div>
          </div>
        `)}
      </div>

      <div class="section-head">
        <h2>Collections by CBOR payload size</h2>
        <span class="sub">${s.collectionBreakdown.length} collection${s.collectionBreakdown.length === 1 ? '' : 's'} · ${formatBytes(s.collectionPayloadBytes)} total</span>
      </div>
      ${s.collectionBreakdown.length === 0
        ? html`<div class="empty">No user collections found.</div>`
        : this.renderCollectionTable(s)}
    `;
  }

  // ─── System metrics (SDK 5.1 system:metrics) ─────────────────

  private renderSystemMetrics(): TemplateResult | typeof nothing {
    const st = this.systemMetrics;
    let body: TemplateResult;
    if (st === null) {
      body = html`<div class="sys-none">Collecting — the first poll lands shortly after this panel opens…</div>`;
    } else if (st.kind === 'working') {
      body = this.renderSystemDashboard(st.snapshot);
    } else if (st.kind === 'settingDisabled') {
      body = html`
        <div class="sys-note">
          System metrics are disabled. Enable
          <code>dittoVsce.collectSystemMetrics</code> and reconnect this database —
          the SDK enables the <code>system:metrics</code> exporter at connection
          startup only (runtime changes are ignored by Ditto).
        </div>`;
    } else if (st.kind === 'exporterDisabled') {
      body = html`
        <div class="sys-note">
          <code>system:metrics</code> exporter is off for this connection — it was
          opened with <code>dittoVsce.collectSystemMetrics</code> disabled. The
          exporter parameter is startup-only, so the fix is: enable the setting,
          then disconnect and reconnect this database.
        </div>`;
    } else if (st.kind === 'noConnection') {
      body = html`<div class="sys-note">No active connection — connect this database to show system metrics.</div>`;
    } else {
      body = html`<div class="sys-note">System metrics unavailable: ${st.message}</div>`;
    }
    return html`
      <div class="sys-section">
        <div class="section-head"><h2>System metrics</h2></div>
        ${body}
      </div>
    `;
  }

  private renderSystemDashboard(snap: SystemMetricsSnapshot): TemplateResult {
    const since = new Date(snap.sinceMs).toLocaleTimeString();
    const polled = new Date(snap.polledAtMs).toLocaleTimeString();
    return html`
      <div class="sys-hint">
        Totals since ${since}; last polled ${polled}, every ${(snap.pollIntervalMs / 1000).toFixed(0)}s.
        Values accumulate per-read deltas — <code>system:metrics</code> reads flush Ditto's counters.
      </div>
      ${this.renderDsoqSection(snap)}
      ${this.renderSqliteSection(snap)}
      ${this.renderRecoverySection(snap)}
    `;
  }

  private samplesFor(snap: SystemMetricsSnapshot, keys: string[]): SystemMetricSample[] {
    const wanted = new Set(keys);
    return snap.samples
      .filter(s => wanted.has(s.key))
      .sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key)
        || JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));
  }

  private renderMetricTable(title: string, keys: string[], snap: SystemMetricsSnapshot, hint?: string): TemplateResult {
    const rows = this.samplesFor(snap, keys);
    return html`
      <div class="section-head"><h2>${title}</h2></div>
      ${hint ? html`<div class="sys-hint">${hint}</div>` : nothing}
      ${rows.length === 0
        ? html`<div class="sys-none">No observations yet — these metrics appear once there is matching activity.</div>`
        : html`
          <table class="sys-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Labels</th>
                <th class="numeric">Since connect</th>
                <th class="numeric">Last period</th>
                <th class="numeric">Detail</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => html`
                <tr>
                  <td>${shortKey(r.key)}</td>
                  <td class="labels">${Object.entries(r.labels).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                  <td class="numeric">${formatNum(r.sinceConnect, r.kind === 'histogram' ? 'count' : r.unit)}</td>
                  <td class="numeric">${formatNum(r.periodDelta, r.kind === 'histogram' ? 'count' : r.unit)}</td>
                  <td class="numeric">${r.kind === 'histogram'
                    ? html`${r.sinceConnect > 0 ? html`avg ${formatNum((r.sumSinceConnect ?? 0) / r.sinceConnect, r.unit)}` : nothing}${r.absMax !== undefined ? html` · max ${formatNum(r.absMax, r.unit)}` : nothing}`
                    : r.description}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    `;
  }

  private totalFor(snap: SystemMetricsSnapshot, key: string): number {
    return snap.samples.filter(s => s.key === key).reduce((acc, s) => acc + s.sinceConnect, 0);
  }

  private renderDsoqSection(snap: SystemMetricsSnapshot): TemplateResult {
    const opened = this.totalFor(snap, 'ditto.network.dsoq.connection.opened');
    const closed = this.totalFor(snap, 'ditto.network.dsoq.connection.closed');
    const divergence = opened - closed;
    return html`
      ${opened + closed > 0 && divergence !== 0 ? html`
        <div class="sys-alert">
          Connections opened (${opened.toLocaleString()}) and closed (${closed.toLocaleString()}) diverge
          by ${Math.abs(divergence).toLocaleString()} — divergence indicates a connection
          leak or handshake instability.
        </div>
      ` : nothing}
      ${this.renderMetricTable(
        'DSOQ network',
        DSOQ_KEYS,
        snap,
        'Non-zero tlv.unknown_type_* counts indicate interop/version skew between peers.',
      )}
    `;
  }

  private renderSqliteSection(snap: SystemMetricsSnapshot): TemplateResult {
    return this.renderMetricTable(
      'SQLite per database role',
      SQLITE_KEYS,
      snap,
      'Broken down by labels.db: main / replication_metadata / attachment / system_info.',
    );
  }

  private renderRecoverySection(snap: SystemMetricsSnapshot): TemplateResult {
    return this.renderMetricTable(
      'Replication recovery',
      RECOVERY_KEYS,
      snap,
      'Non-zero counts here mean replication metadata needed recovery, or a sync session was reset (see labels.cause).',
    );
  }

  private renderCollectionTable(s: DbMetricsSnapshot): TemplateResult {
    const sorted = [...s.collectionBreakdown].sort((a, b) => {
      const dir = this.sortDir === 'asc' ? 1 : -1;
      switch (this.sortKey) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'documentCount':
          return (a.documentCount - b.documentCount) * dir;
        case 'cborPayloadBytes':
          return (a.cborPayloadBytes - b.cborPayloadBytes) * dir;
      }
    });
    const arrow = (k: SortKey): string => this.sortKey === k ? (this.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    const thClass = (k: SortKey, numeric = false): string => {
      const classes: string[] = [];
      if (numeric) { classes.push('numeric'); }
      if (this.sortKey === k) { classes.push('sorted'); }
      return classes.join(' ');
    };
    return html`
      <table>
        <thead>
          <tr>
            <th class=${thClass('name')} @click=${() => this.setSort('name')}>Name${arrow('name')}</th>
            <th class=${thClass('documentCount', true)} @click=${() => this.setSort('documentCount')}>Documents${arrow('documentCount')}</th>
            <th class=${thClass('cborPayloadBytes', true)} @click=${() => this.setSort('cborPayloadBytes')}>CBOR size${arrow('cborPayloadBytes')}</th>
            <th class="numeric">% of payload</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => html`
            <tr>
              <td>${r.name}</td>
              <td class="numeric">${r.documentCount.toLocaleString()}</td>
              <td class="numeric">${formatBytes(r.cborPayloadBytes)}</td>
              <td class="numeric">${percent(r.cborPayloadBytes, s.collectionPayloadBytes)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    `;
  }
}
