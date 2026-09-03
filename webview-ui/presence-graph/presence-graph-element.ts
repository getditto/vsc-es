// webview-ui/presence-graph/presence-graph-element.ts
//
// Lit element that mounts the canvas + scene + RAF loop, and wires
// pointer/wheel events to the scene's interaction API.

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { CONNECTION_STYLES, type ConnectionTypeName } from './colors.js';
import {
  MAX_GRAPH_ZOOM,
  MIN_GRAPH_ZOOM,
  PresenceGraphScene,
  type PresenceGraphInput,
} from './scene.js';

@customElement('ditto-presence-graph')
export class PresenceGraphElement extends LitElement {
  /** Pushed by the parent every time the host's peer.state IPC fires. */
  @property({ attribute: false }) input: PresenceGraphInput | undefined;

  /** Bound from the toggle in the parent panel.
   *
   *  Property-bound, never an attribute. A boolean attribute binding
   *  (`?direct-connected-only=${false}`) cannot express `false` on a
   *  freshly-created element: Lit commits it as `removeAttribute()`, which
   *  is a no-op when the attribute was never set, so no
   *  `attributeChangedCallback` fires and the class-field default silently
   *  wins. The graph tab is destroyed and rebuilt on every tab switch, so
   *  that case is the common one, not the edge case.
   *
   *  Contract: the owner must keep this and `input` consistent — `input` is
   *  expected to be rebuilt for the new mode whenever this changes. The
   *  element relies on that to lay the graph out exactly once per toggle. */
  @property({ attribute: false }) directConnectedOnly = true;

  /** Also parent-owned, for the same reason: the element is torn down on
   *  every tab switch, so element-local state would not survive one. */
  @property({ attribute: false }) controlsVisible = true;

  /** Surfaced state for the zoom indicator overlay. */
  @state() private zoomLabel = '100%';
  /** True while a peer is being dragged (only used to set CSS cursor). */
  @state() private dragging = false;
  /** True while the pointer is over a peer pill (cursor affordance). */
  @state() private hoveringNode = false;

  @query('canvas') private canvasEl!: HTMLCanvasElement;

  private scene: PresenceGraphScene | undefined;
  private resizeObserver: ResizeObserver | undefined;

  /** RAF handle, cleared on disconnect. */
  private rafHandle: number | undefined;
  private lastFrameTime = 0;

  /** True once the idle timer has fired: the running frame paints one last
   *  static frame and the RAF loop goes dark until wake() is called. */
  private settled = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** How long the star field keeps drifting after the last host push or
   *  user interaction before the loop freezes. Instance-visible (rather
   *  than a static) so tests can shrink it. */
  private starIdleMs = 3000;

  /** Drag state — null when not dragging a node. */
  private dragNodeKey: string | null = null;
  private panLastX = 0;
  private panLastY = 0;
  private isPanning = false;
  private pointerStart: { x: number; y: number; nodeKey?: string | undefined } | undefined;
  private pointerMoved = false;
  /** Whether the pointer is currently over the canvas. Maintained even while
   *  dragging, when hover updates themselves are suppressed. */
  private pointerOverCanvas = false;

  private static readonly DRAG_THRESHOLD = 4;

