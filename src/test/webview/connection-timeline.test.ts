import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
await import('../../../webview-ui/logAnalyzer/components/connection-timeline.js');

test('ConnectionTimeline: empty state placeholder', async () => {
  const el = document.createElement('connection-timeline') as any;
  el.sessions = [];
  el.reinits = [];
  document.body.appendChild(el);
  await el.updateComplete;
  assert.match(el.shadowRoot.innerHTML, /No connection events captured/);
  el.remove();
});

test('ConnectionTimeline: renders one rect per session', async () => {
  const el = document.createElement('connection-timeline') as any;
  el.sessions = [
    {
      start: new Date('2026-06-09T14:00:00Z'),
      end: new Date('2026-06-09T14:05:00Z'),
      remotePeer: 'abc',
      transport: 'Websocket',
      role: 'Client',
    },
    {
      start: new Date('2026-06-09T14:02:00Z'),
      end: new Date('2026-06-09T14:06:00Z'),
      remotePeer: 'def',
      transport: 'Bluetooth',
      role: 'Client',
    },
  ];
  el.reinits = [];
  document.body.appendChild(el);
  await el.updateComplete;
  const rects = el.shadowRoot.querySelectorAll('rect');
  assert.equal(rects.length, 2);
  el.remove();
});

test('ConnectionTimeline: renders reinit lines', async () => {
  const el = document.createElement('connection-timeline') as any;
  el.sessions = [
    {
      start: new Date('2026-06-09T14:00:00Z'),
      end: new Date('2026-06-09T14:10:00Z'),
      remotePeer: 'abc',
      transport: 'Websocket',
      role: 'Client',
    },
  ];
  el.reinits = [
    new Date('2026-06-09T14:05:00Z'),
    new Date('2026-06-09T14:07:00Z'),
  ];
  document.body.appendChild(el);
  await el.updateComplete;
  const lines = el.shadowRoot.querySelectorAll('line');
  assert.equal(lines.length, 2);
  el.remove();
});
