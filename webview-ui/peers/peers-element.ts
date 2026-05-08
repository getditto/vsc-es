import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface LocalPeer { deviceName: string; sdkLanguage: string; sdkPlatform: string; sdkVersion: string; }
interface RemotePeer {
  id: string; deviceName?: string; sdkVersion?: string; os?: string;
  connections: Array<{ type: string; address?: string }>; lastUpdate: number;
}
interface PeerSnapshot { local: LocalPeer | null; remote: RemotePeer[]; }
type In = { type: 'peer.state'; snapshot: PeerSnapshot; sync: 'active' | 'idle' };
type Tab = 'list' | 'graph';

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';
  @state() private tab: Tab = 'list';

  static styles = css`
    :host { display: block; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }
    button { padding: 4px 10px; font: inherit; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tabs button { background: transparent; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); border-radius: 0; padding: 8px 12px; }
    .tabs button.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; min-height: 220px; }
    .card h3 { margin: 0 0 8px 0; font-size: 13px; }
    .card .row { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; margin: 4px 0; }
    .card .row .label { color: var(--vscode-descriptionForeground); }
    .pill { display: inline-block; padding: 2px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; font-size: 11px; }
    .placeholder { padding: 48px; text-align: center; color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border); border-radius: 6px; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') { this.snapshot = msg.snapshot; this.sync = msg.sync; }
    });
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  render() {
    return html`
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex:1"></span>
        <button @click=${this.toggleSync}>${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}</button>
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
        ${local ? html`
          <div class="card">
            <h3>Local Peer</h3>
            <div class="row"><span class="label">Device Name</span><span>${local.deviceName}</span></div>
            <div class="row"><span class="label">SDK Language</span><span>${local.sdkLanguage}</span></div>
            <div class="row"><span class="label">SDK Platform</span><span>${local.sdkPlatform}</span></div>
            <div class="row"><span class="label">SDK Version</span><span>${local.sdkVersion}</span></div>
          </div>
        ` : nothing}
        ${remote.map(r => html`
          <div class="card">
            <h3>${r.deviceName ?? r.id.slice(0, 12)}…</h3>
            <div class="row"><span class="label">Peer ID</span><span style="font-family: var(--vscode-editor-font-family); font-size: 11px">${r.id.slice(0, 24)}…</span></div>
            <div class="row"><span class="label">OS</span><span>${r.os ?? 'unknown'}</span></div>
            <div class="row"><span class="label">SDK Version</span><span>${r.sdkVersion ?? 'unknown'}</span></div>
            <div class="row"><span class="label">Connections</span><span>${r.connections.length}</span></div>
            ${r.connections.map(c => html`
              <div class="row"><span class="pill">${c.type}</span><span style="font-size: 11px; color: var(--vscode-descriptionForeground)">${c.address ?? ''}</span></div>
            `)}
            <div class="row"><span class="label">Last update</span><span>${new Date(r.lastUpdate).toLocaleTimeString()}</span></div>
          </div>
        `)}
      </div>
    `;
  }

  private renderGraphPlaceholder() {
    return html`<div class="placeholder">Presence Graph — coming soon.<br><br>The force-directed network visualization is planned for a future release.</div>`;
  }
}
