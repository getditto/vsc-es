import { JSDOM } from 'jsdom';

/** Shared jsdom boot — imported for its side effects from every webview
 *  test file. Installs the minimal set of DOM globals Lit needs before
 *  the components are imported (which is when @customElement runs and
 *  reaches for `customElements`/`HTMLElement`). */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
});

const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.customElements = dom.window.customElements;
g.CustomEvent = dom.window.CustomEvent;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.WheelEvent = dom.window.WheelEvent;
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.getComputedStyle = dom.window.getComputedStyle;

// ─── Canvas 2D stub ──────────────────────────────────────────────
//
// jsdom throws on getContext('2d') unless the native `canvas` package is
// installed, which would make the presence graph's whole render and
// pointer layer untestable (both are gated on a non-null context). This
// records every draw call along with the state that was live at the time,
// so tests can assert on compositing (globalAlpha, lineWidth, …) rather
// than merely that a function was reached.

/** One recorded draw call plus the graphics state in effect when it ran. */
export interface CanvasOp {
  op: string;
  args: unknown[];
  globalAlpha: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

export interface RecordingContext2D {
  __ops: CanvasOp[];
  __reset(): void;
  [key: string]: any;
}

/** Properties that participate in save()/restore(). */
const STATE_KEYS = [
  'globalAlpha', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap',
  'lineJoin', 'font', 'textAlign', 'textBaseline',
] as const;

/** Draw calls worth recording; path-building calls are ignored as noise. */
const RECORDED = ['fill', 'stroke', 'fillText', 'clearRect', 'setLineDash'];

/** Void methods that only build paths or mutate the transform. */
const NOOP_METHODS = [
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'quadraticCurveTo',
  'bezierCurveTo', 'rect', 'translate', 'rotate', 'scale', 'setTransform',
  'transform', 'resetTransform', 'clip', 'strokeRect', 'fillRect',
];

function createRecordingContext2D(canvas: any): RecordingContext2D {
  const ctx: any = { canvas };
  const stack: Record<string, unknown>[] = [];

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';

  ctx.__ops = [] as CanvasOp[];
  ctx.__reset = (): void => { ctx.__ops.length = 0; };

  const record = (op: string, args: unknown[]): void => {
    ctx.__ops.push({
      op,
      args,
      globalAlpha: ctx.globalAlpha,
      fillStyle: ctx.fillStyle,
      strokeStyle: ctx.strokeStyle,
      lineWidth: ctx.lineWidth,
    });
  };

  for (const name of NOOP_METHODS) {
    ctx[name] = (): void => {};
  }
  for (const name of RECORDED) {
    ctx[name] = (...args: unknown[]): void => { record(name, args); };
  }

  ctx.save = (): void => {
    const snapshot: Record<string, unknown> = {};
    for (const k of STATE_KEYS) { snapshot[k] = ctx[k]; }
    stack.push(snapshot);
  };
  ctx.restore = (): void => {
    const snapshot = stack.pop();
    if (!snapshot) { return; }
    for (const k of STATE_KEYS) { ctx[k] = snapshot[k]; }
  };

  // Deterministic, monospace-ish metrics: enough for the pill width math
  // to produce stable, non-zero hit-test bounds.
  ctx.measureText = (text: string) => ({ width: String(text).length * 6 });

  return ctx as RecordingContext2D;
}

const contexts = new WeakMap<any, RecordingContext2D>();

dom.window.HTMLCanvasElement.prototype.getContext = function getContext(
  this: any,
  kind: string,
): RecordingContext2D | null {
  if (kind !== '2d') { return null; }
  let ctx = contexts.get(this);
  if (!ctx) {
    ctx = createRecordingContext2D(this);
    contexts.set(this, ctx);
  }
  return ctx;
} as any;

/** Grab the recording context for a canvas without going through the
 *  element under test. */
export function contextFor(canvas: any): RecordingContext2D {
  return canvas.getContext('2d') as RecordingContext2D;
}

g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
