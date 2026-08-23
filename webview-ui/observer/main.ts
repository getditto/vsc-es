import './observer-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-observer-panel');
  root.appendChild(el);
}
