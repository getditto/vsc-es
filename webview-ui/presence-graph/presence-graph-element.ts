// webview-ui/presence-graph/presence-graph-element.ts
//
// Lit element that mounts a single canvas and a scene. Phase 2 only:
// renders one frame on demand from whatever input is set on the
// element. The RAF loop, drag/pan/zoom, and topology-change-driven
// re-layout all land in Phase 3.

import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { CONNECTION_STYLES, type ConnectionTypeName } from './colors.js';
import { PresenceGraphScene, type PresenceGraphInput } from './scene.js';

@customElement('ditto-presence-graph')
export class PresenceGraphElement extends LitElement {
  /** The input the host pushes down each time presence updates.
   *  Property assignment triggers a `applyInput` + render. */
  @property({ attribute: false }) input: PresenceGraphInput | undefined;

  /** Mirrors the SwiftUI toggle. Bound from the parent panel. */
  @property({ type: Boolean, attribute: 'direct-connected-only' })
  directConnectedOnly = true;

  @query('canvas') private canvasEl!: HTMLCanvasElement;

  private scene: PresenceGraphScene | undefined;
  private resizeObserver: ResizeObserver | undefined;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      /* Match the SwiftUI scene's deep-blue/black backdrop so the
         translucent diamond fills sit on a similar substrate. */
      background:
        radial-gradient(circle at 50% 35%, rgba(40, 60, 90, 0.4) 0%, transparent 60%),
        var(--vscode-editor-background, #1e1e1e);
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    /* Bottom-left connection legend overlay — same content as
       SwiftUI's connectionLegend. Pure HTML/CSS so it survives canvas
       redraws. */
    .legend {
      position: absolute;
      left: 12px;
      bottom: 12px;
      padding: 10px 12px;
      background: rgba(30, 30, 30, 0.85);
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      backdrop-filter: blur(8px);
      font-size: 11px;
      color: var(--vscode-foreground);
      pointer-events: none;
    }
    .legend h3 {
      margin: 0 0 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
    }
    .legend-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 2px 0;
    }
    .legend-swatch {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .legend-pattern {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      letter-spacing: 0.5px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.scene = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.scene = new PresenceGraphScene({ showDirectConnectedOnly: this.directConnectedOnly });
    this.fitCanvasToHost();
    this.resizeObserver = new ResizeObserver(() => {
      this.fitCanvasToHost();
      this.renderScene();
    });
    this.resizeObserver.observe(this);
    this.applyInputAndRender();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!this.scene) { return; }
    if (changed.has('directConnectedOnly')) {
      this.scene.showDirectConnectedOnly = this.directConnectedOnly;
      // Force a re-apply so the filter takes effect immediately.
      this.applyInputAndRender(true);
    }
    if (changed.has('input')) {
      this.applyInputAndRender();
    }
  }

  private applyInputAndRender(force = false): void {
    if (!this.scene) { return; }
    if (this.input) {
      this.scene.applyInput(this.input);
    } else if (!force) {
      return;
    }
    this.renderScene();
  }

  /**
   * Resize the backing canvas store to match the host element AND
   * the device pixel ratio. Without this the canvas blurs on retina
   * displays since CSS pixels and backing-store pixels get conflated.
   */
  private fitCanvasToHost(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);
    const c = this.canvasEl;
    if (!c) { return; }
    c.width = Math.round(cssWidth * dpr);
    c.height = Math.round(cssHeight * dpr);
    c.style.width = `${cssWidth}px`;
    c.style.height = `${cssHeight}px`;
    if (this.scene) {
      this.scene.setSize(cssWidth, cssHeight);
    }
  }

  private renderScene(): void {
    if (!this.scene || !this.canvasEl) { return; }
    const ctx = this.canvasEl.getContext('2d');
    if (!ctx) { return; }
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    // Apply DPR scale once per frame so all subsequent draws use CSS
    // coordinates. resetTransform() before scaling to avoid stacking
    // DPR multiple times across frames.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    ctx.scale(dpr, dpr);
    this.scene.render(ctx);
    ctx.restore();
  }

  render() {
    return html`
      <canvas></canvas>
      ${this.renderLegend()}
    `;
  }

  private renderLegend() {
    const rows: { type: ConnectionTypeName; label: string; pattern: string }[] = [
      { type: 'Bluetooth',   label: 'Bluetooth',  pattern: '— — — —' },
      { type: 'AccessPoint', label: 'LAN',        pattern: '———— ————' },
      { type: 'P2PWiFi',     label: 'P2P WiFi',   pattern: '—— —— ——' },
      { type: 'WebSocket',   label: 'WebSocket',  pattern: '——— · ———' },
      { type: 'Cloud',       label: 'Cloud',      pattern: '——— ○ ———' },
    ];
    return html`
      <div class="legend" aria-hidden="true">
        <h3>Connection Types</h3>
        ${rows.map(r => html`
          <div class="legend-row">
            <span
              class="legend-swatch"
              style=${`background: ${CONNECTION_STYLES[r.type].color};`}
            ></span>
            <span
              class="legend-pattern"
              style=${`color: ${CONNECTION_STYLES[r.type].color};`}
            >${r.pattern}</span>
            <span>${r.label}</span>
          </div>
        `)}
      </div>
    `;
  }
}
