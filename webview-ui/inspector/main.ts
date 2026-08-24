// webview-ui/inspector/main.ts
//
// Inspector webview entry. Imports each Lit element so the @customElement
// decorators register them.
//
// Note: `acquireVsCodeApi()` is called exactly once via `../shared/messaging.js`
// (imported transitively by the elements that need it). Do not call it here.

import './inspector-element.js';
import './help-content-element.js';
import './query-history-element.js';
import './query-favorites-element.js';
import './query-json-element.js';
import './query-metrics-element.js';
import './attachment-viewer-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-inspector');
  root.appendChild(el);
}
