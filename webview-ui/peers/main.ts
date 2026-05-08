import './peers-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-peer-listing');
  root.appendChild(el);
}
