import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';

interface ConnectionInfo {
  id: string; connectionType: string; peer1: string; peer2: string;
}
interface PeerInfo {
  id: string; isDittoServer: boolean; deviceName: string; os?: string; dittoSdkVersion?: string;
  peerMetadata?: Record<string, unknown>; identityMetadata?: Record<string, unknown>;
  connections: ConnectionInfo[]; syncSessionStatus: string;
  syncedUpToLocalCommitId?: number; lastUpdateReceivedTime?: number;
}
interface LocalPeerInfo {
  deviceName: string; sdkLanguage: string; sdkPlatform: string; sdkVersion: string;
}
interface PeerListSnapshot { local: LocalPeerInfo | null; remote: PeerInfo[]; }
type In = { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };

@customElement('ditto-peer-listing')
export class PeerListing extends LitElement {
  @state() private snapshot: PeerListSnapshot = { local: null, remote: [] };
  @state() private sync: 'active' | 'idle' = 'idle';

  static styles = css`
    :host { display: block; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.active { background: var(--vscode-charts-green); }
    .dot.idle { background: var(--vscode-charts-red); }
    button { padding: 4px 10px; font: inherit; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; }
    pre { background: var(--vscode-editor-background); padding: 12px; border-radius: 6px; overflow: auto; max-height: 70vh; }
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
      <p style="color: var(--vscode-descriptionForeground); margin: 8px 0;">
        Real-data preview (UI rewrite ships next):
      </p>
      <pre>${JSON.stringify(this.snapshot, null, 2)}</pre>
    `;
  }
}
