import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

// ─── Types (mirror src/models/DittoConfig.ts; can't import from ext host) ──

type PeerOS = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';
type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';
type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected' | 'Unknown';

interface ConnectionInfo {
  id: string;
  connectionType: ConnectionType;
  peer1: string;
  peer2: string;
}

interface PeerInfo {
  id: string;
  isDittoServer: boolean;
  deviceName: string;
  os?: PeerOS;
  dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>;
  identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[];
  syncSessionStatus: SyncSessionStatus;
  syncedUpToLocalCommitId?: number;
  lastUpdateReceivedTime?: number;
}

interface LocalPeerInfo {
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
}

type In = { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };

// ─── Visual mappings ─────────────────────────────────────────────

type DominantType = 'cloud' | 'WebSocket' | 'AccessPoint' | 'P2PWiFi' | 'Bluetooth' | 'unknown';

const GRADIENTS: Record<DominantType, [string, string]> = {
  cloud:       ['rgb(115, 38, 184)', 'rgb(71, 18, 122)'],
  WebSocket:   ['rgb(217, 122, 0)',  'rgb(153, 77, 0)'],
  AccessPoint: ['rgb(13, 133, 64)',  'rgb(5, 82, 36)'],
  P2PWiFi:     ['rgb(199, 26, 56)',  'rgb(128, 10, 31)'],
  Bluetooth:   ['rgb(0, 102, 217)',  'rgb(0, 51, 153)'],
  unknown:     ['rgb(89, 89, 102)',  'rgb(51, 51, 64)'],
};

const LOCAL_GRADIENT: [string, string] = ['rgb(20, 20, 20)', 'rgb(0, 0, 0)'];

function dominantType(peer: PeerInfo): DominantType {
  if (peer.isDittoServer) { return 'cloud'; }
  for (const t of ['WebSocket', 'AccessPoint', 'P2PWiFi', 'Bluetooth'] as const) {
    if (peer.connections.some(c => c.connectionType === t)) { return t; }
  }
  return 'unknown';
}

function osIcon(os: PeerOS | undefined): string {
  switch (os) {
    case 'iOS': case 'macOS': case 'Generic': return 'codicon-device-mobile';
    case 'Android': return 'codicon-device-mobile';
    case 'Windows': case 'Linux': case 'tvOS': return 'codicon-terminal';
    default: return 'codicon-question';
  }
}

function osDisplay(os: PeerOS | undefined): string {
  return os ?? 'Unknown';
}

function connectionIcon(type: ConnectionType): string {
  switch (type) {
    case 'Bluetooth': return 'codicon-radio-tower';
    case 'AccessPoint': return 'codicon-broadcast';
    case 'P2PWiFi': return 'codicon-circuit-board';
    case 'WebSocket': return 'codicon-cloud';
  }
}

function connectionDisplay(type: ConnectionType): string {
  switch (type) {
    case 'Bluetooth': return 'Bluetooth';
    case 'AccessPoint': return 'WiFi AP';
    case 'P2PWiFi': return 'P2P WiFi';
    case 'WebSocket': return 'WebSocket';
  }
}

function statusDotColor(status: SyncSessionStatus): string {
  switch (status) {
    case 'Connected': return 'var(--vscode-charts-green)';
    case 'Connecting': return 'var(--vscode-charts-orange)';
    case 'Disconnected': return 'var(--vscode-charts-red)';
    default: return 'var(--vscode-descriptionForeground)';
  }
}

