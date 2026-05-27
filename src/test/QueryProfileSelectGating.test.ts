import test from 'node:test';
import assert from 'node:assert/strict';
import { isSelectStatement, alreadyHasProfilePrefix, isProfilableSelect } from '../ditto/QueryProfileParser.js';

test('isSelectStatement: plain SELECT', () => {
  assert.equal(isSelectStatement('SELECT * FROM tasks'), true);
  assert.equal(isSelectStatement('  SELECT 1'), true);
  assert.equal(isSelectStatement('select * from x'), true);
  assert.equal(isSelectStatement('\n\tSELECT *\nFROM x'), true);
});

test('isSelectStatement: rejects non-SELECT', () => {
  assert.equal(isSelectStatement('INSERT INTO tasks ...'), false);
  assert.equal(isSelectStatement('UPDATE tasks SET x = 1'), false);
  assert.equal(isSelectStatement('DELETE FROM tasks'), false);
  assert.equal(isSelectStatement('EVICT FROM tasks'), false);
  assert.equal(isSelectStatement(''), false);
  assert.equal(isSelectStatement('   '), false);
});

test('isSelectStatement: rejects SELECTOR / SELECTED prefix (word-boundary)', () => {
  assert.equal(isSelectStatement('SELECTOR foo'), false);
  assert.equal(isSelectStatement('SELECTED'), false);
});

test('alreadyHasProfilePrefix: positive cases', () => {
  assert.equal(alreadyHasProfilePrefix('PROFILE SELECT * FROM tasks'), true);
  assert.equal(alreadyHasProfilePrefix('profile select 1'), true);
  assert.equal(alreadyHasProfilePrefix('  PROFILE\nSELECT *'), true);
});

test('alreadyHasProfilePrefix: negative cases', () => {
  assert.equal(alreadyHasProfilePrefix('SELECT * FROM tasks'), false);
  assert.equal(alreadyHasProfilePrefix('PROFILES * FROM tasks'), false);
  assert.equal(alreadyHasProfilePrefix(''), false);
});

// `isProfilableSelect` answers "would Ditto's response carry a profile
// envelope?" — true for both bare SELECTs AND user-typed PROFILE-wrapped
// SELECTs. The DittoManager.executeQuery strip-block gates on this so
// the envelope row is removed from the result table in both cases (the
// previous gate used isSelectStatement which silently missed the
// user-typed PROFILE case).
test('isProfilableSelect: plain SELECT is profilable', () => {
  assert.equal(isProfilableSelect('SELECT * FROM tasks'), true);
  assert.equal(isProfilableSelect('  select 1'), true);
});

test('isProfilableSelect: PROFILE SELECT is profilable (the bug class)', () => {
  // This is the case the prior gate (isSelectStatement alone) missed —
  // the leading word is PROFILE so isSelectStatement returned false,
  // and the envelope row leaked into the result table.
  assert.equal(isProfilableSelect('PROFILE SELECT * FROM tasks'), true);
  assert.equal(isProfilableSelect('  profile\nSELECT * FROM x'), true);
  assert.equal(isProfilableSelect('PROFILE select 1'), true);
});

test('isProfilableSelect: non-SELECT (with or without PROFILE) is not profilable', () => {
  assert.equal(isProfilableSelect('INSERT INTO tasks ...'), false);
  assert.equal(isProfilableSelect('UPDATE tasks SET x = 1'), false);
  // PROFILE on a non-SELECT is a DQL error anyway, but the gate should
  // still answer "no envelope expected" so we don't strip a user row.
  assert.equal(isProfilableSelect('PROFILE INSERT INTO tasks ...'), false);
  assert.equal(isProfilableSelect(''), false);
  assert.equal(isProfilableSelect('   '), false);
});

test('isProfilableSelect: word-boundary survives the strip', () => {
  // 'PROFILE SELECTOR foo' would strip to 'SELECTOR foo' — still not
  // a SELECT, so still not profilable.
  assert.equal(isProfilableSelect('PROFILE SELECTOR foo'), false);
  // Bare SELECTED still rejected.
  assert.equal(isProfilableSelect('SELECTED'), false);
});
