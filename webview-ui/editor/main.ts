import './editor-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-database-editor');
  root.appendChild(el);
}
