import './import-subs-element.js';

const root = document.getElementById('root');
if (root) {
  const el = document.createElement('ditto-import-subscriptions');
  root.appendChild(el);
}