function formatLastUpdate(ms: number | undefined): string {
  if (!ms) { return 'Never'; }
  const now = Date.now();
  const delta = now - ms;
  if (delta < 60_000) { return 'just now'; }
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerListSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';
  @state() private tab: 'list' | 'graph' = 'list';
  @state() private copiedId: string | null = null;
  @state() private nowTick = 0;

  private tickInterval: number | null = null;

  static styles = css`
    /* @font-face for codicon registers at document level via panelHtml's <link>;
       the rules below define .codicon glyphs INSIDE shadow DOM (Lit Constructed
       Stylesheets don't support @import, and class selectors don't cross
       shadow boundaries). */
    .codicon {
      font: normal normal normal 16px/1 codicon;
      display: inline-block;
      text-decoration: none;
      text-rendering: auto;
      text-align: center;
      text-transform: none;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      user-select: none;
    }
    .codicon-info::before        { content: '\\ea74'; }
    .codicon-clock::before       { content: '\\ea82'; }
    .codicon-terminal::before    { content: '\\ea85'; }
    .codicon-broadcast::before   { content: '\\eaad'; }
    .codicon-check::before       { content: '\\eab2'; }
    .codicon-circuit-board::before { content: '\\eabe'; }
    .codicon-device-mobile::before { content: '\\eadb'; }
    .codicon-globe::before       { content: '\\eb01'; }
    .codicon-link::before        { content: '\\eb15'; }
    .codicon-package::before     { content: '\\eb29'; }
    .codicon-question::before    { content: '\\eb32'; }
    .codicon-radio-tower::before { content: '\\eb34'; }
    .codicon-cloud::before       { content: '\\ebaa'; }

    :host {
      display: block;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
    }

    .page-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 12px 0;
      color: var(--vscode-foreground);
    }

    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }

    .toolbar-button {
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }

    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tabs button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      padding: 8px 12px;
      cursor: pointer;
      font: inherit;
    }
    .tabs button.active {
      color: var(--vscode-foreground);
      border-bottom-color: var(--vscode-focusBorder);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }

    .card {
      min-height: 200px;
      padding: 14px;
      border-radius: 10px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
      color: white;
      display: flex;
      flex-direction: column;
      animation: card-in 350ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes card-in {
      from { transform: scale(0.88); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .card-title-block {
      min-width: 0;
      flex: 1;
    }

    .card-name {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 2px 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-os, .card-row {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.85);
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 2px 0;
    }
    .card-os .codicon, .card-row .codicon {
      font-size: 11px;
      flex-shrink: 0;
    }

    .card-id {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: rgba(255, 255, 255, 0.75);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      margin-top: 4px;
    }
    .card-id.copied {
      color: var(--vscode-charts-green);
    }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      flex-shrink: 0;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 10px;
    }
    .status .dot {
      width: 7px;
      height: 7px;
    }

    .divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.22);
      margin: 10px 0;
    }

    .card-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }

    .badges {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .badge {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.14);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 5px;
      font-size: 11px;
    }

    details summary {
      cursor: pointer;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.85);
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary::after {
      content: '\\25B6';
      font-size: 8px;
      margin-left: auto;
      transition: transform 150ms;
    }
    details[open] summary::after {
      transform: rotate(90deg);
    }
    details pre {
      margin: 6px 0 0 0;
      padding: 6px 8px;
      background: rgba(0, 0, 0, 0.28);
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: rgba(255, 255, 255, 0.85);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 160px;
      overflow: auto;
    }

    .empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 32px;
      text-align: center;
    }

    .placeholder {
      padding: 48px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 6px;
    }

    /* Local Peer card — black gradient, key/value layout */
    .local-card .card-name { font-size: 13px; }
    .local-card .card-row { justify-content: space-between; }
    .local-card .card-row .label { color: rgba(255,255,255,0.65); }
    .local-card .card-row .value {
      color: white;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      text-align: right;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') { this.snapshot = msg.snapshot; this.sync = msg.sync; }
    });
    this.tickInterval = window.setInterval(() => { this.nowTick++; }, 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.tickInterval !== null) { window.clearInterval(this.tickInterval); }
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  private async copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      this.copiedId = id;
      setTimeout(() => { if (this.copiedId === id) { this.copiedId = null; } }, 1500);
    } catch { /* clipboard may be unavailable; silently fail */ }
  }

  render() {
    return html`
      <h1 class="page-title">Connected Peers</h1>
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex: 1"></span>
        <button class="toolbar-button" @click=${this.toggleSync}>
          ${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}
        </button>
      </div>

      <div class="tabs" role="tablist">
        <button class=${this.tab === 'list' ? 'active' : ''} @click=${() => this.tab = 'list'}>Connected Peers</button>
        <button class=${this.tab === 'graph' ? 'active' : ''} @click=${() => this.tab = 'graph'}>Presence Graph</button>
      </div>

      ${this.tab === 'list' ? this.renderList() : this.renderGraphPlaceholder()}
    `;
  }

  private renderList() {
    const { local, remote } = this.snapshot;
    if (!local && remote.length === 0) {
      return html`<div class="empty">No sync status available. Connect to see peers.</div>`;
    }
    return html`
      <div class="grid">
        ${repeat(remote, p => p.id, p => this.renderRemoteCard(p))}
        ${local ? this.renderLocalCard(local) : nothing}
      </div>
    `;
  }

  private renderLocalCard(local: LocalPeerInfo) {
    const [start, end] = LOCAL_GRADIENT;
    const style = `background: linear-gradient(135deg, ${start}, ${end});`;
    return html`
      <div class="card local-card" style=${style}>
        <div class="card-header">
          <div class="card-title-block">
            <div class="card-row"><i class="codicon codicon-globe"></i><span>Local Peer</span></div>
            <h3 class="card-name" title=${local.deviceName}>${local.deviceName || '(unnamed)'}</h3>
          </div>
        </div>
        <div class="divider"></div>
        <div class="card-body">
          <div class="card-row"><span class="label">Device Name</span><span class="value">${local.deviceName}</span></div>
          <div class="card-row"><span class="label">SDK Language</span><span class="value">${local.sdkLanguage || '—'}</span></div>
          <div class="card-row"><span class="label">SDK Platform</span><span class="value">${local.sdkPlatform || '—'}</span></div>
          <div class="card-row"><span class="label">SDK Version</span><span class="value">${local.sdkVersion || '—'}</span></div>
        </div>
      </div>
    `;
  }

  private renderRemoteCard(peer: PeerInfo) {
    const dt = dominantType(peer);
    const [start, end] = GRADIENTS[dt];
    const style = `background: linear-gradient(135deg, ${start}, ${end});`;
    const idCopied = this.copiedId === peer.id;
    const idDisplay = peer.id.length > 32 ? peer.id.slice(0, 32) + '…' : peer.id;
    void this.nowTick; // re-read nowTick so relative-time refreshes every 30s
    return html`
      <div class="card" style=${style}>
        <div class="card-header">
          <div class="card-title-block">
            <h3 class="card-name" title=${peer.deviceName}>${peer.deviceName || (peer.isDittoServer ? 'Ditto Server' : 'Peer Device')}</h3>
            <div class="card-os">
              <i class="codicon ${osIcon(peer.os)}"></i>
              <span>${osDisplay(peer.os)}</span>
            </div>
            <div class="card-id ${idCopied ? 'copied' : ''}"
                 title="Double-click to copy: ${peer.id}"
                 @dblclick=${() => this.copyId(peer.id)}>
              ${idDisplay}
            </div>
          </div>
          <div class="status">
            <div class="dot" style="background: ${statusDotColor(peer.syncSessionStatus)}"></div>
            <span>${peer.syncSessionStatus}</span>
          </div>
        </div>

        <div class="divider"></div>

        <div class="card-body">
          ${peer.dittoSdkVersion ? html`
            <div class="card-row">
              <i class="codicon codicon-package"></i>
              <span>Ditto SDK: ${peer.dittoSdkVersion}</span>
            </div>
          ` : nothing}

          ${peer.identityMetadata ? html`
            <details>
              <summary><i class="codicon codicon-info"></i><span>Identity Metadata</span></summary>
              <pre>${JSON.stringify(peer.identityMetadata, null, 2)}</pre>
            </details>
          ` : nothing}

          ${peer.peerMetadata ? html`
            <details>
              <summary><i class="codicon codicon-info"></i><span>Peer Metadata</span></summary>
              <pre>${JSON.stringify(peer.peerMetadata, null, 2)}</pre>
            </details>
          ` : nothing}

          ${peer.connections.length > 0 ? html`
            <div class="card-row">
              <i class="codicon codicon-link"></i>
              <span>Active Connections (${peer.connections.length})</span>
            </div>
            <div class="badges">
              ${peer.connections.map(c => html`
                <div class="badge">
                  <i class="codicon ${connectionIcon(c.connectionType)}"></i>
                  <span>${connectionDisplay(c.connectionType)}</span>
                </div>
              `)}
            </div>
          ` : nothing}

          ${peer.syncedUpToLocalCommitId !== undefined ? html`
            <div class="card-row">
              <i class="codicon codicon-check"></i>
              <span>Synced to commit: ${peer.syncedUpToLocalCommitId}</span>
            </div>
          ` : nothing}

          <div class="card-row">
            <i class="codicon codicon-clock"></i>
            <span>Last update: ${formatLastUpdate(peer.lastUpdateReceivedTime)}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderGraphPlaceholder() {
    return html`<div class="placeholder">Presence Graph — coming soon.<br><br>The force-directed network visualization is planned for a future release.</div>`;
  }
}