  static override styles = css`
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
    /* Order matters: equal specificity, so the later rule wins. A drag in
       progress must show grabbing even though the pointer is still over
       the peer that put hover-node on the canvas. */
    canvas.hover-node { cursor: pointer; }
    canvas.dragging { cursor: grabbing; }

    /* Bottom-left connection-type legend. Plain HTML so it never
       lives at the mercy of canvas redraws and respects VS Code theme
       tokens for the surface and border. */
    .legend {
      position: absolute;
      left: 12px;
      bottom: 12px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.85));
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      backdrop-filter: blur(8px);
      font-size: 11px;
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
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

    /* Bottom-right zoom controls + filter toggle. The container is
       transparent to the pointer so the gaps between control groups don't
       steal mousemove from the canvas underneath (which would strand the
       graph in a hover-focus state); the groups themselves opt back in. */
    .controls {
      position: absolute;
      right: 12px;
      bottom: 12px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    .controls > * { pointer-events: auto; }
    .control-group {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.85));
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      backdrop-filter: blur(8px);
      font-size: 11px;
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
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
    /* Theme tokens rather than a hardcoded dark surface: these two are the
       only controls left on screen once the eye hides the rest, so a light
       theme must not leave them at ~1.7:1 against their own background. */
    .icon-button {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.85));
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
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

  override disconnectedCallback(): void {
    this.stopRaf();
    this.clearIdleTimer();
    this.settled = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.scene = undefined;
    this.detachDragListeners();
    this.dragNodeKey = null;
    this.isPanning = false;
    this.dragging = false;
    this.hoveringNode = false;
    this.pointerStart = undefined;
    this.pointerMoved = false;
    this.pointerOverCanvas = false;
    super.disconnectedCallback();
  }

  protected override firstUpdated(): void {
    this.setupScene();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // VS Code reparents webview panels when they move between editor groups,
    // which re-runs this on the same element — but firstUpdated does NOT
    // re-fire, and disconnectedCallback tore the scene down. Recreate it or
    // the canvas stays blank for the rest of the panel's life. On the first
    // connect hasUpdated is false and firstUpdated does the setup instead.
    if (this.hasUpdated && !this.scene) {
      this.setupScene();
    }
  }

  private setupScene(): void {
    this.scene = new PresenceGraphScene({ showDirectConnectedOnly: this.directConnectedOnly });
    this.fitCanvasToHost();
    this.resizeObserver = new ResizeObserver(() => { this.fitCanvasToHost(); });
    this.resizeObserver.observe(this);
    this.applyInputAndStartRaf();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (!this.scene) { return; }
    const modeChanged = changed.has('directConnectedOnly');
    if (modeChanged) {
      this.scene.setShowDirectConnectedOnly(this.directConnectedOnly);
    }
    if (changed.has('input')) {
      this.applyInputAndStartRaf();
    } else if (modeChanged) {
      // Deliberately does NOT re-apply the current input. The owner rebuilds
      // `input` for the new mode and pushes it in the very next update, so
      // laying out from the old, differently-filtered snapshot first would
      // run two layout passes and play two overlapping 500ms transitions.
      // Just keep painting; the input push does the single layout.
      this.wake();
    }
  }

  private applyInputAndStartRaf(): void {
    if (!this.scene || !this.input) { return; }
    this.scene.applyInput(this.input);
    this.wake();
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
    if (this.scene) {
      this.scene.setSize(cssWidth, cssHeight);
      // A resize changes what the frame shows — wake if the loop was settled.
      this.wake();
    }
  }

  // ─── RAF loop ─────────────────────────────────────────────

  /** Something changed that the canvas must show: un-freeze the loop and
   *  restart the idle window. Called on host input pushes, resizes, and
   *  every pointer/wheel interaction. */
  private wake(): void {
    this.settled = false;
    this.resetIdleTimer();
    this.ensureRafRunning();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // The currently-running frame paints once more and then stops, so the
      // freeze is preceded by a final, fully-ticked static frame.
      this.settled = true;
    }, this.starIdleMs);
    // Node test processes must not be held open by a UI idle timer.
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private ensureRafRunning(): void {
    if (this.rafHandle !== undefined) { return; }
    this.lastFrameTime = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(100, now - this.lastFrameTime); // clamp huge gaps
      this.lastFrameTime = now;
      if (!this.scene) { this.rafHandle = undefined; return; }
      const stillAnimating = this.scene.tick(now, dt);
      this.renderScene();
      if (stillAnimating) {
        // Layout transitions in flight (or a live drag): the loop must stay
        // up, so they count against the idle clock too.
        this.resetIdleTimer();
      }
      if (this.settled) {
        // Final static frame painted above; go dark until wake()ed.
        this.rafHandle = undefined;
        return;
      }
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
    this.wake();
    const local = this.localCoords(e);
    const world = this.scene.canvasToWorld(local.x, local.y);
    const node = this.scene.nodeAt(ctx, world);
    this.pointerStart = { x: e.clientX, y: e.clientY, nodeKey: node?.key };
    this.pointerMoved = false;
    // A mousedown on the canvas implies the pointer is over it, even if no
    // mousemove has been seen yet.
    this.pointerOverCanvas = true;
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
    // The mouseup can be swallowed entirely — released over a native menu,
    // outside the VS Code window, or into a context menu. Without this the
    // interaction never ends: `isUserInteracting` stays true, every later
    // layout pass early-returns, and peers that join afterwards are stranded
    // at the origin. Recover as soon as we see the button is no longer down.
    //
    // Never commit a click on this path: the release happened somewhere we
    // never saw, so an under-threshold press would otherwise be retroactively
    // fired as a selection the moment the pointer wandered back.
    if (e.buttons === 0) { this.endDrag(false, e); return; }
    this.wake();
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

  private onMouseUp = (e?: MouseEvent): void => {
    // `onMouseDown` only starts an interaction for the primary button, so a
    // non-primary release during a drag must not tear it down — otherwise a
    // right-click mid-drag toggles the selection and detaches the listeners
    // while the left button is still held.
    if (e && e.button !== 0) { return; }
    this.endDrag(true, e);
  };

  /** Finish the current interaction. When `commitClick` and the pointer never
   *  travelled far enough to count as a drag, treat it as a click. */
  private endDrag(commitClick = true, e?: MouseEvent): void {
    this.detachDragListeners();
    const clickedKey = this.pointerStart?.nodeKey;
    this.pointerStart = undefined;
    const moved = this.pointerMoved;
    this.pointerMoved = false;
    const wasDragging = this.dragNodeKey;
    this.dragNodeKey = null;
    this.isPanning = false;
    this.dragging = false;
    if (!this.scene) { return; }
    this.wake();
    if (wasDragging) { this.scene.unpin(wasDragging); }
    this.scene.endInteraction();
    if (commitClick && !moved) {
      this.scene.selectPeer(clickedKey);
    }
    // Hover is suppressed while dragging, so resolve it from the release
    // point: a drag that ends off-canvas must not leave the graph dimmed,
    // and one that ends over the canvas should reflect what is under the
    // pointer now — not whatever was under it when the press started.
    if (!this.pointerOverCanvas) {
      this.scene.setHovered(undefined);
      this.hoveringNode = false;
    } else if (e) {
      this.updateHoverFromEvent(e);
    }
  }

  private detachDragListeners(): void {
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  private onMouseHover = (e: MouseEvent): void => {
    // Tracked even during a drag (when hover updates are suppressed) so
    // endDrag knows whether the pointer is still over the graph.
    this.pointerOverCanvas = true;
    // Only updates hover state — the drag listeners take over while
    // a drag is in progress (they're registered on `window`).
    if (this.dragNodeKey || this.isPanning) { return; }
    this.wake();
    this.updateHoverFromEvent(e);
  };

  /** Recompute hover (scene dimming + cursor class) from a pointer event. */
  private updateHoverFromEvent(e: MouseEvent): void {
    if (!this.scene || !this.canvasEl) { return; }
    const ctx = this.canvasEl.getContext('2d');
    if (!ctx) { return; }
    const local = this.localCoords(e);
    const world = this.scene.canvasToWorld(local.x, local.y);
    const node = this.scene.nodeAt(ctx, world);
    this.scene.setHovered(node);
    this.hoveringNode = !!node;
  }

  /** Hover drives the same dimming treatment as a click selection, so it
   *  must be released when the pointer leaves the canvas — including onto
   *  the controls overlay. Without this the graph stays dimmed at 8–25%
   *  indefinitely. */
  private onMouseOut = (): void => {
    this.pointerOverCanvas = false;
    if (!this.scene) { return; }
    // Mid-drag the pointer is expected to leave; clearing hover here would
    // drop the dragged peer's highlight. endDrag applies it on release.
    if (this.dragNodeKey || this.isPanning) { return; }
    this.wake();
    this.scene.setHovered(undefined);
    this.hoveringNode = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.scene) { return; }
    e.preventDefault();
    this.wake();
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
    this.wake();
    this.scene.setZoom(this.scene.zoom + 0.1);
    this.zoomLabel = `${Math.round(this.scene.zoom * 100)}%`;
  }
  private zoomOut(): void {
    if (!this.scene) { return; }
    this.wake();
    this.scene.setZoom(this.scene.zoom - 0.1);
    this.zoomLabel = `${Math.round(this.scene.zoom * 100)}%`;
  }

  private resetView(): void {
    if (!this.scene) { return; }
    this.wake();
    this.scene.resetViewToLocal();
    this.zoomLabel = '100%';
  }

  private toggleControls(): void {
    // Update locally as well as notifying the owner: the control must stay
    // self-consistent even if the parent drops the event, and the parent
    // writing back the same value is a no-op.
    this.controlsVisible = !this.controlsVisible;
    this.dispatchEvent(new CustomEvent<boolean>('controls-visible-change', {
      detail: this.controlsVisible,
      bubbles: true,
      composed: true,
    }));
  }

  private onDirectConnectedOnlyChange(e: Event): void {
    const value = (e.target as HTMLInputElement).checked;
    this.directConnectedOnly = value;
    this.dispatchEvent(new CustomEvent<boolean>('direct-connected-only-change', {
      detail: value,
      bubbles: true,
      composed: true,
    }));
  }

  // ─── Render ───────────────────────────────────────────────

  override render(): TemplateResult {
    return html`
      <canvas
        class=${[this.dragging ? 'dragging' : '', this.hoveringNode ? 'hover-node' : '']
          .filter(Boolean).join(' ')}
        @mousedown=${this.onMouseDown}
        @mousemove=${this.onMouseHover}
        @mouseout=${this.onMouseOut}
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
          <button @click=${this.zoomOut} ?disabled=${z <= MIN_GRAPH_ZOOM} title="Zoom out">−</button>
          <span class="zoom-label">${this.zoomLabel}</span>
          <button @click=${this.zoomIn} ?disabled=${z >= MAX_GRAPH_ZOOM} title="Zoom in">+</button>
        </div>
        ` : null}
        <div class="action-row">
          <button class="icon-button" @click=${this.resetView} title="Reset zoom and center local device" aria-label="Reset zoom and center local device">
            ${this.centerIcon()}
          </button>
          <!-- The accessible name states the action and flips with the
               state, so no aria-pressed: pairing a flipping label with a
               pressed state announces "Show graph controls, pressed" while
               the controls are hidden, which contradicts itself. -->
          <button
            class="icon-button"
            @click=${this.toggleControls}
            title=${this.controlsVisible ? 'Hide graph controls' : 'Show graph controls'}
            aria-label=${this.controlsVisible ? 'Hide graph controls' : 'Show graph controls'}
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
