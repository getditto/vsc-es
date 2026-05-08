import './sub-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-subscription-editor');
  root.appendChild(el);
}
