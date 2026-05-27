import test from 'node:test';
import assert from 'node:assert/strict';
import { isSelectStatement, alreadyHasProfilePrefix } from '../ditto/QueryProfileParser.js';

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
