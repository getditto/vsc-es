// webview-ui/presence-graph/presence-graph-element.ts
//
// Lit element that mounts the canvas + scene + RAF loop, and wires
// pointer/wheel events to the scene's interaction API.

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { CONNECTION_STYLES, type ConnectionTypeName } from './colors.js';
import { PresenceGraphScene, type PresenceGraphInput } from './scene.js';

@customElement('ditto-presence-graph')
export class PresenceGraphElement extends LitElement {
  /** Pushed by the parent every time the host's peer.state IPC fires. */
  @property({ attribute: false }) input: PresenceGraphInput | undefined;

  /** Bound from the toggle in the parent panel. */
  @property({ type: Boolean, attribute: 'direct-connected-only' })
  directConnectedOnly = true;

  /** Surfaced state for the zoom indicator overlay. */
  @state() private zoomLabel = '100%';
  /** True while a peer is being dragged (only used to set CSS cursor). */
  @state() private dragging = false;

  @query('canvas') private canvasEl!: HTMLCanvasElement;

  private scene: PresenceGraphScene | undefined;
  private resizeObserver: ResizeObserver | undefined;

  /** RAF handle, cleared on disconnect. */
  private rafHandle: number | undefined;
  private lastFrameTime = 0;

  /** Drag state — null when not dragging a node. */
  private dragNodeKey: string | null = null;
  private panLastX = 0;
  private panLastY = 0;
  private isPanning = false;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      background:
        radial-gradient(circle at 50% 35%, rgba(40, 60, 90, 0.4) 0%, transparent 60%),
        var(--vscode-editor-background, #1e1e1e);
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
    }
    canvas.dragging { cursor: grabbing; }
    canvas.hover-node { cursor: pointer; }

    /* Bottom-left connection-type legend. Plain HTML so it never
       lives at the mercy of canvas redraws and respects VS Code theme
       tokens for the surface and border. */
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
    .legend-row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
    .legend-swatch { width: 8px; height: 8px; border-radius: 50%; }
    .legend-pattern {
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      letter-spacing: 0.5px;
    }

