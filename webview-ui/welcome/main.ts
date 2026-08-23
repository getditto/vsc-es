import './welcome-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-welcome');
  root.appendChild(el);
}
