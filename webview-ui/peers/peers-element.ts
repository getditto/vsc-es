import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { postToHost, onHostMessage } from '../shared/messaging.js';
import '../presence-graph/presence-graph-element.js';
import type { PresenceGraphInput } from '../presence-graph/scene.js';

// ─── Types (mirror src/models/DittoConfig.ts; can't import from ext host) ──

type PeerOS = 'iOS' | 'Android' | 'macOS' | 'Linux' | 'Windows' | 'tvOS' | 'Generic';
type ConnectionType = 'P2PWiFi' | 'WebSocket' | 'AccessPoint' | 'Bluetooth';
type SyncSessionStatus = 'Connected' | 'Connecting' | 'Disconnected';

interface LocalNetworkInterface {
  name: string;
  // Wi-Fi and Ethernet are intentionally collapsed into 'lan' —
  // os.networkInterfaces() can't tell them apart and our network
  // graph already uses LAN as the umbrella for both.
  kind: 'lan' | 'loopback' | 'other';
  mac?: string;
  ipv4: { address: string; cidr: string }[];
  ipv6: { address: string; cidr: string; scopeid?: number }[];
}

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
  /** peerKey from presence.localPeer; the graph view uses it as the
   *  BFS root and to recognise local-involving edges. */
  peerKey: string;
  deviceName: string;
  sdkLanguage: string;
  sdkPlatform: string;
  sdkVersion: string;
}

interface RawPresenceGraph {
  remotePeers: { peerKey: string; deviceName: string }[];
  connections: { peer1: string; peer2: string; connectionType: ConnectionType }[];
}

interface PeerListSnapshot {
  local: LocalPeerInfo | null;
  remote: PeerInfo[];
  /** Unfiltered presence graph — the graph webview uses this when
   *  the user has "Direct Connected only" turned off. */
  presenceGraph?: RawPresenceGraph;
}

type Platform = 'macos' | 'windows' | 'linux' | 'other';
interface TransportSupport { lan: boolean; bluetoothLE: boolean; awdl: boolean; }
interface TransportPrefs { isLanEnabled: boolean; isBluetoothLeEnabled: boolean; isAwdlEnabled: boolean; }
type ApplyStep = 'idle' | 'stoppingSync' | 'applyingConfig' | 'restartingSync' | 'complete' | 'error';

