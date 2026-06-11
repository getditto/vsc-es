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
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.getComputedStyle = dom.window.getComputedStyle;