    /* Bottom-right zoom controls + filter toggle. */
    .controls {
      position: absolute;
      right: 12px;
      bottom: 12px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }
    .control-group {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(30, 30, 30, 0.85);
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      backdrop-filter: blur(8px);
      font-size: 11px;
      color: var(--vscode-foreground);
    }
    .control-group button {
      width: 22px; height: 22px;
      padding: 0;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font: inherit;
    }
    .control-group button[disabled] { opacity: 0.4; cursor: not-allowed; }
    .control-group .zoom-label {
      width: 38px;
      text-align: center;
      font-family: var(--vscode-editor-font-family);
    }
  `;

  disconnectedCallback(): void {
    this.stopRaf();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.scene = undefined;
    super.disconnectedCallback();
  }

  protected firstUpdated(): void {
    this.scene = new PresenceGraphScene({ showDirectConnectedOnly: this.directConnectedOnly });
    this.fitCanvasToHost();
    this.resizeObserver = new ResizeObserver(() => { this.fitCanvasToHost(); });
    this.resizeObserver.observe(this);
    this.applyInputAndStartRaf();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!this.scene) { return; }
    if (changed.has('directConnectedOnly')) {
      this.scene.showDirectConnectedOnly = this.directConnectedOnly;
      this.applyInputAndStartRaf(true);
    }
    if (changed.has('input')) {
      this.applyInputAndStartRaf();
    }
  }

  private applyInputAndStartRaf(force = false): void {
    if (!this.scene) { return; }
    if (this.input) {
      this.scene.applyInput(this.input);
    } else if (!force) {
      return;
    }
    this.ensureRafRunning();
  }

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
    if (this.scene) { this.scene.setSize(cssWidth, cssHeight); }
  }

  // ─── RAF loop ─────────────────────────────────────────────

  private ensureRafRunning(): void {
    if (this.rafHandle !== undefined) { return; }
    this.lastFrameTime = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(100, now - this.lastFrameTime); // clamp huge gaps
      this.lastFrameTime = now;
      if (!this.scene) { this.rafHandle = undefined; return; }
      this.scene.tick(now, dt);
      this.renderScene();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
  }

  private renderScene(): void {
    if (!this.scene || !this.canvasEl) { return; }
    const ctx = this.canvasEl.getContext('2d');
    if (!ctx) { return; }
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
    ctx.scale(dpr, dpr);
    this.scene.render(ctx);
  }

  // ─── Pointer / wheel handlers ─────────────────────────────

  /** Translate a DOM event to canvas-local CSS pixel coords. */
  private localCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvasEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.scene || !this.canvasEl) { return; }
    if (e.button !== 0) { return; } // left click only
    const ctx = this.canvasEl.getContext('2d');
    if (!ctx) { return; }
    const local = this.localCoords(e);
    const world = this.scene.canvasToWorld(local.x, local.y);
    const node = this.scene.nodeAt(ctx, world);
    this.scene.beginInteraction();
    if (node) {
      this.dragNodeKey = node.key;
      this.scene.pin(node.key);
      this.scene.setHovered(node);
      this.dragging = true;
    } else {
      this.isPanning = true;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      this.dragging = true;
    }
    // Latch global listeners so a drag-to-outside-the-canvas still
    // gets the corresponding mouseup.
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.scene || !this.canvasEl) { return; }
    if (this.dragNodeKey) {
      const local = this.localCoords(e);
      const world = this.scene.canvasToWorld(local.x, local.y);
      this.scene.setPeerPosition(this.dragNodeKey, world);
    } else if (this.isPanning) {
      const dx = e.clientX - this.panLastX;
      const dy = e.clientY - this.panLastY;
      this.panLastX = e.clientX;
      this.panLastY = e.clientY;
      this.scene.panBy(dx, dy);
    }
  };

  private onMouseUp = (): void => {
    if (!this.scene) { return; }
    if (this.dragNodeKey) {
      this.scene.unpin(this.dragNodeKey);
      this.dragNodeKey = null;
    }
    this.isPanning = false;
    this.dragging = false;
    this.scene.endInteraction();
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  };

  private onMouseHover = (e: MouseEvent): void => {
    // Only updates hover state — the drag listeners take over while
    // a drag is in progress (they're registered on `window`).
    if (!this.scene || !this.canvasEl) { return; }
    if (this.dragNodeKey || this.isPanning) { return; }
    const ctx = this.canvasEl.getContext('2d');
    if (!ctx) { return; }
    const local = this.localCoords(e);
    const world = this.scene.canvasToWorld(local.x, local.y);
    const node = this.scene.nodeAt(ctx, world);
    this.scene.setHovered(node);
    this.canvasEl.classList.toggle('hover-node', !!node);
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.scene) { return; }
    e.preventDefault();
    // SwiftUI: deltaY > 0 = zoom out, deltaY < 0 = zoom in. Web wheel
    // events use the opposite sign convention by default; flip so the
    // muscle memory matches.
    const step = e.deltaY > 0 ? -0.05 : 0.05;
    this.scene.setZoom(this.scene.zoom + step);
    this.zoomLabel = `${Math.round(this.scene.zoom * 100)}%`;
  };

  // ─── Zoom buttons ─────────────────────────────────────────

  private zoomIn(): void {
    if (!this.scene) { return; }
    this.scene.setZoom(this.scene.zoom + 0.1);
    this.zoomLabel = `${Math.round(this.scene.zoom * 100)}%`;
  }
  private zoomOut(): void {
    if (!this.scene) { return; }
    this.scene.setZoom(this.scene.zoom - 0.1);
    this.zoomLabel = `${Math.round(this.scene.zoom * 100)}%`;
  }

  // ─── Render ───────────────────────────────────────────────

  render(): TemplateResult {
    return html`
      <canvas
        class=${this.dragging ? 'dragging' : ''}
        @mousedown=${this.onMouseDown}
        @mousemove=${this.onMouseHover}
        @wheel=${this.onWheel}
      ></canvas>
      ${this.renderLegend()}
      ${this.renderControls()}
    `;
  }

  private renderLegend(): TemplateResult {
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
            <span class="legend-swatch" style=${`background: ${CONNECTION_STYLES[r.type].color};`}></span>
            <span class="legend-pattern" style=${`color: ${CONNECTION_STYLES[r.type].color};`}>${r.pattern}</span>
            <span>${r.label}</span>
          </div>
        `)}
      </div>
    `;
  }

  private renderControls(): TemplateResult {
    const z = this.scene?.zoom ?? 1;
    return html`
      <div class="controls">
        <div class="control-group">
          <button @click=${this.zoomOut} ?disabled=${z <= 0.5} title="Zoom out">−</button>
          <span class="zoom-label">${this.zoomLabel}</span>
          <button @click=${this.zoomIn} ?disabled=${z >= 2.0} title="Zoom in">+</button>
        </div>
      </div>
    `;
  }
}
