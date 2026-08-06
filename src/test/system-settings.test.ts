import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySystemSettings,
  normalizeSystemSettings,
  parseShowAllOptions,
  systemSettingsEqual,
  validateSystemSettings,
} from '../ditto/system-settings.js';

test('normalizeSystemSettings trims and uppercases parameter names', () => {
  assert.deepEqual(normalizeSystemSettings([
    { parameter: ' max_query_time ', type: 'integer', value: 10 },
  ]), [
    { parameter: 'MAX_QUERY_TIME', type: 'integer', value: 10 },
  ]);
});

test('validateSystemSettings accepts supported typed values', () => {
  assert.equal(validateSystemSettings([
    { parameter: 'FEATURE_ON', type: 'boolean', value: true },
    { parameter: 'LIMIT', type: 'integer', value: 12 },
    { parameter: 'LABEL', type: 'string', value: 'demo' },
    { parameter: 'DIRECTIVES', type: 'json', value: { '#reprepare': true } },
  ]), null);
});

test('validateSystemSettings rejects unsafe, duplicate, reserved, and invalid values', () => {
  assert.match(validateSystemSettings([
    { parameter: 'A; RESET ALL', type: 'string', value: '' },
  ])!, /invalid name/);
  assert.match(validateSystemSettings([
    { parameter: 'limit', type: 'integer', value: 1 },
    { parameter: 'LIMIT', type: 'integer', value: 2 },
  ])!, /more than once/);
  assert.match(validateSystemSettings([
    { parameter: 'DQL_STRICT_MODE', type: 'boolean', value: true },
  ])!, /dedicated control/);
  assert.match(validateSystemSettings([
    { parameter: 'LIMIT', type: 'integer', value: 1.5 },
  ])!, /integer/);
  assert.match(validateSystemSettings([
    { parameter: 'WHEN', type: 'json', value: new Date() },
  ])!, /valid JSON/);
  assert.match(validateSystemSettings([
    { parameter: 'BYTES', type: 'json', value: new Uint8Array([1, 2]) },
  ])!, /valid JSON/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.match(validateSystemSettings([
    { parameter: 'CYCLE', type: 'json', value: cyclic },
  ])!, /valid JSON/);
  let tooDeep: Record<string, unknown> = {};
  const root = tooDeep;
  for (let i = 0; i < 66; i++) {
    const child: Record<string, unknown> = {};
    tooDeep.child = child;
    tooDeep = child;
  }
  assert.match(validateSystemSettings([
    { parameter: 'DEEP', type: 'json', value: root },
  ])!, /valid JSON/);
  assert.match(validateSystemSettings([
    { parameter: 'HUGE', type: 'json', value: 'x'.repeat(1_000_001) },
  ])!, /valid JSON/);
  assert.match(validateSystemSettings([
    { parameter: 'HUGE_KEY', type: 'json', value: { ['k'.repeat(1_000_001)]: true } },
  ])!, /valid JSON/);
});

test('applySystemSettings executes ordered parameterized ALTER statements', async () => {
  const calls: unknown[][] = [];
  await applySystemSettings({
    async execute(query, args) { calls.push([query, args]); return {}; },
  }, [
    { parameter: ' max_query_time ', type: 'integer', value: 20 },
    { parameter: 'label', type: 'string', value: "O'Reilly" },
  ]);
  assert.deepEqual(calls, [
    ['ALTER SYSTEM SET MAX_QUERY_TIME TO :value', { value: 20 }],
    ['ALTER SYSTEM SET LABEL TO :value', { value: "O'Reilly" }],
  ]);
});

test('applySystemSettings stops after the first failed setting', async () => {
  const calls: string[] = [];
  await assert.rejects(applySystemSettings({
    async execute(query) {
      calls.push(query);
      if (query.includes('SECOND')) { throw new Error('unsupported'); }
      return {};
    },
  }, [
    { parameter: 'FIRST', type: 'boolean', value: true },
    { parameter: 'SECOND', type: 'integer', value: 2 },
    { parameter: 'THIRD', type: 'string', value: 'never' },
  ]), /Failed to apply startup setting "SECOND"\./);
  assert.deepEqual(calls, [
    'ALTER SYSTEM SET FIRST TO :value',
    'ALTER SYSTEM SET SECOND TO :value',
  ]);
});

test('applySystemSettings does not expose rejected values from SDK errors', async () => {
  const secretValue = 'sentinel-private-value';
  await assert.rejects(applySystemSettings({
    async execute() { throw new Error(`invalid value: ${secretValue}`); },
  }, [
    { parameter: 'PRIVATE_LABEL', type: 'string', value: secretValue },
  ]), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /PRIVATE_LABEL/);
    assert.doesNotMatch(error.message, new RegExp(secretValue));
    return true;
  });
});

test('systemSettingsEqual ignores JSON object key order but preserves array order', () => {
  assert.equal(systemSettingsEqual(
    [{ parameter: 'DIRECTIVES', type: 'json', value: { first: 1, second: [1, 2] } }],
    [{ parameter: 'DIRECTIVES', type: 'json', value: { second: [1, 2], first: 1 } }],
  ), true);
  assert.equal(systemSettingsEqual(
    [{ parameter: 'DIRECTIVES', type: 'json', value: { values: [1, 2] } }],
    [{ parameter: 'DIRECTIVES', type: 'json', value: { values: [2, 1] } }],
  ), false);
});

test('parseShowAllOptions infers types, skips unset and reserved settings, and sorts', () => {
  const result = {
    items: [
      { value: { parameter: 'max_query_time', value: 30 } },
      { value: { parameter_name: 'feature_on', current_value: true } },
      { value: { name: 'dql_strict_mode', value: false } },
      { value: { name: 'unset_option', value: null } },
      { value: { directives: { '#reprepare': true } } },
    ],
  };
  assert.deepEqual(parseShowAllOptions(result), [
    { parameter: 'DIRECTIVES', type: 'json', value: { '#reprepare': true } },
    { parameter: 'FEATURE_ON', type: 'boolean', value: true },
    { parameter: 'MAX_QUERY_TIME', type: 'integer', value: 30 },
  ]);
});

test('parseShowAllOptions deterministically keeps the first duplicate parameter', () => {
  assert.deepEqual(parseShowAllOptions({ items: [
    { value: { limit: 10 } },
    { value: { LIMIT: 20 } },
  ] }), [
    { parameter: 'LIMIT', type: 'integer', value: 10 },
  ]);
});
