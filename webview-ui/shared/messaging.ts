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
