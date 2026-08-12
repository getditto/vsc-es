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
  @state() private controlsVisible = true;

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
  private pointerStart: { x: number; y: number; nodeKey?: string } | undefined;
  private pointerMoved = false;

  private static readonly DRAG_THRESHOLD = 4;

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
    .direct-control {
      cursor: pointer;
      user-select: none;
    }
    .direct-control input { cursor: pointer; }
    .action-row {
      display: flex;
      gap: 8px;
    }
    .icon-button {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      background: rgba(30, 30, 30, 0.85);
      color: var(--vscode-foreground);
      backdrop-filter: blur(8px);
      cursor: pointer;
    }
    .icon-button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 90, 90, 0.5));
    }
    .icon-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .icon-button svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
  `;

  disconnectedCallback(): void {
    this.stopRaf();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.scene = undefined;
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
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
      this.scene.setShowDirectConnectedOnly(this.directConnectedOnly);
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
    this.pointerStart = { x: e.clientX, y: e.clientY, nodeKey: node?.key };
    this.pointerMoved = false;
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
    if (this.pointerStart && Math.hypot(
      e.clientX - this.pointerStart.x,
      e.clientY - this.pointerStart.y,
    ) >= PresenceGraphElement.DRAG_THRESHOLD) {
      this.pointerMoved = true;
    }
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
    const clickedKey = this.pointerStart?.nodeKey;
    if (this.dragNodeKey) {
      this.scene.unpin(this.dragNodeKey);
      this.dragNodeKey = null;
    }
    this.isPanning = false;
    this.dragging = false;
    this.scene.endInteraction();
    if (!this.pointerMoved) {
      this.scene.selectPeer(clickedKey);
    }
    this.pointerStart = undefined;
    this.pointerMoved = false;
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

  private resetView(): void {
    if (!this.scene) { return; }
    this.scene.resetViewToLocal();
    this.zoomLabel = '100%';
  }

  private toggleControls(): void {
    this.controlsVisible = !this.controlsVisible;
  }

  private onDirectConnectedOnlyChange(e: Event): void {
    const value = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(new CustomEvent<boolean>('direct-connected-only-change', {
      detail: value,
      bubbles: true,
      composed: true,
    }));
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
      ${this.controlsVisible ? this.renderLegend() : null}
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
        ${this.controlsVisible ? html`
        <label class="control-group direct-control">
          <span>Direct</span>
          <input
            type="checkbox"
            .checked=${this.directConnectedOnly}
            @change=${this.onDirectConnectedOnlyChange}
          />
        </label>
        <div class="control-group" aria-label="Zoom controls">
          <button @click=${this.zoomOut} ?disabled=${z <= 0.5} title="Zoom out">−</button>
          <span class="zoom-label">${this.zoomLabel}</span>
          <button @click=${this.zoomIn} ?disabled=${z >= 2.0} title="Zoom in">+</button>
        </div>
        ` : null}
        <div class="action-row">
          <button class="icon-button" @click=${this.resetView} title="Reset zoom and center local device" aria-label="Reset zoom and center local device">
            ${this.centerIcon()}
          </button>
          <button
            class="icon-button"
            @click=${this.toggleControls}
            title=${this.controlsVisible ? 'Hide graph controls' : 'Show graph controls'}
            aria-label=${this.controlsVisible ? 'Hide graph controls' : 'Show graph controls'}
            aria-pressed=${!this.controlsVisible}
          >${this.eyeIcon()}</button>
        </div>
      </div>
    `;
  }

  private centerIcon(): TemplateResult {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6h2V5h4V3Zm6 0v2h4v4h2V3h-6ZM5 15H3v6h6v-2H5v-4Zm16 0h-2v4h-4v2h6v-6Zm-9-5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>`;
  }

  private eyeIcon(): TemplateResult {
    return this.controlsVisible
      ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c5.5 0 9.5 5.4 9.7 5.6l.9 1.4-.9 1.4C21.5 13.6 17.5 19 12 19S2.5 13.6 2.3 13.4L1.4 12l.9-1.4C2.5 10.4 6.5 5 12 5Zm0 2c-4.4 0-7.8 4.4-8 5 .2.6 3.6 5 8 5s7.8-4.4 8-5c-.2-.6-3.6-5-8-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>`
      : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.3 2 18.7 18.7-1.3 1.3-3.2-3.2A10.7 10.7 0 0 1 12 20c-5.5 0-9.5-5.4-9.7-5.6L1.4 13l.9-1.4a18 18 0 0 1 3.1-3.3L2 3.3 3.3 2Zm3.5 7.7A16 16 0 0 0 4 13c.2.6 3.6 5 8 5 1.4 0 2.7-.4 3.8-.9l-2-2a3.5 3.5 0 0 1-4.9-4.9l-2.1-2.1v1.6ZM12 6c5.5 0 9.5 5.4 9.7 5.6l.9 1.4-.9 1.4c-.3.4-1.2 1.6-2.6 2.8l-1.4-1.4A16 16 0 0 0 20 13c-.2-.6-3.6-5-8-5-.7 0-1.4.1-2 .3L8.4 6.7A11 11 0 0 1 12 6Z"/></svg>`;
  }
}
