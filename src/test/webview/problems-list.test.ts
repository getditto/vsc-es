import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
await import('../../../webview-ui/logAnalyzer/components/problems-list.js');

function mkProblem(over: Partial<any> = {}) {
  // Round-trip through JSON: these objects reach the real webview via
  // postMessage, so a Date arrives as an ISO string. Constructing a real
  // Date here once masked a `.toISOString is not a function` render crash.
  return JSON.parse(JSON.stringify({
    patternKey: 'deadlock_critical',
    severity: 5,
    recommendation: 'Possible deadlock. Investigate.',
    line: {
      id: 1,
      timestamp: new Date('2026-06-09T14:00:00Z'),
      level: 'error',
      tag: 'sdk',
      raw: '',
      text: 'Waiting for write transaction has elapsed',
    },
    ...over,
  }));
}

test('ProblemsList: empty groups shows watching placeholder', async () => {
  const el = document.createElement('problems-list') as any;
  el.groups = [];
  document.body.appendChild(el);
  await el.updateComplete;
  assert.match(el.shadowRoot.innerHTML, /Watching for problems/);
  el.remove();
});

test('ProblemsList: renders one group per pattern with hit count', async () => {
  const el = document.createElement('problems-list') as any;
  el.groups = [
    { key: 'deadlock_critical', items: [mkProblem(), mkProblem()] },
    {
      key: 'memory_oom',
      items: [mkProblem({ patternKey: 'memory_oom', severity: 4 })],
    },
  ];
  document.body.appendChild(el);
  await el.updateComplete;
  const headers = el.shadowRoot.querySelectorAll('.header');
  assert.equal(headers.length, 2);
  assert.match(el.shadowRoot.innerHTML, /deadlock_critical/);
  // Lit injects marker comments between expressions, so assert on the
  // rendered text content rather than the raw HTML for the hit counts.
  const counts = [...el.shadowRoot.querySelectorAll('.count')].map(
    (n: any) => n.textContent.replace(/\s+/g, ' ').trim(),
  );
  assert.deepEqual(counts, ['(2 hits)', '(1 hit)']);
  el.remove();
});

test('ProblemsList: expanded hits render the timestamp carried as a string', async () => {
  const el = document.createElement('problems-list') as any;
  el.groups = [{ key: 'deadlock_critical', items: [mkProblem()] }];
  document.body.appendChild(el);
  await el.updateComplete;
  el.shadowRoot.querySelector('.header').click();
  await el.updateComplete;
  // Would throw "toISOString is not a function" when timestamp is a string.
  assert.equal(el.shadowRoot.querySelector('.hit .ts').textContent, '2026-06-09T14:00:00.000Z');
  el.remove();
});

test('ProblemsList: dispatches reveal-line event when arrow clicked', async () => {
  const el = document.createElement('problems-list') as any;
  el.groups = [{ key: 'deadlock_critical', items: [mkProblem()] }];
  document.body.appendChild(el);
  await el.updateComplete;
  // Click the header to expand the group so the hit link renders.
  el.shadowRoot.querySelector('.header').click();
  await el.updateComplete;
  let revealedId: number | null = null;
  el.addEventListener('reveal-line', (e: any) => {
    revealedId = e.detail.id;
  });
  el.shadowRoot.querySelector('.hit a').click();
  assert.equal(revealedId, 1);
  el.remove();
});
