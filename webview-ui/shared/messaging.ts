declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

const api = acquireVsCodeApi();

export function postToHost<T>(msg: T): void {
  api.postMessage(msg);
}

export function onHostMessage<T>(handler: (msg: T) => void): void {
  window.addEventListener('message', e => handler(e.data as T));
}
