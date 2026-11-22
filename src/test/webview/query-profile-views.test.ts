import test from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';
import { render, html } from 'lit';

/** These elements never import messaging.ts, but keep the harness idiom
 *  uniform with the other webview tests. */
(globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
  postMessage() {},
  getState() { return undefined; },
  setState() {},
});

await import('../../../webview-ui/query/profile-viewer.js');

import type { QueryProfile, QueryProfileOperator, QueryProfileStats } from '../../ditto/QueryProfile.js';

interface El extends HTMLElement {
  updateComplete: Promise<unknown>;
}

/** Fixture mirrors the parser output asserted in QueryProfileParser.test.ts —
 *  a `sequence` root over `indexScan` / `fetch` / `filter` leaves. */
function op(
  name: string,
  opts: { stats?: QueryProfileStats; attributes?: Array<{ key: string; value: string }>; children?: QueryProfileOperator[]; subplans?: Array<{ key: string; plan: QueryProfileOperator }> } = {},
): QueryProfileOperator {
  return {
    name,
    ...(opts.stats ? { stats: opts.stats } : {}),
    attributes: opts.attributes ?? [],
    children: opts.children ?? [],
    subplans: opts.subplans ?? [],
  };
}

function planFixture(): QueryProfileOperator {
  return op('sequence', {
    stats: { documentsIn: 38, documentsOut: 38 },
    children: [
      op('indexScan', {
        stats: { documentsOut: 38, execNs: 133_700, recvNs: 305_290, sendNs: 85_120 },
        attributes: [
          { key: 'collection', value: 'tasks' },
          { key: 'datasource', value: 'default' },
          { key: 'desc', value: '{"range":{"high":"(\\"included\\":true,\\"value\\":\\"low\\")"}}' },
        ],
      }),
      op('fetch', {
        stats: { documentsIn: 38, documentsOut: 38, execNs: 1_240_000, recvNs: 10_980, sendNs: 135_020 },
        attributes: [{ key: 'collection', value: 'tasks' }],
      }),
      op('filter', {
        stats: { documentsIn: 38, documentsOut: 38, execNs: 104_250 },
        attributes: [{ key: 'condition', value: "('done' = true)" }],
      }),
    ],
  });
}

function profileFixture(overrides: Partial<QueryProfile> = {}): QueryProfile {
  return {
    id: 'f701d177-83c6-4548-883b-5b14f5a5dd73',
    appId: 'f5e954d9-80f2-47a8-9a79-2829e767ba7b',
    featureFlags: '0x3a',
    queryType: 'select',
    requestType: 'select',
    resultCount: 38,
    state: 'completed',
    text: 'PROFILE SELECT * FROM tasks WHERE done = true',
    times: { elapsedNs: 1_670_000, parseNs: 46_210, planNs: 136_880, startISO: '2026-05-27T17:55:49Z' },
    capturedAtMs: Date.UTC(2026, 4, 27, 12, 55, 49),
    plan: planFixture(),
    ...overrides,
  };
}

async function mountViewer(
  t: { after(fn: () => void): void },
  props: { profile?: QueryProfile; mode?: string; lastQueryText?: string } = {},
): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`
    <ditto-profile-viewer
      .profile=${props.profile}
      mode=${props.mode ?? 'local'}
      lastQueryText=${props.lastQueryText ?? ''}
    ></ditto-profile-viewer>`, host);
  const el = host.querySelector('ditto-profile-viewer') as unknown as El;
  await el.updateComplete;
  return el;
}

async function settled(el: El): Promise<void> {
  await el.updateComplete;
  for (const k of el.shadowRoot!.querySelectorAll('ditto-profile-card-list, ditto-profile-plan-tree')) {
    await (k as unknown as El).updateComplete;
  }
}

// ─── profile-viewer: empty states ──────────────────────────────

test('ProfileViewer: http mode explains profiling is local-only', async t => {
  const el = await mountViewer(t, { mode: 'http' });
  const empty = el.shadowRoot!.querySelector('.empty')!;
  assert.match(empty.textContent, /Profiling runs on Local only/);
});

test('ProfileViewer: non-SELECT last query explains the SELECT gate', async t => {
  const el = await mountViewer(t, { lastQueryText: 'DELETE FROM tasks' });
  assert.match(el.shadowRoot!.querySelector('.empty')!.textContent,
    /Profile is only captured for SELECT statements/);
});

