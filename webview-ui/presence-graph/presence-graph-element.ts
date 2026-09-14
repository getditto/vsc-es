// webview-ui/presence-graph/presence-graph-element.ts
//
// Lit element that mounts the canvas + scene + RAF loop, and wires
// pointer/wheel events to the scene's interaction API.

import { LitElement, html, css, type TemplateResult, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { CONNECTION_STYLES, type ConnectionTypeName } from './colors.js';
import {
  formatLastUpdateMs,
  metadataKeySummary,
  type PresencePeerCardDetail,
} from './peer-detail.js';
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

  /** Peer keys matching the panel's search box; `undefined` when the box is
   *  empty. Parent-owned and property-bound for the same lifecycle reason
   *  as `directConnectedOnly`, and re-applied to every fresh scene. */
  @property({ attribute: false }) searchMatchKeys: ReadonlySet<string> | undefined;

  /** Card content for every presence peer, keyed by peer key — the parent's
   *  snapshot-derived lookup behind the detail card. The element owns which
   *  card is open; the parent owns the (live) data. */
  @property({ attribute: false }) peerDetails: ReadonlyMap<string, PresencePeerCardDetail> | undefined;

  /** The peer whose detail card is open, in Direct selection or focus view.
   *  Cleared when the scene is rebuilt or the graph mode changes. */
  @state() private detailPeerKey: string | undefined;
  @state() private peerKeyCopyStatus: 'idle' | 'copied' | 'error' = 'idle';
  private peerKeyCopyRequest = 0;

  /** A detail card is currently open — the panel's Escape routing reads
   *  this to decide whether the keypress dismisses the card first. */
  get detailOpen(): boolean { return this.detailPeerKey !== undefined; }

  /** Close the open detail card (panel Escape routing, card ✕). */
  closeDetail(): void {
    this.detailPeerKey = undefined;
  }

  /** Decorative effects default to on and stay local to this graph element. */
  @state() private backgroundEffectsEnabled = true;

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
  /** A focusPeer() call that must wait for the next applied input — set
   *  when focusing from search triggers a Direct → full-mesh switch. */
  private pendingFocusKey: string | undefined;
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
    :host([data-background-effects-off]) {
      background: var(--vscode-editor-background, #1e1e1e);
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
    .focus-banner {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px 6px 12px;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.9));
      border: 1px solid var(--vscode-focusBorder, rgba(120, 180, 255, 0.65));
      border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
      font-size: 11px;
      pointer-events: auto;
      /* Above the detail card (2): on short panes the centered card reaches
         the banner's band, and the exit button must stay clickable. */
      z-index: 3;
    }
    .focus-banner strong { font-weight: 600; }
    .focus-banner button {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 4px;
      border: 0;
      border-radius: 50%;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .focus-banner button:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .focus-banner button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .focus-banner svg { width: 100%; height: 100%; fill: currentColor; }

    /* Peer detail card — screen-space overlay centred in the host, above
       the canvas rather than inside it: it must stay legible at any zoom
       and never reach the layout engine's peer footprints. SwiftUI's
       PeerDetailCardView makes the same call for the same reason. The
       wrapper is click-transparent so taps beside the card keep reaching
       the canvas (dismiss-or-exit routing lives in endDrag). */
    .peer-detail-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      z-index: 2;
    }
    .peer-detail-card {
      pointer-events: auto;
      width: 300px;
      max-width: calc(100% - 32px);
      max-height: calc(100% - 32px);
      overflow-y: auto;
      padding: 14px;
      background: var(--vscode-editorWidget-background, rgba(30, 30, 30, 0.92));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(255, 255, 255, 0.1)));
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(12px);
      font-size: 11px;
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    }
    .peer-detail-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .peer-detail-header h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .peer-detail-close, .peer-key-copy {
      display: grid;
      place-items: center;
      width: 20px;
      height: 20px;
      padding: 3px;
      flex-shrink: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--vscode-icon-foreground, inherit);
      opacity: 0.7;
      cursor: pointer;
    }
    .peer-detail-close:hover, .peer-key-copy:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .peer-detail-close:focus-visible, .peer-key-copy:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .peer-detail-close svg, .peer-key-copy svg { width: 100%; height: 100%; fill: currentColor; }
    .peer-detail-divider {
      height: 1px;
      background: var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
      margin: 8px 0;
    }
    .peer-detail-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 2px 0;
    }
    .peer-detail-row .label {
      width: 108px;
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
    }
    .peer-detail-row .value {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .peer-detail-row .value.mono { font-family: var(--vscode-editor-font-family); }
    .peer-detail-row .value.missing { color: var(--vscode-descriptionForeground); }
    .peer-detail-row.peer-key-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 4px 8px;
    }
    .peer-key-row .value {
      grid-column: 1 / -1;
      white-space: normal;
      overflow-wrap: anywhere;
      overflow: visible;
      user-select: text;
    }
    .peer-key-copy { width: 24px; height: 24px; border-radius: 4px; }
    .peer-key-copy-status { grid-column: 1 / -1; color: var(--vscode-descriptionForeground); }
    .peer-key-copy-status:empty { display: none; }
    .peer-detail-sync-title { margin: 0; }
    .peer-detail-caption {
      margin: 2px 0 0;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .peer-detail-focus {
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
    }
    .peer-detail-focus:hover { text-decoration: underline; }
    .peer-detail-focus:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  `;

  override disconnectedCallback(): void {
    this.peerKeyCopyRequest += 1;
    this.peerKeyCopyStatus = 'idle';
    this.stopRaf();
    this.clearIdleTimer();
    this.settled = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.scene = undefined;
    this.detailPeerKey = undefined;
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
    this.scene = new PresenceGraphScene({
      showDirectConnectedOnly: this.directConnectedOnly,
      backgroundEffectsEnabled: this.backgroundEffectsEnabled,
    });
    // The scene dies with the element (tab switches, panel reparenting) but
    // the parent keeps the search query — re-apply it to the fresh scene.
    this.scene.setSearchMatches(this.searchMatchKeys);
    this.fitCanvasToHost();
    this.resizeObserver = new ResizeObserver(() => { this.fitCanvasToHost(); });
    this.resizeObserver.observe(this);
    this.applyInputAndStartRaf();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('directConnectedOnly')) { this.detailPeerKey = undefined; }
    if (changed.has('detailPeerKey')) {
      // A clipboard operation completing after the card changes must not
      // announce success (or failure) on a different peer's card.
      this.peerKeyCopyRequest += 1;
      this.peerKeyCopyStatus = 'idle';
    }
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (!this.scene) { return; }
    const modeChanged = changed.has('directConnectedOnly');
    const wasFocused = this.scene.isFocusedView;
    if (modeChanged) {
      this.scene.setShowDirectConnectedOnly(this.directConnectedOnly);
    }
    this.syncFocusChrome(wasFocused);
    if (changed.has('searchMatchKeys')) {
      this.scene.setSearchMatches(this.searchMatchKeys);
      // The settled loop won't repaint the dimming on its own.
      this.wake();
    }
    if (changed.has('peerDetails') && this.detailPeerKey && !this.peerDetails?.has(this.detailPeerKey)) {
      // A card anchored to a peer that left the mesh must not survive it.
      this.detailPeerKey = undefined;
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
    this.scene.setMeasurementContext(this.canvasEl?.getContext('2d') ?? undefined);
    const wasFocused = this.scene.isFocusedView;
    this.scene.applyInput(this.input);
    if (this.directConnectedOnly && this.detailPeerKey !== this.scene.selectedPeerKey) {
      this.detailPeerKey = undefined;
    }
    // Direct-mode entry may automatically lower an inherited full-mesh zoom
    // to keep the compact ring inside the viewport. Keep the overlay in sync
    // with the scene after that layout pass.
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
    if (this.pendingFocusKey) {
      // A search-result click that flipped Direct → full-mesh lands here,
      // once the rebuilt input guarantees the peer exists in the scene.
      const key = this.pendingFocusKey;
      this.pendingFocusKey = undefined;
      this.scene.selectPeer(key);
      this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
    }
    this.syncFocusChrome(wasFocused);
    this.wake();
  }

  /** Focus-session bookkeeping shared by every observe point (`updated`,
   *  input pushes, the RAF tick): leaving the focused view takes any open
   *  detail card with it — the card belongs to a focus session — and any
   *  flip repaints the overlay chrome. */
  private syncFocusChrome(wasFocused: boolean): void {
    if (!this.scene || wasFocused === this.scene.isFocusedView) { return; }
    if (!this.scene.isFocusedView) { this.detailPeerKey = undefined; }
    this.requestUpdate();
  }

  /** Select a peer exactly as if the user had clicked it in the full mesh
   *  (focus view included) — the entry point for the panel's search results.
   *  Focus view only exists with Direct off, so when Direct is on this
   *  defers the selection until the parent's rebuilt full-mesh input has
   *  been applied (otherwise the peer may not even be in the scene yet).
   *  The mode flip rides the same event the Direct checkbox dispatches. */
  focusPeer(key: string): void {
    if (!this.scene) {
      this.pendingFocusKey = key;
      return;
    }
    if (this.directConnectedOnly) {
      this.pendingFocusKey = key;
      this.directConnectedOnly = false;
      this.dispatchEvent(new CustomEvent<boolean>('direct-connected-only-change', {
        detail: false,
        bubbles: true,
        composed: true,
      }));
      return;
    }
    this.wake();
    // selectPeer TOGGLES focus off when the search re-picks the currently
    // focused peer — so this call can leave the focus view. Capture/forward
    // the flip or the open detail card would be orphaned over the full mesh
    // (every other exit path goes through syncFocusChrome or clears it).
    const wasFocused = this.scene.isFocusedView;
    this.scene.selectPeer(key);
    this.syncFocusChrome(wasFocused);
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
    this.requestUpdate();
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
      const wasFocused = this.scene.isFocusedView;
      const stillAnimating = this.scene.tick(now, dt);
      this.syncFocusChrome(wasFocused);
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
      if (this.scene.isFocusedView) {
        // In the focused neighbourhood a tap means "tell me about this peer"
        // (SwiftUI PresenceNetworkScene.handlePeerTap parity): it opens the
        // peer's detail card — accordion, so a re-tap closes — for every
        // peer with card data, including the focused one and the local
        // device. A tap on the synthetic cloud node or on empty canvas acts
        // like a canvas tap: dismiss an open card first (closing an
        // inspector, not backing out of the investigation) and only exit
        // focus when no card was up. Divergence credit: the reference
        // routes the cloud tap to a detail request its model guard silently
        // drops — the dismiss-or-exit choice here is deliberate (every route
        // out stays reachable).
        if (clickedKey && this.peerDetails?.has(clickedKey)) {
          this.detailPeerKey = this.detailPeerKey === clickedKey ? undefined : clickedKey;
          this.requestUpdate();
        } else if (this.detailPeerKey) {
          this.detailPeerKey = undefined;
          this.requestUpdate();
        } else {
          this.scene.selectPeer(undefined);
          this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
          this.requestUpdate();
        }
      } else {
        this.scene.selectPeer(clickedKey);
        if (this.directConnectedOnly) {
          const selectedKey = this.scene.selectedPeerKey;
          this.detailPeerKey = selectedKey && this.peerDetails?.has(selectedKey) ? selectedKey : undefined;
        }
        this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
        this.requestUpdate();
      }
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
    this.scene.setZoom(this.scene.activeZoom + step);
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
  };

  // ─── Zoom buttons ─────────────────────────────────────────

  private zoomIn(): void {
    if (!this.scene) { return; }
    this.wake();
    this.scene.setZoom(this.scene.activeZoom + 0.1);
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
  }
  private zoomOut(): void {
    if (!this.scene) { return; }
    this.wake();
    this.scene.setZoom(this.scene.activeZoom - 0.1);
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
  }

  private resetView(): void {
    if (!this.scene) { return; }
    this.wake();
    this.scene.resetViewToLocal();
    this.zoomLabel = '100%';
  }

  private exitFocusedView = (): void => {
    if (!this.scene) { return; }
    this.scene.exitFocusView();
    // The banner exit also ends the card's focus session.
    this.detailPeerKey = undefined;
    this.zoomLabel = `${Math.round(this.scene.activeZoom * 100)}%`;
    this.requestUpdate();
    this.wake();
  };

  /** The card's labelled focus action: close the card, then refocus on its
   *  peer. Replaces tap-to-refocus, which the card tap now owns.
   *
   *  Divergence credit: SwiftUI's equivalent is inert in steady state (its
   *  scene's restore guard rejects the call while any focus session is
   *  active); selectPeer refocuses unconditionally here, which is clearly
   *  the reference's intent. */
  private focusDetailPeer = (): void => {
    const key = this.detailPeerKey;
    if (!key) { return; }
    this.detailPeerKey = undefined;
    this.focusPeer(key);
  };

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

  private toggleBackgroundEffects(): void {
    this.backgroundEffectsEnabled = !this.backgroundEffectsEnabled;
    this.scene?.setBackgroundEffectsEnabled(this.backgroundEffectsEnabled);
    this.toggleAttribute('data-background-effects-off', !this.backgroundEffectsEnabled);
    this.wake();
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
      ${this.scene?.isFocusedView ? this.renderFocusBanner() : null}
      ${this.renderPeerDetailCard()}
      ${this.controlsVisible ? this.renderLegend() : null}
      ${this.renderControls()}
    `;
  }

  /** The detail card for the tapped peer — SwiftUI PeerDetailCardView
   *  parity, row for row. Rows are always present, even when empty: a
   *  missing value shows an explicit reason rather than disappearing,
   *  because the absence is itself the information. */
  private renderPeerDetailCard(): TemplateResult | typeof nothing {
    const key = this.detailPeerKey;
    const detail = key ? this.peerDetails?.get(key) : undefined;
    if (!detail) { return nothing; }
    return html`
      <div class="peer-detail-overlay">
        <section class="peer-detail-card" role="region"
                 aria-label="Details for ${detail.displayName}">
          <div class="peer-detail-header">
            <h3>${detail.displayName}</h3>
            <button class="peer-detail-close" aria-label="Close details"
                    title="Close"
                    @click=${this.closeDetail}>${this.closeIcon()}</button>
          </div>

          <div class="peer-detail-divider"></div>

          <div class="peer-detail-row peer-key-row">
            <span class="label">Peer key</span>
            <button class="peer-key-copy" aria-label="Copy peer key" title="Copy peer key"
                    ?disabled=${!detail.peerKey} @click=${this.copyPeerKey}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>
            </button>
            <span class="value mono">${detail.peerKey || 'not reported'}</span>
            <span class="peer-key-copy-status" role="status">${this.peerKeyCopyStatus === 'copied'
              ? 'Copied'
              : this.peerKeyCopyStatus === 'error' ? 'Could not copy. Select the key to copy it manually.' : ''}</span>
          </div>
          ${this.detailRow('OS', detail.os, 'not yet known')}
          ${this.detailRow('Ditto SDK', detail.sdkVersion, 'not yet known')}
          ${this.detailRow('Cloud link', detail.cloudLink === undefined
            ? undefined
            : detail.cloudLink ? 'Connected' : 'None')}
          ${this.detailRow('Compatible', detail.isCompatible === undefined
            ? undefined
            : detail.isCompatible ? 'Yes' : 'No', 'not yet known')}

          <div class="peer-detail-divider"></div>

          ${this.detailRow('Peer metadata', metadataKeySummary(detail.peerMetadataKeyCount))}
          ${this.detailRow('Identity metadata', metadataKeySummary(detail.identityMetadataKeyCount))}

          <div class="peer-detail-divider"></div>

          ${this.renderSyncSection(detail)}

          ${detail.peerKey !== this.scene?.focusedKey && !detail.isLocal ? html`
            <div class="peer-detail-divider"></div>
            <button class="peer-detail-focus" @click=${this.focusDetailPeer}>Focus this peer</button>
          ` : nothing}
        </section>
      </div>
    `;
  }

  private detailRow(
    label: string,
    value: string | undefined,
    missing = '—',
  ): TemplateResult {
    return html`
      <div class="peer-detail-row">
        <span class="label">${label}</span>
        <span class="value ${value === undefined ? 'missing' : ''}"
              title=${value ?? missing}>${value ?? missing}</span>
      </div>
    `;
  }

  private async copyPeerKey(): Promise<void> {
    const key = this.detailPeerKey ? this.peerDetails?.get(this.detailPeerKey)?.peerKey : undefined;
    if (!key) { return; }
    const request = ++this.peerKeyCopyRequest;
    let status: 'copied' | 'error';
    try {
      await navigator.clipboard.writeText(key);
      status = 'copied';
    } catch {
      status = 'error';
    }
    if (this.isConnected && request === this.peerKeyCopyRequest) {
      this.peerKeyCopyStatus = status;
    }
  }

  /** Three states, and the distinction is the point: `system:data_sync_info`
   *  is a local table computed from where this device actually receives
   *  data. It has no row for a peer we hold no session with, and none for
   *  ourselves — a blank here would read as a bug rather than as the fact
   *  it is. */
  private renderSyncSection(detail: PresencePeerCardDetail): TemplateResult {
    if (detail.isLocal) {
      return html`
        <p class="peer-detail-sync-title">This device</p>
        <p class="peer-detail-caption">Sync progress is tracked per remote peer, not for the local device.</p>
      `;
    }
    if (detail.isDirectlyConnected) {
      return html`
        ${this.detailRow('Synced to commit',
          detail.syncedUpToLocalCommitId?.toString(), 'nothing yet')}
        ${this.detailRow('Last update',
          formatLastUpdateMs(detail.lastUpdateReceivedTime, Date.now()), 'never')}
      `;
    }
    return html`
      <p class="peer-detail-sync-title">No sync session — not directly connected</p>
      <p class="peer-detail-caption">Commit progress is only tracked for peers this device syncs with directly.</p>
    `;
  }

  private renderFocusBanner(): TemplateResult {
    const label = this.scene?.focusedPeerLabel ?? 'selected device';
    return html`
      <div class="focus-banner" role="status">
        <span>Focused on <strong>${label}</strong></span>
        <button
          @click=${this.exitFocusedView}
          title="Show full mesh"
          aria-label="Exit focused node view and show full mesh"
        >${this.focusExitIcon()}</button>
      </div>
    `;
  }

  private focusExitIcon(): TemplateResult {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 9.6 6.4 14.2 11H3v2h11.2l-4.6 4.6L11 19l7-7-7-7Zm7.5-2H21v18h-2.5V3Z"/></svg>`;
  }

  private closeIcon(): TemplateResult {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"/></svg>`;
  }

  private renderLegend(): TemplateResult {
    const rows: { type: ConnectionTypeName; label: string; pattern: string }[] = [
      { type: 'Bluetooth',   label: 'Bluetooth',  pattern: '— — — —' },
      { type: 'AccessPoint', label: 'LAN',        pattern: '———— ————' },
      { type: 'P2PWiFi',     label: 'P2P WiFi',   pattern: '—— —— ——' },
      { type: 'Multicast',   label: 'Multicast',  pattern: '· · · · · ·' },
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
    const z = this.scene?.activeZoom ?? 1;
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
          <button
            class="icon-button"
            @click=${this.toggleBackgroundEffects}
            title=${this.backgroundEffectsEnabled ? 'Turn off background animation and gradient' : 'Turn on background animation and gradient'}
            aria-label="Background effects"
            aria-pressed=${this.backgroundEffectsEnabled}
          >${this.backgroundEffectsIcon()}</button>
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

  private backgroundEffectsIcon(): TemplateResult {
    return this.backgroundEffectsEnabled
      ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15ZM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6L5 15Z"/></svg>`
      : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15ZM3.7 2.3 2.3 3.7l18 18 1.4-1.4-18-18Z"/></svg>`;
  }

  private eyeIcon(): TemplateResult {
    return this.controlsVisible
      ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c5.5 0 9.5 5.4 9.7 5.6l.9 1.4-.9 1.4C21.5 13.6 17.5 19 12 19S2.5 13.6 2.3 13.4L1.4 12l.9-1.4C2.5 10.4 6.5 5 12 5Zm0 2c-4.4 0-7.8 4.4-8 5 .2.6 3.6 5 8 5s7.8-4.4 8-5c-.2-.6-3.6-5-8-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>`
      : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.3 2 18.7 18.7-1.3 1.3-3.2-3.2A10.7 10.7 0 0 1 12 20c-5.5 0-9.5-5.4-9.7-5.6L1.4 13l.9-1.4a18 18 0 0 1 3.1-3.3L2 3.3 3.3 2Zm3.5 7.7A16 16 0 0 0 4 13c.2.6 3.6 5 8 5 1.4 0 2.7-.4 3.8-.9l-2-2a3.5 3.5 0 0 1-4.9-4.9l-2.1-2.1v1.6ZM12 6c5.5 0 9.5 5.4 9.7 5.6l.9 1.4-.9 1.4c-.3.4-1.2 1.6-2.6 2.8l-1.4-1.4A16 16 0 0 0 20 13c-.2-.6-3.6-5-8-5-.7 0-1.4.1-2 .3L8.4 6.7A11 11 0 0 1 12 6Z"/></svg>`;
  }
}
