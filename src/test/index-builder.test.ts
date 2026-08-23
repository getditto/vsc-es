import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIndexFields,
  makeIndexName,
  buildCreateIndexQuery,
  buildDropIndexQuery,
  parseIndexKeys,
  indexKeysMatch,
  describeIndexKeys,
  InvalidIndexError,
} from '../ditto/index-builder.js';
import type { IndexField } from '../models/DittoCollection.js';

/**
 * DQL index builders and the `system:indexes` reader.
 *
 * Ditto SDK 5.1 supports composite indexes. Field order is significant — the
 * optimizer only uses a composite index from its leading key onwards — so
 * "preserves the order given" is a correctness property here, not a detail.
 *
 * `dql-live.test.ts` proves the emitted statements actually parse; these cover
 * the text and the parsing.
 */

const f = (name: string, ascending = true): IndexField => ({ name, ascending });

// ─── normalizeIndexFields ──────────────────────────────────────

test('normalizeIndexFields: trims and drops blank rows', () => {
  // The editor always carries at least one row, so blanks reach here whenever
  // someone adds a row and does not fill it in.
  assert.deepEqual(
    normalizeIndexFields([f('  status  '), f(''), f('   '), f('createdAt', false)]),
    [f('status'), f('createdAt', false)],
  );
});

test('normalizeIndexFields: rejects an all-blank list', () => {
  // Otherwise this builds `CREATE INDEX … ON c ()`, which is a parse error the
  // user sees as a raw DQL failure.
  assert.throws(() => normalizeIndexFields([]), InvalidIndexError);
  assert.throws(() => normalizeIndexFields([f(''), f('  ')]), /At least one field/);
});

test('normalizeIndexFields: rejects a repeated field', () => {
  // Ditto would accept it, but a duplicate key adds nothing and makes the
  // generated name ambiguous (idx_c_a_a).
  assert.throws(() => normalizeIndexFields([f('a'), f('b'), f('a')]), /listed more than once/);
  // Differing only by direction is still the same key.
  assert.throws(() => normalizeIndexFields([f('a', true), f('a', false)]), /listed more than once/);
});

test('normalizeIndexFields: preserves the given order', () => {
  const given = [f('z'), f('a'), f('m')];
  assert.deepEqual(normalizeIndexFields(given).map(x => x.name), ['z', 'a', 'm']);
});

// ─── makeIndexName ─────────────────────────────────────────────

test('makeIndexName: idx_<collection>_<field…>', () => {
  assert.equal(makeIndexName('tasks', [f('status')]), 'idx_tasks_status');
  assert.equal(
    makeIndexName('tasks', [f('status'), f('createdAt', false)]),
    'idx_tasks_status_createdAt',
  );
});

test('makeIndexName: dots, spaces and dashes become underscores', () => {
  // A dot would read as the `<collection>.<index>` separator the SDK uses in
  // system:indexes._id; the others are just unreadable in a generated name.
  assert.equal(makeIndexName('order-items', [f('qty')]), 'idx_order_items_qty');
  assert.equal(makeIndexName('two words', [f('a b')]), 'idx_two_words_a_b');
  assert.equal(makeIndexName('tasks', [f('address.city')]), 'idx_tasks_address_city');
});

test('makeIndexName: direction does not change the name', () => {
  // Two indexes differing only by direction would collide by name. The
  // repository detects that and refuses rather than silently no-oping on
  // IF NOT EXISTS — see the same-name-different-definition test.
  assert.equal(
    makeIndexName('t', [f('a', true)]),
    makeIndexName('t', [f('a', false)]),
  );
});

// ─── buildCreateIndexQuery ─────────────────────────────────────

test('buildCreateIndexQuery: single field', () => {
  assert.equal(
    buildCreateIndexQuery('tasks', [f('status')]),
    'CREATE INDEX IF NOT EXISTS `idx_tasks_status` ON `tasks` (`status` ASC)',
  );
});

test('buildCreateIndexQuery: composite index keeps order and per-key direction', () => {
  assert.equal(
    buildCreateIndexQuery('tasks', [f('status'), f('createdAt', false)]),
    'CREATE INDEX IF NOT EXISTS `idx_tasks_status_createdAt` ON `tasks` '
    + '(`status` ASC, `createdAt` DESC)',
  );
});

test('buildCreateIndexQuery: nested paths are quoted per segment', () => {
  // `address.city` must become `` `address`.`city` `` — one backtick-quoted
  // identifier per segment, not a single quoted string containing a dot.
  assert.equal(
    buildCreateIndexQuery('people', [f('address.city'), f('name')]),
    'CREATE INDEX IF NOT EXISTS `idx_people_address_city_name` ON `people` '
    + '(`address`.`city` ASC, `name` ASC)',
  );
});

test('buildCreateIndexQuery: awkward collection and field names are quoted', () => {
  assert.equal(
    buildCreateIndexQuery('order-items', [f('unit price')]),
    'CREATE INDEX IF NOT EXISTS `idx_order_items_unit_price` ON `order-items` '
    + '(`unit price` ASC)',
  );
});

test('buildCreateIndexQuery: a backtick in a name is doubled, not escaped out', () => {
  const q = buildCreateIndexQuery('we`ird', [f('al`so')]);
  assert.match(q, /ON `we``ird`/);
  assert.match(q, /\(`al``so` ASC\)/);
});

