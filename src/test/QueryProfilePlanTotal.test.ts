import test from 'node:test';
import assert from 'node:assert/strict';
import { subtreeExecNs } from '../../webview-ui/query/profile-plan-tree.js';
import type { QueryProfileOperator } from '../ditto/QueryProfile.js';

function op(execNs: number | undefined, children: QueryProfileOperator[] = []): QueryProfileOperator {
  return {
    name: 't',
    stats: execNs === undefined ? undefined : { execNs },
    children,
    attributes: [],
  };
}

test('subtreeExecNs: sums every reporting operator in the subtree', () => {
  const tree = op(100, [op(50, [op(25)]), op(75)]);
  assert.equal(subtreeExecNs(tree), 100 + 50 + 25 + 75);
});

test('subtreeExecNs: treats missing exec as 0', () => {
  const tree = op(undefined, [op(50), op(undefined, [op(10)])]);
  assert.equal(subtreeExecNs(tree), 60);
});

test('subtreeExecNs: a single node returns its own exec', () => {
  assert.equal(subtreeExecNs(op(42)), 42);
  assert.equal(subtreeExecNs(op(undefined)), 0);
});
