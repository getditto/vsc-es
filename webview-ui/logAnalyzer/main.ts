import './log-analyzer-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-log-analyzer');
  root.appendChild(el);
}
