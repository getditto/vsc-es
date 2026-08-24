import './query-element.js';
import './profile-viewer.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-query-editor');
  root.appendChild(el);
}
