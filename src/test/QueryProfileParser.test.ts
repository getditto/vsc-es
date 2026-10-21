import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileItem } from '../ditto/QueryProfileParser.js';

const envelopeFixture = {
  '~request_profile': {
    _id: 'f701d177-83c6-4548-883b-5b14f5a5dd73',
    app_id: 'f5e954d9-80f2-47a8-9a79-2829e767ba7b',
    featureFlags: '0x3a',
    queryType: 'select',
    requestType: 'select',
    resultCount: 38,
    state: 'completed',
    text: 'PROFILE SELECT * FROM tasks WHERE done = true',
    times: {
      elapsed: 1_670_000,
      parse: 46_210,
      plan: 136_880,
      start: '2026-05-27T17:55:49Z',
    },
    plan: {
      '#operator': 'sequence',
      '#stats': { documentsIn: 38, documentsOut: 38 },
      children: [
        {
          '#operator': 'indexScan',
          '#stats': {
            documentsOut: 38,
            phaseTimes: { exec: 133_700, recv: 305_290, send: 85_120 },
          },
          collection: 'tasks',
          datasource: 'default',
          desc: { range: { high: '("included":true,"value":"low")' } },
        },
        {
          '#operator': 'fetch',
          '#stats': {
            documentsIn: 38,
            documentsOut: 38,
            phaseTimes: { exec: 10_980, recv: 1_240_000, send: 135_020 },
          },
          collection: 'tasks',
          datasource: 'default',
        },
        {
          '#operator': 'filter',
          '#stats': {
            documentsIn: 38,
            documentsOut: 38,
            phaseTimes: { exec: 20_980, recv: 104_250, send: 124_250 },
          },
          condition: "('done' = true)",
        },
      ],
    },
  },
};

test('parses an envelope-wrapped profile', () => {
  const before = Date.now();
  const p = parseProfileItem(envelopeFixture)!;
  const after = Date.now();
  assert.ok(p, 'expected a profile');
  assert.equal(p.id, 'f701d177-83c6-4548-883b-5b14f5a5dd73');
  assert.equal(p.appId, 'f5e954d9-80f2-47a8-9a79-2829e767ba7b');
  assert.equal(p.featureFlags, '0x3a');
  assert.equal(p.queryType, 'select');
  assert.equal(p.resultCount, 38);
  assert.equal(p.state, 'completed');
  assert.equal(p.times.elapsedNs, 1_670_000);
  assert.equal(p.times.parseNs, 46_210);
  assert.equal(p.times.planNs, 136_880);
  assert.equal(p.times.startISO, '2026-05-27T17:55:49Z');
  assert.ok(p.capturedAtMs >= before && p.capturedAtMs <= after);
  assert.equal(p.plan.name, 'sequence');
  assert.equal(p.plan.children.length, 3);
  assert.equal(p.plan.children[0]?.name, 'indexScan');
  assert.equal(p.plan.children[0]?.stats?.execNs, 133_700);
  assert.equal(p.plan.children[0]?.stats?.documentsOut, 38);
});

test('preserves operator attributes as ordered (key,value) pairs', () => {
  const p = parseProfileItem(envelopeFixture)!;
  const indexScan = p.plan.children[0];
  assert.ok(indexScan);
  const keys = indexScan.attributes.map(a => a.key);
  // Sorted alphabetically (the parser uses sorted-key iteration for
  // determinism) and excludes reserved keys.
  assert.deepEqual(keys, ['collection', 'datasource', 'desc']);
  const desc = indexScan.attributes.find(a => a.key === 'desc')!;
  // Nested objects re-encode as compact JSON.
  assert.equal(desc.value, '{"range":{"high":"(\\"included\\":true,\\"value\\":\\"low\\")"}}');
});

test('returns null for non-profile items', () => {
  assert.equal(parseProfileItem({ name: 'Alice', age: 30 }), null);
  assert.equal(parseProfileItem({}), null);
});

test('accepts a bare profile dict (no ~request_profile wrapper)', () => {
  const bare = envelopeFixture['~request_profile'];
  const p = parseProfileItem(bare)!;
  assert.ok(p, 'expected a profile even without the envelope wrapper');
  assert.equal(p.id, 'f701d177-83c6-4548-883b-5b14f5a5dd73');
});

test('returns null when required fields are missing', () => {
  assert.equal(parseProfileItem({ '~request_profile': { _id: 'x' } }), null);
  assert.equal(parseProfileItem({ '~request_profile': { plan: { '#operator': 'x' } } }), null);
});

test('missing times default to zero (does not crash)', () => {
  const trimmed: any = JSON.parse(JSON.stringify(envelopeFixture));
  delete trimmed['~request_profile'].times;
  const p = parseProfileItem(trimmed)!;
  assert.equal(p.times.elapsedNs, 0);
  assert.equal(p.times.parseNs, 0);
  assert.equal(p.times.planNs, 0);
  assert.equal(p.times.startISO, undefined);
});

