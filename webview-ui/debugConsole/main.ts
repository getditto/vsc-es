import './debug-console-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-debug-console');
  root.appendChild(el);
}
