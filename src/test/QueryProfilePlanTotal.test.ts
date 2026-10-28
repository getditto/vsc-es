import test from 'node:test';
import assert from 'node:assert/strict';
import { subtreeExecNs, layout, flatten } from '../util/profilePlanLayout.js';
import type { QueryProfileOperator } from '../ditto/QueryProfile.js';

function op(execNs: number | undefined, children: QueryProfileOperator[] = []): QueryProfileOperator {
  return {
    name: 't',
    stats: execNs === undefined ? undefined : { execNs },
    children,
    attributes: [],
    subplans: [],
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

test('layout: a single leaf is centered', () => {
  const tree = op(0);
  const laid = layout(tree, 0);
  assert.equal(laid.subtreeWidth, 160);
  assert.equal(laid.centerX, 80);
});

test('layout/flatten: two leaves are placed symmetrically around root center', () => {
  // Root with two leaf children: subtreeWidth = 160 + 24 + 160 = 344
  const tree = op(0, [op(0), op(0)]);
  const laid = layout(tree, 0);
  assert.equal(laid.subtreeWidth, 344);
  const flat = flatten(laid);
  // flat[0] = root, flat[1] = left child, flat[2] = right child
  assert.equal(flat.length, 3);
  // Root center = 344/2 = 172
  assert.equal(flat[0]?.absX, 172);
  // Symmetry around root center:
  assert.equal((flat[1]?.absX ?? NaN) + (flat[2]?.absX ?? NaN), 2 * (flat[0]?.absX ?? NaN));
  // Concrete positions: left at 80, right at 264
  assert.equal(flat[1]?.absX, 80);
  assert.equal(flat[2]?.absX, 264);
});

test('layout/flatten: a single child is centered under its parent', () => {
  // Root with one child: subtreeWidth = max(160, 160) = 160
  // Both root and child centerX = 80
  const tree = op(0, [op(0)]);
  const laid = layout(tree, 0);
  assert.equal(laid.subtreeWidth, 160);
  const flat = flatten(laid);
  assert.equal(flat.length, 2);
  // Root and child should be vertically aligned (same absX).
  assert.equal(flat[0]?.absX, flat[1]?.absX);
});

test('layout/flatten: three leaves at top level', () => {
  // subtreeWidth = 3*160 + 2*24 = 528
  const tree = op(0, [op(0), op(0), op(0)]);
  const laid = layout(tree, 0);
  assert.equal(laid.subtreeWidth, 528);
  const flat = flatten(laid);
  // [root, leftChild, midChild, rightChild]
  assert.equal(flat.length, 4);
  // Root at 264 (subtreeWidth/2)
  assert.equal(flat[0]?.absX, 264);
  // Left at 80, mid at 80+160+24+80 = 344-(160-80)... let's compute:
  //   childLeftEdge starts at (528 - 528)/2 = 0
  //   leftChild center = 0 + 80 = 80
  //   childLeftEdge += 160 + 24 = 184
  //   midChild center = 184 + 80 = 264
  //   childLeftEdge += 160 + 24 = 368
  //   rightChild center = 368 + 80 = 448
  assert.equal(flat[1]?.absX, 80);
  assert.equal(flat[2]?.absX, 264);
  assert.equal(flat[3]?.absX, 448);
});

// ─── SDK 5.1+ subplan layout ────────────────────────────────────

test('subtreeExecNs: includes subplan exec in the total', () => {
  const inner: QueryProfileOperator = {
    name: 'sequence',
    children: [{ name: 'indexScan', stats: { execNs: 30 }, children: [], attributes: [], subplans: [] }],
    attributes: [],
    subplans: [],
  };
  const tree: QueryProfileOperator = {
    name: 'nlJoin',
    stats: { execNs: 100 },
    children: [{ name: 'scan', stats: { execNs: 50 }, children: [], attributes: [], subplans: [] }],
    attributes: [],
    subplans: [{ key: 'inner', plan: inner }],
  };
  // 100 (nlJoin) + 50 (scan child) + 30 (indexScan in inner subplan) = 180
  assert.equal(subtreeExecNs(tree), 180);
});

test('layout/flatten: subplans contribute to subtree width', () => {
  const inner: QueryProfileOperator = {
    name: 'sequence',
    children: [{ name: 'indexScan', children: [], attributes: [], subplans: [] }],
    attributes: [],
    subplans: [],
  };
  const tree: QueryProfileOperator = {
    name: 'nlJoin',
    children: [{ name: 'scan', children: [], attributes: [], subplans: [] }],
    attributes: [],
    subplans: [{ key: 'inner', plan: inner }],
  };
  const laid = layout(tree, 0);
  const flat = flatten(laid);
  // nlJoin + scan (child) + sequence (subplan) + indexScan (subplan child) = 4
  assert.equal(flat.length, 4);
  // Width: children are scan(160) + gap + sequence(subtreeWidth=160) = 344
  assert.equal(laid.subtreeWidth, 344);
});