test('does not misparse a user row with _id + plan as a profile (no envelope markers)', () => {
  // A document from a collection like `lesson_plans` — has a string
  // `_id` and a `plan` sub-document but is NOT a profile envelope.
  const userRow: Record<string, unknown> = {
    _id: 'plan-42',
    plan: {
      '#operator': 'scan',   // even with a parseable operator, this shouldn't qualify
      title: 'Geometry 101',
    },
    objective: 'Teach kids about triangles',
  };
  assert.equal(parseProfileItem(userRow), null);
});

test('does not misparse a user row whose only "envelope-like" field is `text`', () => {
  // A chat-message row — `text` is a common user field. The discriminator
  // must reject this even though `_id` + `plan` + `text` looks superficially
  // close to a profile envelope.
  const chatRow: Record<string, unknown> = {
    _id: 'msg-7',
    plan: { '#operator': 'note', body: 'lunch tomorrow?' },
    text: 'hello world',
  };
  assert.equal(parseProfileItem(chatRow), null);
});

// ─── SDK 5.1+ fields ────────────────────────────────────────────

test('parses stor phase time from phaseTimes', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan.children[0]['#stats'].phaseTimes.stor = 42_000;
  const p = parseProfileItem(fixture)!;
  assert.equal(p.plan.children[0]?.stats?.storNs, 42_000);
});

test('storNs is undefined when phaseTimes has no stor key', () => {
  const p = parseProfileItem(envelopeFixture)!;
  assert.equal(p.plan.children[0]?.stats?.storNs, undefined);
});

test('parses yields, dropping zero-valued entries', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan.children[0]['#stats'].yields = {
    budget: 0,
    sender: 3,
    receiver: 14_532,
    heartbeat: 0,
  };
  const p = parseProfileItem(fixture)!;
  assert.deepEqual(p.plan.children[0]?.stats?.yields, { sender: 3, receiver: 14_532 });
});

test('yields is undefined when all counters are zero', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan.children[0]['#stats'].yields = {
    budget: 0,
    sender: 0,
    receiver: 0,
    heartbeat: 0,
  };
  const p = parseProfileItem(fixture)!;
  assert.equal(p.plan.children[0]?.stats?.yields, undefined);
});

test('yields is undefined when the yields key is absent', () => {
  const p = parseProfileItem(envelopeFixture)!;
  assert.equal(p.plan.children[0]?.stats?.yields, undefined);
});

test('parses documentsSkipped', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan.children[0]['#stats'].documentsSkipped = 7;
  const p = parseProfileItem(fixture)!;
  assert.equal(p.plan.children[0]?.stats?.documentsSkipped, 7);
});

test('documentsSkipped is undefined when absent', () => {
  const p = parseProfileItem(envelopeFixture)!;
  assert.equal(p.plan.children[0]?.stats?.documentsSkipped, undefined);
});

test('parses nlJoin inner as a subplan, not an attribute', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan = {
    '#operator': 'nlJoin',
    '#stats': { documentsIn: 10, documentsOut: 5 },
    condition: '(`t1`.`cust_id` = `t2`.`cust_id`)',
    inner: {
      '#operator': 'sequence',
      children: [
        {
          '#operator': 'indexScan',
          '#stats': { documentsOut: 10, phaseTimes: { exec: 50_000, stor: 12_000 } },
          collection: 'orders',
        },
      ],
    },
    children: [
      {
        '#operator': 'scan',
        '#stats': { documentsOut: 10 },
        collection: 'customers',
        alias: 't1',
      },
    ],
  };
  const p = parseProfileItem(fixture)!;
  assert.equal(p.plan.name, 'nlJoin');
  assert.equal(p.plan.children.length, 1, 'outer side is a regular child');
  assert.equal(p.plan.subplans.length, 1, 'inner is a subplan');
  assert.equal(p.plan.subplans[0]?.key, 'inner');
  assert.equal(p.plan.subplans[0]?.plan.name, 'sequence');
  assert.equal(p.plan.subplans[0]?.plan.children[0]?.name, 'indexScan');
  assert.equal(p.plan.subplans[0]?.plan.children[0]?.stats?.storNs, 12_000);
  // condition and outer are attributes, not subplans.
  const attrKeys = p.plan.attributes.map(a => a.key);
  assert.ok(attrKeys.includes('condition'));
  assert.ok(!attrKeys.includes('inner'), 'inner must not be an attribute');
});

test('nlJoin outer flag is an attribute, not a subplan', () => {
  const fixture = JSON.parse(JSON.stringify(envelopeFixture));
  fixture['~request_profile'].plan = {
    '#operator': 'nlJoin',
    outer: true,
    condition: '(`t1`.`id` = `t2`.`id`)',
    inner: {
      '#operator': 'scan',
      collection: 'orders',
    },
    children: [
      { '#operator': 'scan', collection: 'customers' },
    ],
  };
  const p = parseProfileItem(fixture)!;
  assert.equal(p.plan.subplans.length, 1);
  assert.equal(p.plan.subplans[0]?.key, 'inner');
  const outerAttr = p.plan.attributes.find(a => a.key === 'outer');
  assert.equal(outerAttr?.value, 'true');
});
