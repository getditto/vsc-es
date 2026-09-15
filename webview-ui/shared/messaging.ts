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
 * VS Code's outer webview frame forwards messages to the same-origin inner
 * frame. Its injected API hides the outer window by setting window.parent
 * and window.top to window before our scripts run. A source === parent
 * check therefore rejects legitimate host messages. Validate the exact
 * origin instead, retaining the desktop and browser-hosted scheme limits.
 *
 * See getVsCodeApiScript and the 'message' forwarding handler in:
 * https://github.com/microsoft/vscode/blob/1.106.0/src/vs/workbench/contrib/webview/browser/pre/index.html
 * The nonce-gated panel CSP also prevents untrusted scripts/frames loading.
 */
const TRUSTED_ORIGIN_SCHEMES = ['vscode-webview:', 'https:'];

export function isTrustedHostOrigin(origin: string, expectedOrigin: string): boolean {
  return origin === expectedOrigin
    && TRUSTED_ORIGIN_SCHEMES.some(scheme => origin.startsWith(scheme));
}

function onHostMessage<T>(handler: (msg: T) => void): () => void {
  const listener = (e: MessageEvent): void => {
    if (!isTrustedHostOrigin(e.origin, window.origin)) { return; }
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