test('buildCreateIndexQuery: an injection-shaped field stays inside the quotes', () => {
  const q = buildCreateIndexQuery('tasks', [f('a`); DROP INDEX `x')]);
  // Exactly one statement: no unescaped delimiter escaped the identifier.
  assert.equal(q.match(/CREATE INDEX/g)?.length, 1);
  assert.doesNotMatch(q, /DROP INDEX `x`/);
});

test('buildCreateIndexQuery: an explicit name overrides the generated one', () => {
  // The repository generates the name once, checks it against system:indexes,
  // then passes it in so the checked name and the created name cannot diverge.
  assert.match(
    buildCreateIndexQuery('tasks', [f('status')], 'my_custom_name'),
    /^CREATE INDEX IF NOT EXISTS `my_custom_name` ON `tasks`/,
  );
});

test('buildCreateIndexQuery: blanks are dropped before building', () => {
  assert.equal(
    buildCreateIndexQuery('t', [f('a'), f('  '), f('b')]),
    'CREATE INDEX IF NOT EXISTS `idx_t_a_b` ON `t` (`a` ASC, `b` ASC)',
  );
});

test('buildDropIndexQuery: quotes both identifiers', () => {
  assert.equal(
    buildDropIndexQuery('idx_order_items_qty', 'order-items'),
    'DROP INDEX IF EXISTS `idx_order_items_qty` ON `order-items`',
  );
});

// ─── parseIndexKeys ────────────────────────────────────────────

test('parseIndexKeys: SDK 5.1 descriptor shape', () => {
  assert.deepEqual(
    parseIndexKeys([{ key: ['status'], direction: 'asc' }]),
    [f('status')],
  );
});

test('parseIndexKeys: joins a multi-segment key into a dotted path', () => {
  // The previous reader took key[0] only, so `address.city` displayed as
  // `address` — a nested index looked like a top-level one in the tree.
  assert.deepEqual(
    parseIndexKeys([{ key: ['address', 'city'], direction: 'asc' }]),
    [f('address.city')],
  );
});

test('parseIndexKeys: reads the direction', () => {
  // Also previously discarded, so DESC was invisible.
  assert.deepEqual(
    parseIndexKeys([
      { key: ['status'], direction: 'asc' },
      { key: ['createdAt'], direction: 'desc' },
    ]),
    [f('status'), f('createdAt', false)],
  );
  // Case-insensitive, and anything unrecognised means ascending.
  assert.deepEqual(parseIndexKeys([{ key: ['a'], direction: 'DESC' }]), [f('a', false)]);
  assert.deepEqual(parseIndexKeys([{ key: ['a'] }]), [f('a')]);
  assert.deepEqual(parseIndexKeys([{ key: ['a'], direction: 'sideways' }]), [f('a')]);
});

test('parseIndexKeys: older string-array shape', () => {
  assert.deepEqual(parseIndexKeys(['status', 'done']), [f('status'), f('done')]);
});

test('parseIndexKeys: strips backticks older SDKs stored', () => {
  assert.deepEqual(parseIndexKeys(['`status`']), [f('status')]);
  assert.deepEqual(parseIndexKeys([{ key: ['`address`', '`city`'] }]), [f('address.city')]);
  // A doubled backtick inside a quoted segment collapses to one.
  assert.deepEqual(parseIndexKeys(['`we``ird`']), [f('we`ird')]);
});

test('parseIndexKeys: garbage yields no keys rather than throwing', () => {
  // These rows come from the SDK untyped; a shape change must degrade the tree
  // display, not break hydration for every collection.
  for (const bad of [undefined, null, 'string', 42, {}, [null], [{}], [{ key: [] }], [{ key: 'x' }]]) {
    assert.deepEqual(parseIndexKeys(bad), [], JSON.stringify(bad));
  }
});

test('parseIndexKeys: mixed valid and invalid entries keeps the valid ones', () => {
  assert.deepEqual(
    parseIndexKeys([{ key: ['a'] }, null, { key: [] }, 'b', 42]),
    [f('a'), f('b')],
  );
});

// ─── indexKeysMatch ────────────────────────────────────────────

test('indexKeysMatch: identical lists match', () => {
  assert.equal(indexKeysMatch([f('a'), f('b', false)], [f('a'), f('b', false)]), true);
});

test('indexKeysMatch: order matters', () => {
  // A composite index is not the same index with its keys permuted — it serves
  // different queries.
  assert.equal(indexKeysMatch([f('a'), f('b')], [f('b'), f('a')]), false);
});

test('indexKeysMatch: direction matters', () => {
  assert.equal(indexKeysMatch([f('a', true)], [f('a', false)]), false);
});

test('indexKeysMatch: length matters', () => {
  assert.equal(indexKeysMatch([f('a')], [f('a'), f('b')]), false);
  assert.equal(indexKeysMatch([], []), true);
});

// ─── describeIndexKeys ─────────────────────────────────────────

test('describeIndexKeys: renders the key list for labels and logs', () => {
  assert.equal(describeIndexKeys([f('status'), f('createdAt', false)]), 'status ASC, createdAt DESC');
  assert.equal(describeIndexKeys([]), '');
});

// ─── round trip ────────────────────────────────────────────────

test('a built index round-trips through the parser', () => {
  // What the repository relies on when it compares a requested definition to
  // an existing one: the keys it sends must come back equal.
  const requested = [f('status'), f('address.city', false), f('n')];
  const stored = [
    { key: ['status'], direction: 'asc' },
    { key: ['address', 'city'], direction: 'desc' },
    { key: ['n'], direction: 'asc' },
  ];
  assert.equal(indexKeysMatch(parseIndexKeys(stored), requested), true);
});
