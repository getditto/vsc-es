import type { QueryProfileOperator } from '../ditto/QueryProfile.js';

/** Pure layout math for the plan-tree view. Lives in `src/util/` (not
 *  `webview-ui/`) so unit tests can import it without inverting the
 *  project's "tests reach into src/, never up" layering rule. The
 *  webview's `<ditto-profile-plan-tree>` component imports from here
 *  and adds rendering on top — no logic here knows about Lit, DOM, or
 *  SVG. */

/** Hotspot threshold — share of plan-total exec above which a box is
 *  tinted orange instead of green. Matches PlanNodeBox.hotspotThreshold
 *  in the SwiftUI implementation. */
export const HOTSPOT_THRESHOLD = 0.5;

export const BOX_WIDTH = 160;
export const BOX_GAP_X = 24;     // horizontal gap between sibling boxes
export const ROW_GAP_Y = 36;     // vertical gap between parent row and child row
export const BOX_HEIGHT_EST = 90;

export interface LaidOutNode {
  node: QueryProfileOperator;
  /** Label of the incoming subplan branch, when present. */
  subplanKey: string | undefined;
  /** Width of the subtree rooted at this node (in px). */
  subtreeWidth: number;
  /** X of the center of this node's box (relative to subtree's left edge). */
  centerX: number;
  /** Y of the top of this node's box. */
  y: number;
  children: LaidOutNode[];
}

/** Sum of `execNs` across this operator and every descendant (including
 *  subplan descendants like `nlJoin.inner`). Only call on the root —
 *  non-root callers get a smaller total that breaks the percent-badge
 *  invariant (badges no longer sum to 100% across the tree). */
export function subtreeExecNs(node: QueryProfileOperator): number {
  const here = node.stats?.execNs ?? 0;
  const childSum = node.children.reduce((acc, c) => acc + subtreeExecNs(c), here);
  return node.subplans.reduce((acc, sp) => acc + subtreeExecNs(sp.plan), childSum);
}

export function layout(node: QueryProfileOperator, y: number, subplanKey?: string): LaidOutNode {
  const childY = y + BOX_HEIGHT_EST + ROW_GAP_Y;
  // Each child's centerX stays in its own subtree-local frame.
  // Subplan roots keep the label of the branch that leads to them.
  const laidOutChildren = [
    ...node.children.map(child => layout(child, childY)),
    ...node.subplans.map(subplan => layout(subplan.plan, childY, subplan.key)),
  ];
  const totalChildWidth =
    laidOutChildren.reduce((a, b) => a + b.subtreeWidth, 0)
    + Math.max(0, laidOutChildren.length - 1) * BOX_GAP_X;
  const subtreeWidth = Math.max(BOX_WIDTH, totalChildWidth);
  const centerX = subtreeWidth / 2;
  return { node, subplanKey, subtreeWidth, centerX, y, children: laidOutChildren };
}

export function flatten(n: LaidOutNode, offsetX = 0): Array<LaidOutNode & { absX: number }> {
  const here = { ...n, absX: offsetX + n.centerX };
  // For children, shift by their offset within this subtree. The
  // child's centerX is already relative to its subtree's left edge;
  // we need its subtree's left edge in absolute coords.
  const out: Array<LaidOutNode & { absX: number }> = [here];
  let childLeftEdge = offsetX + (n.subtreeWidth - flattenChildrenWidth(n)) / 2;
  for (const c of n.children) {
    out.push(...flatten(c, childLeftEdge));
    childLeftEdge += c.subtreeWidth + BOX_GAP_X;
  }
  return out;
}

export function flattenChildrenWidth(n: LaidOutNode): number {
  return n.children.reduce((a, b) => a + b.subtreeWidth, 0)
    + Math.max(0, n.children.length - 1) * BOX_GAP_X;
}