test('ProfileViewer: no query yet (or a SELECT that never ran) prompts to run one', async t => {
  const el = await mountViewer(t);
  assert.match(el.shadowRoot!.querySelector('.empty')!.textContent,
    /Run a query to capture a profile/);

  const el2host = document.createElement('div');
  document.body.appendChild(el2host);
  t.after(() => el2host.remove());
  render(html`<ditto-profile-viewer lastQueryText="SELECT * FROM tasks"></ditto-profile-viewer>`, el2host);
  const el2 = el2host.querySelector('ditto-profile-viewer') as unknown as El;
  await el2.updateComplete;
  assert.match(el2.shadowRoot!.querySelector('.empty')!.textContent,
    /Run a query to capture a profile/, 'a SELECT text still shows the run prompt, not the SELECT gate');
});

// ─── profile-viewer: populated state ───────────────────────────

test('ProfileViewer: populated profile renders header, summary, footer, legend', async t => {
  const el = await mountViewer(t, { profile: profileFixture() });
  await settled(el);
  const root = el.shadowRoot!;

  // Header strips the PROFILE prefix we prepended host-side.
  assert.equal(root.querySelector('.query-box')!.textContent, 'SELECT * FROM tasks WHERE done = true');
  assert.match(root.querySelector('.timestamp')!.textContent,
    /captured \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

  // Summary strip: label → formatted value.
  const cells = [...root.querySelectorAll('.grid .cell')].map(c => ({
    label: c.querySelector('.label')!.textContent,
    value: c.querySelector('.value')!.textContent,
  }));
  assert.deepEqual(cells, [
    { label: 'Elapsed', value: '1.67 ms' },
    { label: 'Parse', value: '46.21 µs' },
    { label: 'Plan', value: '136.88 µs' },
    { label: 'Result Count', value: (38).toLocaleString() },
    { label: 'FeatureFlags', value: '0x3a' },
    { label: 'QueryType', value: 'select' },
  ]);

  const footer = root.querySelector('.footer')!.textContent;
  assert.match(footer, /f701d177-83c6-4548-883b-5b14f5a5dd73/);
  assert.match(footer, /f5e954d9-80f2-47a8-9a79-2829e767ba7b/);
  assert.match(footer, /completed/);

  // Legend: nine badge rows plus the hotspot swatch row.
  assert.equal(root.querySelectorAll('.legend .legend-row').length, 9);
  assert.ok(root.querySelector('.legend-swatch.hotspot-swatch'));

  // Card mode is the default.
  assert.ok(root.querySelector('ditto-profile-card-list'));
  assert.equal(root.querySelector('ditto-profile-plan-tree'), null);
});

test('ProfileViewer: Card/Plan toggle swaps the plan renderer', async t => {
  const el = await mountViewer(t, { profile: profileFixture() });
  await settled(el);

  const toggle = el.shadowRoot!.querySelectorAll('.plan-toggle button');
  assert.ok(toggle[0]!.classList.contains('active'), 'Card active by default');

  (toggle[1] as HTMLButtonElement).click();
  await settled(el);
  assert.ok(el.shadowRoot!.querySelector('ditto-profile-plan-tree'));
  assert.equal(el.shadowRoot!.querySelector('ditto-profile-card-list'), null);
  assert.ok(toggle[1]!.classList.contains('active'));
  assert.ok(!toggle[0]!.classList.contains('active'));

  (toggle[0] as HTMLButtonElement).click();
  await settled(el);
  assert.ok(el.shadowRoot!.querySelector('ditto-profile-card-list'));
});

test('ProfileViewer: missing optional fields fall back to the em dash', async t => {
  const el = await mountViewer(t, {
    profile: profileFixture({
      featureFlags: '', queryType: '', appId: '', state: '',
      capturedAtMs: Number.NaN,
      text: 'SELECT 1',
    }),
  });
  await settled(el);
  const root = el.shadowRoot!;

  assert.match(root.querySelector('.timestamp')!.textContent, /captured —/);
  assert.equal(root.querySelector('.query-box')!.textContent, 'SELECT 1',
    'text without a PROFILE prefix renders unchanged');
  const values = [...root.querySelectorAll('.grid .cell .value')].map(v => v.textContent);
  assert.equal(values[4], '—', 'empty featureFlags');
  assert.equal(values[5], '—', 'empty queryType');
  const footer = root.querySelector('.footer')!.textContent;
  assert.match(footer, /db:\s*—/, 'empty appId');
  assert.match(footer, /state:\s*—/, 'empty state');
});

// ─── profile-card-list ─────────────────────────────────────────

async function mountCardList(t: { after(fn: () => void): void }, root: QueryProfileOperator): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-profile-card-list .root=${root}></ditto-profile-card-list>`, host);
  const el = host.querySelector('ditto-profile-card-list') as unknown as El;
  await el.updateComplete;
  return el;
}

test('ProfileCardList: renders badges, attributes, and nested children', async t => {
  const el = await mountCardList(t, planFixture());
  const root = el.shadowRoot!;

  // One card per operator: sequence + 3 children.
  assert.equal(root.querySelectorAll('.card').length, 4);
  assert.equal(root.querySelectorAll('.child-wrap').length, 1, 'only the root has children');

  // indexScan reports four stats (no documentsIn) → four pills; sequence has two.
  const cards = root.querySelectorAll('.card');
  assert.equal(cards[0]!.querySelectorAll('ditto-pill').length, 2);
  assert.equal(cards[1]!.querySelectorAll('ditto-pill').length, 4);
  const pillText = (i: number) => [...cards[i]!.querySelectorAll('ditto-pill')]
    .map(p => `${p.getAttribute('label')}:${p.querySelector('.value')?.textContent ?? (p as any).value}`);
  assert.deepEqual(pillText(0), ['in:38', 'out:38']);
  assert.deepEqual(pillText(1), [
    `out:${(38).toLocaleString()}`,
    'exec:133.70 µs',
    'recv:305.29 µs',
    'send:85.12 µs',
  ]);

  // Attributes render as ordered key/value pairs.
  const attrs = [...cards[1]!.querySelectorAll('.attrs > span')].map(s => s.textContent);
  assert.deepEqual(attrs, ['collection', 'tasks', 'datasource', 'default',
    'desc', '{"range":{"high":"(\\"included\\":true,\\"value\\":\\"low\\")"}}']);

  // Names are shown per card.
  const names = [...root.querySelectorAll('.name')].map(n => n.textContent);
  assert.deepEqual(names, ['sequence', 'indexScan', 'fetch', 'filter']);
});

test('ProfileCardList: bare operator renders no badges, attrs, or child wrap', async t => {
  const el = await mountCardList(t, op('scan'));
  const root = el.shadowRoot!;
  assert.equal(root.querySelectorAll('.card').length, 1);
  assert.equal(root.querySelectorAll('ditto-pill').length, 0);
  assert.equal(root.querySelector('.attrs'), null);
  assert.equal(root.querySelector('.child-wrap'), null);
});

// ─── profile-plan-tree ─────────────────────────────────────────

async function mountPlanTree(t: { after(fn: () => void): void }, root: QueryProfileOperator): Promise<El> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  t.after(() => host.remove());
  render(html`<ditto-profile-plan-tree .root=${root}></ditto-profile-plan-tree>`, host);
  const el = host.querySelector('ditto-profile-plan-tree') as unknown as El;
  await el.updateComplete;
  return el;
}

test('ProfilePlanTree: leaf root renders one box, no connectors; sole exec reporter is the hotspot', async t => {
  const el = await mountPlanTree(t, op('scan', { stats: { execNs: 209 } }));
  const root = el.shadowRoot!;

  const boxes = root.querySelectorAll('.box');
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0]!.classList.contains('hotspot'), 'a lone operator is 100% of plan CPU');
  assert.equal(root.querySelectorAll('svg.connectors line').length, 0);
  assert.equal(boxes[0]!.querySelector('.time')!.textContent, '209 ns  (100.0%)');

  const canvas = root.querySelector('.canvas') as HTMLElement;
  assert.match(canvas.style.width, /^\d+px$/);
  assert.match(canvas.style.height, /^\d+px$/);
});

test('ProfilePlanTree: children get connector lines and a rail; io labels render', async t => {
  const el = await mountPlanTree(t, planFixture());
  const root = el.shadowRoot!;

  assert.equal(root.querySelectorAll('.box').length, 4);
  // Three child stems + parent drop + one horizontal rail = 5 lines.
  assert.equal(root.querySelectorAll('svg.connectors line').length, 5);

  const boxOf = (name: string) => [...root.querySelectorAll('.box')]
    .find(b => b.querySelector('.name')!.textContent === name)!;

  // fetch dominates plan CPU (1.24ms of ~1.48ms total) → hotspot styling.
  assert.ok(boxOf('fetch').classList.contains('hotspot'));
  assert.ok(boxOf('indexScan').classList.contains('normal'));
  assert.ok(boxOf('sequence').classList.contains('normal'), 'root reports no execNs → never a hotspot');

  // Key attribute prefers `collection`.
  assert.equal(boxOf('indexScan').querySelector('.key')!.textContent, 'tasks');
  // filter has no preferred attribute → no .key row.
  assert.equal(boxOf('filter').querySelector('.key'), null);

  // io labels: both in/out, and out-only for indexScan.
  assert.equal(boxOf('fetch').querySelector('.io')!.textContent,
    `${(38).toLocaleString()} in / ${(38).toLocaleString()} out`);
  assert.equal(boxOf('indexScan').querySelector('.io')!.textContent, `${(38).toLocaleString()} out`);

  // Time label carries the share of total plan CPU.
  assert.match(boxOf('fetch').querySelector('.time')!.textContent, /^1\.24 ms {2}\(\d+\.\d%\)$/);
});

test('ProfilePlanTree: io label degrades to in-only and disappears without stats', async t => {
  const tree = op('root', {
    children: [
      op('inOnly', { stats: { documentsIn: 7 } }),
      op('bare'),
    ],
  });
  const el = await mountPlanTree(t, tree);
  const root = el.shadowRoot!;
  const boxOf = (name: string) => [...root.querySelectorAll('.box')]
    .find(b => b.querySelector('.name')!.textContent === name)!;

  assert.equal(boxOf('inOnly').querySelector('.io')!.textContent, `${(7).toLocaleString()} in`);
  assert.equal(boxOf('bare').querySelector('.io'), null, 'no stats → no io row');
  assert.equal(boxOf('bare').querySelector('.time'), null, 'no execNs → no time row');
  assert.equal(boxOf('bare').querySelector('.key'), null);
  // One child stem + parent drop, no rail for a 2-child… two children → rail present.
  assert.equal(root.querySelectorAll('svg.connectors line').length, 4);
});

test('ProfilePlanTree: nested grandchildren recurse through the connector renderer', async t => {
  const tree = op('root', {
    children: [
      op('mid', { children: [op('leaf')] }),
    ],
  });
  const el = await mountPlanTree(t, tree);
  const root = el.shadowRoot!;
  assert.equal(root.querySelectorAll('.box').length, 3);
  // root→mid stem + root drop; mid→leaf stem + mid drop = 4 lines, no rails.
  assert.equal(root.querySelectorAll('svg.connectors line').length, 4);
});

test('ProfilePlanTree: key attribute preference order is collection > alias > limit > field > table', async t => {
  const tree = op('root', {
    children: [
      op('a', { attributes: [{ key: 'table', value: 'T' }, { key: 'field', value: 'F' }, { key: 'alias', value: 'A' }] }),
    ],
  });
  const el = await mountPlanTree(t, tree);
  const box = [...el.shadowRoot!.querySelectorAll('.box')]
    .find(b => b.querySelector('.name')!.textContent === 'a')!;
  assert.equal(box.querySelector('.key')!.textContent, 'A', 'alias beats field and table');
});

// ─── SDK 5.1+ fields: card-list ─────────────────────────────────

test('ProfileCardList: renders skipped, stor, and yields badges', async t => {
  const tree = op('scan', {
    stats: {
      documentsIn: 100,
      documentsOut: 90,
      documentsSkipped: 10,
      execNs: 500_000,
      recvNs: 200_000,
      sendNs: 50_000,
      storNs: 3_250_000,
      yields: { receiver: 2, heartbeat: 1 },
    },
  });
  const el = await mountCardList(t, tree);
  const pills = [...el.shadowRoot!.querySelectorAll('ditto-pill')];
  const pillMap = new Map(pills.map(p => [
    p.getAttribute('label'),
    (p as unknown as { value: string }).value,
  ]));
  assert.equal(pillMap.get('skipped'), (10).toLocaleString());
  assert.equal(pillMap.get('stor'), '3.25 ms');
  assert.equal(pillMap.get('yields'), `receiver ${(2).toLocaleString()} · heartbeat ${(1).toLocaleString()}`);
});

test('ProfileCardList: omitted SDK 5.1 fields produce no extra badges', async t => {
  // Pre-5.1 profile — no skipped, stor, or yields.
  const tree = op('scan', {
    stats: { documentsOut: 38, execNs: 133_700, recvNs: 305_290, sendNs: 85_120 },
  });
  const el = await mountCardList(t, tree);
  const labels = [...el.shadowRoot!.querySelectorAll('ditto-pill')].map(p => p.getAttribute('label'));
  assert.deepEqual(labels, ['out', 'exec', 'recv', 'send']);
});

test('ProfileCardList: zero documentsSkipped is not rendered', async t => {
  const tree = op('scan', {
    stats: { documentsOut: 10, documentsSkipped: 0, execNs: 1000 },
  });
  const el = await mountCardList(t, tree);
  const labels = [...el.shadowRoot!.querySelectorAll('ditto-pill')].map(p => p.getAttribute('label'));
  assert.ok(!labels.includes('skipped'), 'zero skipped should not render a badge');
});

test('ProfileCardList: nlJoin renders inner as a labeled subplan', async t => {
  const tree = op('nlJoin', {
    stats: { documentsIn: 10, documentsOut: 5 },
    attributes: [{ key: 'condition', value: '(`t1`.`id` = `t2`.`id`)' }],
    children: [
      op('scan', { stats: { documentsOut: 10 }, attributes: [{ key: 'collection', value: 'customers' }] }),
    ],
    subplans: [{
      key: 'inner',
      plan: op('sequence', {
        children: [
          op('indexScan', { stats: { documentsOut: 10, execNs: 50_000, storNs: 12_000 }, attributes: [{ key: 'collection', value: 'orders' }] }),
        ],
      }),
    }],
  });
  const el = await mountCardList(t, tree);
  const root = el.shadowRoot!;

  // The subplan label is rendered.
  const subplanLabel = root.querySelector('.subplan-label');
  assert.ok(subplanLabel, 'subplan label present');
  assert.equal(subplanLabel.textContent, 'inner');

  // The subplan tree is nested inside the subplan-wrap.
  const subplanWrap = root.querySelector('.subplan-wrap');
  assert.ok(subplanWrap, 'subplan wrap present');
  const subplanCards = subplanWrap.querySelectorAll('.card');
  assert.equal(subplanCards.length, 2, 'sequence + indexScan inside the subplan');

  // The inner indexScan's stor badge renders.
  const innerPills = subplanWrap.querySelectorAll('ditto-pill');
  const storPill = [...innerPills].find(p => p.getAttribute('label') === 'stor');
  assert.ok(storPill, 'stor badge inside subplan');
  assert.equal((storPill as unknown as { value: string }).value, '12.00 µs');
});

// ─── SDK 5.1+ fields: plan-tree ─────────────────────────────────

test('ProfilePlanTree: stor time renders in the box', async t => {
  const tree = op('indexScan', {
    stats: { documentsOut: 38, execNs: 133_700, storNs: 3_250_000 },
  });
  const el = await mountPlanTree(t, tree);
  const box = el.shadowRoot!.querySelector('.box')!;
  const stor = box.querySelector('.stor');
  assert.ok(stor, 'stor label present');
  assert.equal(stor.textContent, 'stor 3.25 ms');
});

test('ProfilePlanTree: no stor row when absent', async t => {
  const tree = op('scan', { stats: { execNs: 209 } });
  const el = await mountPlanTree(t, tree);
  assert.equal(el.shadowRoot!.querySelector('.stor'), null);
});

test('ProfilePlanTree: skipped count in io label', async t => {
  const tree = op('filter', {
    stats: { documentsIn: 100, documentsOut: 90, documentsSkipped: 10, execNs: 5000 },
  });
  const el = await mountPlanTree(t, tree);
  const io = el.shadowRoot!.querySelector('.box .io')!;
  assert.match(io.textContent, /100 in/);
  assert.match(io.textContent, /90 out/);
  assert.match(io.textContent, /10 skipped/);
});

test('ProfilePlanTree: yields label renders in the box', async t => {
  const tree = op('scan', {
    stats: { execNs: 209, yields: { receiver: 3, budget: 1 } },
  });
  const el = await mountPlanTree(t, tree);
  const yields = el.shadowRoot!.querySelector('.box .yields');
  assert.ok(yields, 'yields label present');
  assert.match(yields.textContent, /receiver 3/);
  assert.match(yields.textContent, /budget 1/);
});

test('ProfilePlanTree: subplan roots render their branch label', async t => {
  const tree = op('nlJoin', {
    stats: { execNs: 100_000 },
    children: [op('scan', { stats: { execNs: 50_000 } })],
    subplans: [{
      key: 'inner',
      plan: op('sequence', {
        children: [op('indexScan', { stats: { execNs: 30_000 } })],
      }),
    }],
  });
  const el = await mountPlanTree(t, tree);
  const boxes = el.shadowRoot!.querySelectorAll('.box');
  // nlJoin + scan (child) + sequence (subplan) + indexScan (subplan child) = 4
  assert.equal(boxes.length, 4);
  const names = [...boxes].map(b => b.querySelector('.name')!.textContent);
  assert.ok(names.includes('nlJoin'));
  assert.ok(names.includes('scan'));
  assert.ok(names.includes('sequence'));
  assert.ok(names.includes('indexScan'));
  const labels = el.shadowRoot!.querySelectorAll('.subplan-label');
  assert.equal(labels.length, 1);
  assert.equal(labels[0]?.textContent, 'inner');
  assert.equal(labels[0]?.closest('.box')?.querySelector('.name')?.textContent, 'sequence');
});
