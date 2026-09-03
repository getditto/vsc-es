import type { ReactiveController, ReactiveControllerHost } from 'lit';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const api = acquireVsCodeApi();

export function postToHost<T>(msg: T): void {
  api.postMessage(msg);
}

/**
 * Subscribe to messages posted by the extension host.
 *
 * Returns a disposer that MUST be called from the subscriber's
 * `disconnectedCallback`. Elements are registered in `connectedCallback`,
 * which runs again on every re-attach (and VS Code moves webview panels
 * between editor groups), so without the disposer each move leaves another
 * live handler holding a reference to the old element — every subsequent
 * host message is then processed once per past mount.
 */
/**
 * Schemes a host message may legitimately arrive from.
 *
 * VS Code serves webview content from `vscode-webview://<uuid>` on the
 * desktop, but from an https origin when the editor is itself running in a
 * browser (Codespaces, a remote workspace opened over the web). Both are the
 * editor talking to its own webview, so both are trusted; the check exists to
 * reject everything else — `file:`, `http:`, `data:`, a null origin.
 *
 * Deliberately matched by scheme rather than by full origin: the uuid host is
 * generated per webview and the browser-hosted origin varies by deployment,
 * so pinning an exact value would break panels in exactly the environments
 * hardest to test in.
 *
 * This is defence in depth, not the primary control. The panels' CSP is
 * `default-src 'none'` with nonce-gated scripts and no `frame-src`, so there
 * is no way to embed a frame or run injected script that could post here in
 * the first place — see `panelHtml` in src/panels/webview-utils.ts.
 */
const TRUSTED_ORIGIN_SCHEMES = ['vscode-webview:', 'https:'];

export function isTrustedHostOrigin(origin: string): boolean {
  return TRUSTED_ORIGIN_SCHEMES.some(scheme => origin.startsWith(scheme));
}

function onHostMessage<T>(handler: (msg: T) => void): () => void {
  const listener = (e: MessageEvent): void => {
    if (!isTrustedHostOrigin(e.origin)) { return; }
    handler(e.data as T);
  };
  window.addEventListener('message', listener);
  return () => { window.removeEventListener('message', listener); };
}

/**
 * Host-message subscription as a Lit ReactiveController.
 *
 * Declare one as a field and the subscription's lifetime is handled:
 *
 * ```ts
 * private hostMessages = new HostMessages<In>(this, msg => this.onHost(msg));
 * ```
 *
 * Lit calls `hostConnected`/`hostDisconnected` around the element's own
 * lifecycle, so there is no `connectedCallback`/`disconnectedCallback` pair to
 * write — and therefore no way to add the subscribe half and forget the
 * dispose half. That omission is not hypothetical: VS Code re-parents webview
 * panels when they move between editor groups, so a missing disposer leaves a
 * live handler on the detached element and every later host message is
 * processed once per past mount.
 */
export class HostMessages<T> implements ReactiveController {
  private dispose: (() => void) | undefined;

  constructor(
    host: ReactiveControllerHost,
    private readonly handler: (msg: T) => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    // Re-subscribing on every connect is correct: hostDisconnected tore the
    // previous subscription down, and a re-attach must start listening again.
    this.dispose?.();
    this.dispose = onHostMessage<T>(msg => this.handler(msg));
  }

  hostDisconnected(): void {
    this.dispose?.();
    this.dispose = undefined;
  }
}
