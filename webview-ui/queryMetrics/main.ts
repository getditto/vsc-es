import './query-metrics-panel-element.js';
import { _setMirroredLevel } from '../shared/logger.js';

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg?.type === 'log.levelChanged') { _setMirroredLevel(msg.level); }
});

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-query-metrics');
  root.appendChild(el);
}