type In =
  | { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' }
  | {
      type: 'peer.platformInit';
      platform: Platform;
      support: TransportSupport;
      current: TransportPrefs;
    }
  | { type: 'peer.transportApplyStatus'; step: Exclude<ApplyStep, 'error'>; message?: string }
  | { type: 'peer.transportApplyError'; message: string }
  | { type: 'peer.localNetwork'; interfaces: LocalNetworkInterface[] };

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

/** Per-kind background gradients for the network-interface cards.
 *  Mirror SwiftUI's NetworkInterfaceCard palette: green for Wi-Fi,
 *  teal for Ethernet, neutral grey for other. */
const INTERFACE_GRADIENTS: Record<LocalNetworkInterface['kind'], [string, string]> = {
  // Green matches the AccessPoint (LAN) colour in our network-graph
  // connection palette, so the same idea reads the same way in both
  // places.
  lan:      ['rgb(13, 133, 64)',  'rgb(5, 82, 36)'],
  loopback: ['rgb(75, 75, 80)',   'rgb(45, 45, 50)'],
  other:    ['rgb(89, 89, 102)',  'rgb(51, 51, 64)'],
};

/** Codicon glyph for each interface kind. */
const INTERFACE_KIND_ICON: Record<LocalNetworkInterface['kind'], string> = {
  lan: 'globe',
  loopback: 'circle-slash',
  other: 'symbol-misc',
};

/** Friendly label for each interface kind. */
const INTERFACE_KIND_LABEL: Record<LocalNetworkInterface['kind'], string> = {
  lan: 'LAN',
  loopback: 'Loopback',
  other: 'Network',
};

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
  /** Bound to the toggle in the graph tab. SwiftUI default is true
   *  (only direct neighbours of local), but we offer the toggle so
   *  multi-hop topology debugging works too. */
  @state() private directConnectedOnly = true;
  /** Local network interfaces pushed by the host. Empty until the
   *  initial post arrives (typically within ~50ms of webview reveal). */
  @state() private localInterfaces: LocalNetworkInterface[] = [];
  @state() private copiedId: string | null = null;
  @state() private nowTick = 0;

  // ─── Transport configuration popover ──────────────────────────
  @state() private support: TransportSupport = { lan: true, bluetoothLE: false, awdl: false };
  @state() private baseline: TransportPrefs = { isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false };
  @state() private form: TransportPrefs = { isLanEnabled: true, isBluetoothLeEnabled: false, isAwdlEnabled: false };
  @state() private platformReceived = false;
  @state() private showTransportPopover = false;
  @state() private applyStep: ApplyStep = 'idle';
  @state() private applyMessage: string | undefined;

  private tickInterval: number | null = null;
  private completeClearTimer: number | null = null;

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
    .codicon-chrome-close::before { content: '\\eab8'; }
    .codicon-circuit-board::before { content: '\\eabe'; }
    .codicon-close::before       { content: '\\ea76'; }
    .codicon-device-mobile::before { content: '\\eadb'; }
    .codicon-gear::before        { content: '\\eaf8'; }
    .codicon-globe::before       { content: '\\eb01'; }
    .codicon-link::before        { content: '\\eb15'; }
    .codicon-package::before     { content: '\\eb29'; }
    .codicon-question::before    { content: '\\eb32'; }
    .codicon-radio-tower::before { content: '\\eb34'; }
    .codicon-warning::before     { content: '\\ea6c'; }
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

    /* Local Network section divider: thin rule with the section
       title inline, mirroring the SwiftUI ConnectedPeersView layout.
       The refresh button rides on the right end of the divider so it
       doesn't take a full toolbar row of its own. */
    .local-net-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 24px 16px 12px;
    }
    .local-net-divider-line {
      flex: 1;
      height: 1px;
      background: var(--vscode-panel-border, rgba(255, 255, 255, 0.15));
    }
    .local-net-divider-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
    }
    .local-net-refresh {
      background: transparent;
      border: 0;
      padding: 0;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      opacity: 0.75;
    }
    .local-net-refresh:hover { opacity: 1; color: var(--vscode-foreground); }
    .local-net-refresh .codicon { font-size: 14px; }
    .value.mono {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      word-break: break-all;
    }

    /* Graph tab: canvas fills the available area; the small filter
       toggle floats above it on the top-left mirroring the SwiftUI
       layout (zoom controls live inside the graph element on the
       bottom-right). */
    .graph-host {
      position: relative;
      width: 100%;
      height: calc(100vh - 140px);
      min-height: 400px;
    }
    .graph-toggle {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 10;
      padding: 6px 10px;
      background: rgba(30, 30, 30, 0.85);
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      font-size: 11px;
      color: var(--vscode-foreground);
      backdrop-filter: blur(8px);
    }
    .graph-toggle label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .graph-toggle input { cursor: pointer; }
    ditto-presence-graph { width: 100%; height: 100%; display: block; }

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

    /* ─── Transport configuration popover ──────────────── */
    .toolbar-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      font: inherit;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
    }
    .toolbar-icon-button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }
    .toolbar-icon-button:disabled { opacity: 0.5; cursor: not-allowed; }

    .popover-anchor { position: relative; display: inline-block; }
    .popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      width: 360px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      padding: 14px;
      z-index: 1000;
      font-size: 12px;
    }
    .popover-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0 0 10px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .popover-close {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px;
      opacity: 0.7;
    }
    .popover-close:hover { opacity: 1; }

    .banner {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      padding: 8px 10px;
      border-radius: 4px;
      margin-bottom: 10px;
      font-size: 11px;
      line-height: 1.4;
    }
    .banner.warning {
      background: var(--vscode-inputValidation-warningBackground, rgba(255, 184, 0, 0.12));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 184, 0, 0.5));
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    }
    .banner.info {
      background: var(--vscode-inputValidation-infoBackground, rgba(60, 150, 255, 0.12));
      border: 1px solid var(--vscode-inputValidation-infoBorder, rgba(60, 150, 255, 0.5));
      color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground));
    }
    .banner.error {
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 80, 80, 0.12));
      border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 80, 80, 0.5));
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    }
    .banner.success {
      background: rgba(60, 180, 90, 0.12);
      border: 1px solid rgba(60, 180, 90, 0.5);
      color: var(--vscode-foreground);
    }

    .transport-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .transport-row:last-of-type { border-bottom: none; }
    .transport-row-text { flex: 1; min-width: 0; }
    .transport-row-title {
      font-size: 12px;
      font-weight: 600;
      margin: 0 0 2px 0;
    }
    .transport-row-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin: 0;
    }

    /* Toggle switch */
    .switch {
      position: relative;
      display: inline-block;
      width: 32px;
      height: 18px;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .switch .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: var(--vscode-checkbox-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border, transparent));
      border-radius: 18px;
      transition: background-color 150ms;
    }
    .switch .slider::before {
      position: absolute;
      content: '';
      height: 12px;
      width: 12px;
      left: 2px;
      bottom: 2px;
      background-color: var(--vscode-foreground);
      border-radius: 50%;
      transition: transform 150ms;
    }
    .switch input:checked + .slider {
      background-color: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .switch input:checked + .slider::before {
      transform: translateX(14px);
      background-color: var(--vscode-button-foreground);
    }
    .switch input:disabled + .slider { opacity: 0.5; cursor: not-allowed; }

    .popover-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 12px;
    }
    .popover-actions button {
      padding: 4px 12px;
      font: inherit;
      cursor: pointer;
      border: none;
      border-radius: 2px;
    }
    .popover-actions .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .popover-actions .primary:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .popover-actions .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .popover-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    onHostMessage<In>(msg => {
      if (msg.type === 'peer.state') {
        this.snapshot = msg.snapshot;
        this.sync = msg.sync;
        return;
      }
      if (msg.type === 'peer.platformInit') {
        this.support = msg.support;
        this.baseline = { ...msg.current };
        this.form = { ...msg.current };
        this.platformReceived = true;
        return;
      }
      if (msg.type === 'peer.transportApplyStatus') {
        this.applyStep = msg.step;
        this.applyMessage = msg.message;
        if (msg.step === 'complete') {
          // Auto-clear back to idle after 1.5s.
          if (this.completeClearTimer !== null) { window.clearTimeout(this.completeClearTimer); }
          this.completeClearTimer = window.setTimeout(() => {
            this.applyStep = 'idle';
            this.applyMessage = undefined;
            this.completeClearTimer = null;
          }, 1500);
        }
        return;
      }
      if (msg.type === 'peer.transportApplyError') {
        this.applyStep = 'error';
        this.applyMessage = msg.message;
        return;
      }
      if (msg.type === 'peer.localNetwork') {
        this.localInterfaces = msg.interfaces;
        return;
      }
    });
    this.tickInterval = window.setInterval(() => { this.nowTick++; }, 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.tickInterval !== null) { window.clearInterval(this.tickInterval); }
    if (this.completeClearTimer !== null) {
      window.clearTimeout(this.completeClearTimer);
      this.completeClearTimer = null;
    }
  }

  private toggleSync() { postToHost({ type: 'peer.toggleSync' }); }

  private toggleTransportPopover() {
    if (this.showTransportPopover) {
      this.cancelTransportPopover();
    } else {
      // Reset form to baseline whenever we open.
      this.form = { ...this.baseline };
      // Clear stale terminal state from a previous apply.
      if (this.applyStep === 'complete' || this.applyStep === 'error') {
        this.applyStep = 'idle';
        this.applyMessage = undefined;
      }
      this.showTransportPopover = true;
    }
  }

  private cancelTransportPopover() {
    this.showTransportPopover = false;
    this.form = { ...this.baseline };
  }

  private setTransportPref(key: keyof TransportPrefs, value: boolean) {
    this.form = { ...this.form, [key]: value };
  }

  private get transportFormDirty(): boolean {
    return this.form.isLanEnabled !== this.baseline.isLanEnabled
      || this.form.isBluetoothLeEnabled !== this.baseline.isBluetoothLeEnabled
      || this.form.isAwdlEnabled !== this.baseline.isAwdlEnabled;
  }

  private get applyInProgress(): boolean {
    return this.applyStep === 'stoppingSync'
      || this.applyStep === 'applyingConfig'
      || this.applyStep === 'restartingSync';
  }

  private applyTransportConfig() {
    if (!this.transportFormDirty || this.applyInProgress) { return; }
    postToHost({
      type: 'peer.applyTransportConfig',
      isLanEnabled: this.form.isLanEnabled,
      isBluetoothLeEnabled: this.form.isBluetoothLeEnabled,
      isAwdlEnabled: this.form.isAwdlEnabled,
    });
    this.applyStep = 'stoppingSync';
    this.applyMessage = undefined;
  }

  private async copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      this.copiedId = id;
      setTimeout(() => { if (this.copiedId === id) { this.copiedId = null; } }, 1500);
    } catch { /* clipboard may be unavailable; silently fail */ }
  }

  render() {
    return html`
      <h1 class="page-title">Presence</h1>
      <div class="header">
        <div class="dot ${this.sync}"></div>
        <span>${this.sync === 'active' ? 'Sync Active' : 'Sync Idle'}</span>
        <span style="flex: 1"></span>
        <button class="toolbar-button" @click=${this.toggleSync}>
          ${this.sync === 'active' ? '⏸ Stop Sync' : '▶ Start Sync'}
        </button>
        <div class="popover-anchor">
          <button class="toolbar-icon-button"
                  title="Transport Configuration"
                  aria-label="Transport Configuration"
                  ?disabled=${!this.platformReceived}
                  @click=${this.toggleTransportPopover}>
            <i class="codicon codicon-gear"></i>
          </button>
          ${this.showTransportPopover ? this.renderTransportPopover() : nothing}
        </div>
      </div>

      <div class="tabs" role="tablist">
        <button class=${this.tab === 'list' ? 'active' : ''} @click=${() => this.tab = 'list'}>Connected Peers</button>
        <button class=${this.tab === 'graph' ? 'active' : ''} @click=${() => this.tab = 'graph'}>Presence Graph</button>
      </div>

      ${this.tab === 'list' ? this.renderList() : this.renderGraphTab()}
    `;
  }

  private renderTransportPopover() {
    const inProgress = this.applyInProgress;
    const showError = this.applyStep === 'error';
    const showSuccess = this.applyStep === 'complete';
    return html`
      <div class="popover" role="dialog" aria-label="Transport Configuration">
        <h3 class="popover-title">
          <span>Transport Configuration</span>
          <button class="popover-close"
                  aria-label="Close"
                  ?disabled=${inProgress}
                  @click=${this.cancelTransportPopover}>
            <i class="codicon codicon-close"></i>
          </button>
        </h3>

        ${inProgress ? html`
          <div class="banner info">
            <i class="codicon codicon-info"></i>
            <span>Applying transport changes…</span>
          </div>
        ` : showSuccess ? html`
          <div class="banner success">
            <i class="codicon codicon-check"></i>
            <span>Configuration applied successfully</span>
          </div>
        ` : showError ? html`
          <div class="banner error">
            <i class="codicon codicon-warning"></i>
            <span>${this.applyMessage ?? 'Failed to apply transport configuration.'}</span>
          </div>
        ` : html`
          <div class="banner warning">
            <i class="codicon codicon-warning"></i>
            <span>Changing transport settings will temporarily stop sync and disconnect all peers.</span>
          </div>
        `}

        ${this.support.bluetoothLE ? this.renderTransportRow(
          'Bluetooth LE',
          'Direct peer-to-peer sync via Bluetooth Low Energy',
          'isBluetoothLeEnabled',
        ) : nothing}

        ${this.support.lan ? this.renderTransportRow(
          'Local Area Network',
          'Sync with peers on the same WiFi or wired network',
          'isLanEnabled',
        ) : nothing}

        ${this.support.awdl ? this.renderTransportRow(
          'Apple Wireless Direct Link',
          'High-speed peer-to-peer WiFi (Apple devices only)',
          'isAwdlEnabled',
        ) : nothing}

        <div class="popover-actions">
          <button class="secondary"
                  ?disabled=${inProgress}
                  @click=${this.cancelTransportPopover}>Cancel</button>
          <button class="primary"
                  ?disabled=${!this.transportFormDirty || inProgress}
                  @click=${this.applyTransportConfig}>Apply</button>
        </div>
      </div>
    `;
  }

  private renderTransportRow(title: string, subtitle: string, key: keyof TransportPrefs) {
    const checked = this.form[key];
    const disabled = this.applyInProgress;
    return html`
      <div class="transport-row">
        <div class="transport-row-text">
          <h4 class="transport-row-title">${title}</h4>
          <p class="transport-row-subtitle">${subtitle}</p>
        </div>
        <label class="switch">
          <input type="checkbox"
                 .checked=${checked}
                 ?disabled=${disabled}
                 @change=${(e: Event) => this.setTransportPref(key, (e.target as HTMLInputElement).checked)} />
          <span class="slider"></span>
        </label>
      </div>
    `;
  }

  private renderList() {
    const { local, remote } = this.snapshot;
    const empty = !local && remote.length === 0 && this.localInterfaces.length === 0;
    if (empty) {
      return html`<div class="empty">No sync status available. Connect to see peers.</div>`;
    }
    return html`
      ${(local || remote.length > 0) ? html`
        <div class="grid">
          ${repeat(remote, p => p.id, p => this.renderRemoteCard(p))}
          ${local ? this.renderLocalCard(local) : nothing}
        </div>
      ` : nothing}
      ${this.localInterfaces.length > 0 ? this.renderLocalNetworkSection() : nothing}
    `;
  }

  /**
   * "Local Network" divider + interface card grid. Mirrors SwiftUI's
   * ConnectedPeersView layout — the divider draws a thin rule with
   * the section title inline, and the cards live in their own grid
   * underneath. Refresh button is the only interaction; the host's
   * snapshot is cheap so we don't auto-poll.
   */
  private renderLocalNetworkSection() {
    return html`
      <div class="local-net-divider" role="separator" aria-label="Local Network">
        <span class="local-net-divider-line"></span>
        <span class="local-net-divider-label">Local Network</span>
        <span class="local-net-divider-line"></span>
        <button
          class="local-net-refresh"
          title="Refresh local network interfaces"
          @click=${() => postToHost({ type: 'peer.refreshLocalNetwork' })}
        ><i class="codicon codicon-refresh"></i></button>
      </div>
      <div class="grid">
        ${this.localInterfaces.map(i => this.renderInterfaceCard(i))}
      </div>
    `;
  }

  private renderInterfaceCard(iface: LocalNetworkInterface) {
    const [start, end] = INTERFACE_GRADIENTS[iface.kind];
    const style = `background: linear-gradient(135deg, ${start}, ${end});`;
    const ipv4 = iface.ipv4[0];
    const ipv6Global = iface.ipv6.find(a => !a.address.toLowerCase().startsWith('fe80'));
    const ipv6Link = iface.ipv6.find(a => a.address.toLowerCase().startsWith('fe80'));
    const kindLabel = INTERFACE_KIND_LABEL[iface.kind];
    const kindIcon = INTERFACE_KIND_ICON[iface.kind];
    return html`
      <div class="card" style=${style}>
        <div class="card-header">
          <div class="card-title-block">
            <div class="card-row"><i class=${`codicon codicon-${kindIcon}`}></i><span>${kindLabel}</span></div>
            <h3 class="card-name" title=${iface.name}>${iface.name}</h3>
          </div>
        </div>
        <div class="divider"></div>
        <div class="card-body">
          ${iface.mac ? html`<div class="card-row"><span class="label">MAC</span><span class="value mono">${iface.mac}</span></div>` : nothing}
          ${ipv4 ? html`<div class="card-row"><span class="label">IPv4</span><span class="value mono">${ipv4.cidr}</span></div>` : nothing}
          ${ipv6Global ? html`<div class="card-row"><span class="label">IPv6</span><span class="value mono">${ipv6Global.address}</span></div>` : nothing}
          ${ipv6Link ? html`<div class="card-row"><span class="label">IPv6 link-local</span><span class="value mono">${ipv6Link.address}</span></div>` : nothing}
        </div>
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

  private renderGraphTab() {
    const input = this.buildGraphInput();
    if (!input) {
      return html`<div class="placeholder">Waiting for presence — connect to see the graph.</div>`;
    }
    return html`
      <div class="graph-host">
        <div class="graph-toggle">
          <label>
            <input
              type="checkbox"
              .checked=${this.directConnectedOnly}
              @change=${(e: Event) => this.directConnectedOnly = (e.target as HTMLInputElement).checked}
            />
            Direct Connected only
          </label>
        </div>
        <ditto-presence-graph
          .input=${input}
          ?direct-connected-only=${this.directConnectedOnly}
        ></ditto-presence-graph>
      </div>
    `;
  }

  /**
   * Translate the wire-shape PeerListSnapshot the host pushes into the
   * graph element's expected input. Edges come from each remote peer's
   * `connections[]`; we don't include cloud here — the cloud edge is
   * synthesised inside the scene from `isLocalConnectedToCloud` so the
   * "Ditto Cloud" pill can appear without a real connection in the
   * SDK presence graph.
   */
  private buildGraphInput(): PresenceGraphInput | undefined {
    const local = this.snapshot.local;
    if (!local || !local.peerKey) { return undefined; }
    const isCloud = this.snapshot.remote.some(p => p.isDittoServer);

    // Two sources depending on the toggle:
    // - Direct only ON  → use the pre-filtered snapshot.remote.
    //   The host already filtered to peers whose connections involve
    //   local AND dropped peer↔peer chord edges. Result: a clean
    //   spoke-from-local view.
    // - Direct only OFF → use snapshot.presenceGraph, which carries
    //   the unfiltered SDK presence graph (multi-hop peers + every
    //   peer↔peer edge). This is the "chaos lines" SwiftUI view.
    if (this.directConnectedOnly) {
      const seen = new Set<string>();
      const connections: PresenceGraphInput['connections'] = [];
      for (const peer of this.snapshot.remote) {
        for (const c of peer.connections) {
          const pair = [c.peer1, c.peer2].sort().join('|');
          const k = `${pair}|${c.connectionType}`;
          if (seen.has(k)) { continue; }
          seen.add(k);
          connections.push({ from: c.peer1, to: c.peer2, type: c.connectionType });
        }
      }
      return {
        localPeerKey: local.peerKey,
        localDeviceName: local.deviceName,
        isLocalConnectedToCloud: isCloud,
        remotePeers: this.snapshot.remote
          .filter(p => !p.isDittoServer)
          .map(p => ({ peerKey: p.id, deviceName: p.deviceName })),
        connections,
      };
    }

    // Direct only OFF → use the full presence graph if the host sent
    // one. If not (synthetic empty snapshot), fall back to whatever
    // direct-only data we have so the panel doesn't blank out.
    const pg = this.snapshot.presenceGraph;
    if (!pg) {
      return {
        localPeerKey: local.peerKey,
        localDeviceName: local.deviceName,
        isLocalConnectedToCloud: isCloud,
        remotePeers: this.snapshot.remote
          .filter(p => !p.isDittoServer)
          .map(p => ({ peerKey: p.id, deviceName: p.deviceName })),
        connections: [],
      };
    }
    // The cloud peer is synthesised in the scene from
    // isLocalConnectedToCloud and lives under the well-known
    // 'ditto-cloud-node' key — the presence graph from the SDK
    // doesn't contain it, so no special filtering needed.
    return {
      localPeerKey: local.peerKey,
      localDeviceName: local.deviceName,
      isLocalConnectedToCloud: isCloud,
      remotePeers: pg.remotePeers,
      connections: pg.connections.map(c => ({
        from: c.peer1, to: c.peer2, type: c.connectionType,
      })),
    };
  }
}
