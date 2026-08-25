import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQueryAdvice } from '../ditto/advise.js';
import { isAdviseStatement, isSelectStatement, isProfilableSelect } from '../ditto/QueryProfileParser.js';

/**
 * ADVISE (SDK 5.1) gating + extraction — pure logic, no SDK. The row-shape
 * claims these fixtures encode are proven against a real store in
 * advise-live.test.ts.
 */

test('isAdviseStatement accepts whole-word ADVISE, case-insensitively', () => {
  assert.equal(isAdviseStatement('ADVISE SELECT * FROM t'), true);
  assert.equal(isAdviseStatement('  advise   select * from t'), true);
  assert.equal(isAdviseStatement('ADVISE AND PROVISION SELECT * FROM t'), true);
});

test('isAdviseStatement rejects non-ADVISE and prefix-collisions', () => {
  assert.equal(isAdviseStatement(''), false);
  assert.equal(isAdviseStatement('ADVISORY SELECT * FROM t'), false);
  assert.equal(isAdviseStatement('ADVISED SELECT * FROM t'), false);
  assert.equal(isAdviseStatement('SELECT * FROM t'), false);
});

test('gating interplay: ADVISE never gets the PROFILE prefix and is not profilable', () => {
  // These two properties are what keep executeQuery's auto-PROFILE and
  // envelope-strip paths away from ADVISE statements.
  assert.equal(isSelectStatement('ADVISE SELECT * FROM t'), false);
  assert.equal(isProfilableSelect('ADVISE SELECT * FROM t'), false);
});

const SUGGESTED = {
  collection: 'atest',
  reason: 'equality predicates on `e`',
  statement: 'CREATE INDEX IF NOT EXISTS adv_atest_e ON default:`atest` (`e` ASC)',
};

test('extractQueryAdvice reads the advice row with suggestions', () => {
  const rows = [{
    advice: { statement: 'SELECT * FROM atest WHERE e=1\n', suggestedIndexes: [SUGGESTED] },
  }];
  const advice = extractQueryAdvice(rows);
  assert.ok(advice);
  assert.equal(advice.statement, 'SELECT * FROM atest WHERE e=1\n');
  assert.equal(advice.suggestions.length, 1);
  assert.deepEqual(advice.suggestions[0], SUGGESTED);
});

test('extractQueryAdvice surfaces the no-advice outcome text', () => {
  const rows = [{ advice: { outcome: 'no keys to advise on', statement: 'SELECT * FROM atest\n' } }];
  const advice = extractQueryAdvice(rows);
  assert.ok(advice);
  assert.equal(advice.outcome, 'no keys to advise on');
  assert.equal(advice.suggestions.length, 0);
});

test('extractQueryAdvice returns null for ordinary query results', () => {
  assert.equal(extractQueryAdvice([{ _id: 'a', qty: 1 }]), null);
  assert.equal(extractQueryAdvice([]), null);
  assert.equal(extractQueryAdvice([{ advice: 'not-an-object' }]), null);
});

test('extractQueryAdvice drops partial suggestions rather than rendering half of one', () => {
  const rows = [{
    advice: {
      statement: 'SELECT * FROM t WHERE a = 1\n',
      suggestedIndexes: [
        { collection: 't', reason: 'ok', statement: 'CREATE INDEX IF NOT EXISTS adv_t_a ON default:`t` (`a` ASC)' },
        { collection: 't' },                       // missing statement — unusable
        { collection: 't', reason: 'no stmt' },
      ],
    },
  }];
  const advice = extractQueryAdvice(rows);
  assert.ok(advice);
  assert.equal(advice.suggestions.length, 1);
  assert.equal(advice.suggestions[0]?.collection, 't');
});

test('extractQueryAdvice merges advice spread over several rows (forward compatibility)', () => {
  const rows = [
    { advice: { statement: 'SELECT 1\n', suggestedIndexes: [SUGGESTED] } },
    { advice: { outcome: 'some extra row', suggestedIndexes: [{ ...SUGGESTED, collection: 'btest' }] } },
  ];
  const advice = extractQueryAdvice(rows);
  assert.ok(advice);
  assert.equal(advice.suggestions.length, 2);
  assert.equal(advice.statement, 'SELECT 1\n');
});
