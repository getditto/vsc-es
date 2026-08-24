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
export function onHostMessage<T>(handler: (msg: T) => void): () => void {
  const listener = (e: MessageEvent): void => { handler(e.data as T); };
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
