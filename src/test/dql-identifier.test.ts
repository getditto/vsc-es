import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteIdentifier,
  quoteFieldPath,
  isBareIdentifier,
  InvalidIdentifierError,
} from '../ditto/dql-identifier.js';

test('quoteIdentifier: always backticks, even when quoting is unnecessary', () => {
  // Unconditional so there is no branch to get wrong; DQL treats a quoted
  // identifier that needed no quoting as the same identifier.
  assert.equal(quoteIdentifier('tasks'), '`tasks`');
  assert.equal(quoteIdentifier('_internal'), '`_internal`');
});

test('quoteIdentifier: accepts the names the old character whitelist rejected', () => {
  // Every one of these is a legal Ditto collection name. The previous
  // `^[A-Za-z0-9_]+$` guard threw on all of them, which meant Add Index and
  // Delete Index simply could not be used on such a collection.
  assert.equal(quoteIdentifier('order-items'), '`order-items`');
  assert.equal(quoteIdentifier('two words'), '`two words`');
  assert.equal(quoteIdentifier('Bestellungen'), '`Bestellungen`');
  assert.equal(quoteIdentifier('日本語'), '`日本語`');
  // …and one the old guard wrongly *accepted*: a leading digit is invalid as
  // a bare DQL identifier, so it has to be quoted to work at all.
  assert.equal(quoteIdentifier('9lives'), '`9lives`');
});

test('quoteIdentifier: a backtick is doubled', () => {
  // The only character with meaning inside a quoted identifier. Doubling is
  // the escape DQL specifies; anything else lets the identifier end early and
  // the remainder of the name become statement text.
  assert.equal(quoteIdentifier('we`ird'), '`we``ird`');
  // A name that is nothing but two backticks: each doubles to two, wrapped in
  // the delimiters — six in total.
  assert.equal(quoteIdentifier('``'), '`'.repeat(6));
});

test('quoteIdentifier: injection payloads stay inside the quotes', () => {
  for (const payload of [
    'x` ON tasks (a); DROP INDEX `y',
    "users'; DELETE FROM tasks; --",
    'a) ; SELECT * FROM secrets (',
  ]) {
    const quoted = quoteIdentifier(payload);
    // Exactly two unescaped delimiters: the opening and closing backtick.
    // Every interior backtick is doubled, so the count of runs is 2.
    const runs = quoted.match(/`+/g) ?? [];
    assert.equal(runs[0], '`', `opens with one backtick: ${payload}`);
    assert.equal(runs[runs.length - 1], '`', `closes with one backtick: ${payload}`);
    for (const run of runs.slice(1, -1)) {
      assert.equal(run.length % 2, 0, `interior backticks are doubled: ${payload}`);
    }
  }
});

test('quoteIdentifier: rejects what cannot be an identifier', () => {
  assert.throws(() => quoteIdentifier(''), InvalidIdentifierError);
  assert.throws(() => quoteIdentifier('a\0b'), InvalidIdentifierError);
  assert.throws(() => quoteIdentifier('a\nb'), InvalidIdentifierError);
  assert.throws(() => quoteIdentifier('a\rb'), InvalidIdentifierError);
});

test('quoteIdentifier: the error names the kind so the message is actionable', () => {
  assert.throws(
    () => quoteIdentifier('', 'collection'),
    /Invalid collection: name is empty/,
  );
});

test('quoteFieldPath: quotes each dot-separated segment', () => {
  assert.equal(quoteFieldPath('name'), '`name`');
  assert.equal(quoteFieldPath('address.city'), '`address`.`city`');
  assert.equal(quoteFieldPath('a.b.c'), '`a`.`b`.`c`');
});

test('quoteFieldPath: a segment needing quotes gets them without breaking the path', () => {
  assert.equal(quoteFieldPath('user-data.first name'), '`user-data`.`first name`');
});

test('quoteFieldPath: rejects empty segments', () => {
  for (const bad of ['a..b', '.a', 'a.', '.']) {
    assert.throws(() => quoteFieldPath(bad), InvalidIdentifierError);
  }
});

test('isBareIdentifier: matches the DQL rule, not just the character set', () => {
  assert.equal(isBareIdentifier('tasks'), true);
  assert.equal(isBareIdentifier('_x1'), true);
  // Must start with a letter or underscore — a leading digit is not bare.
  assert.equal(isBareIdentifier('9lives'), false);
  assert.equal(isBareIdentifier('has-dash'), false);
  assert.equal(isBareIdentifier(''), false);
});
