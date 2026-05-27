import { LitElement, html, css, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { QueryProfileOperator } from '../../src/ditto/QueryProfile.js';
import { formatNs, percentOfTotal } from '../../src/util/profileTimeFormatter.js';
import {
  HOTSPOT_THRESHOLD,
  BOX_WIDTH,
  BOX_GAP_X,
  ROW_GAP_Y,
  BOX_HEIGHT_EST,
  type LaidOutNode,
  subtreeExecNs,
  layout,
  flatten,
  flattenChildrenWidth,
} from '../../src/util/profilePlanLayout.js';

@customElement('ditto-profile-plan-tree')
export class DittoProfilePlanTree extends LitElement {
  @property({ attribute: false }) root!: QueryProfileOperator;

  static styles = css`
    :host {
      display: block;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 16px;
      overflow: auto;
      min-height: 320px;
      box-sizing: border-box;
    }
    .canvas { position: relative; }
    .box {
      position: absolute;
      width: ${BOX_WIDTH}px;
      box-sizing: border-box;
      padding: 8px 10px;
      border-radius: 10px;
      text-align: center;
      font-family: var(--vscode-editor-font-family);
      box-shadow: 0 1px 2px rgba(0,0,0,0.18);
    }
    .box.normal {
      background: rgba(46,160,67,0.16);
      border: 1px solid rgba(46,160,67,0.45);
    }
    /* Hotspot keeps the orange color cue AND adds a non-color cue
     * (dashed, thicker border) so the distinction survives red-green
     * color blindness (deuteranopia / protanopia — ~5-8% of men) where
     * orange and green can collapse to similar yellow-brown hues. */
    .box.hotspot {
      background: rgba(245,124,0,0.22);
      border: 2px dashed rgba(245,124,0,0.75);
    }
    .box .name { font-size: 12px; font-weight: 600; }
    .box .key  { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .box .time { font-size: 11px; font-variant-numeric: tabular-nums; }
    .box .io   { font-size: 10px; color: var(--vscode-descriptionForeground); }
    svg.connectors { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
    /* Tree-indent-guides is VS Code's purpose-built stroke for connector
     * lines (used by the File Explorer tree). It's theme-aware and far
     * more legible in dark mode than --vscode-panel-border (which is
     * sized for thin pane dividers, not content lines). Foreground
     * fallback covers themes that don't define the guides variable. */
    line {
      stroke: var(--vscode-tree-indentGuidesStroke, var(--vscode-foreground));
      stroke-width: 1.5;
      stroke-opacity: 0.65;
    }
  `;

  render() {
    const totalExec = subtreeExecNs(this.root);
    const laid = layout(this.root, 0);
    const flat = flatten(laid);
    const width = laid.subtreeWidth;
    // Height = deepest y + a single box height.
    const height = Math.max(...flat.map(f => f.y)) + BOX_HEIGHT_EST;

    return html`
      <div class="canvas" style=${`width:${width}px; height:${height}px;`}>
        <svg class="connectors" viewBox=${`0 0 ${width} ${height}`}>
          ${this.renderConnectors(laid, 0)}
        </svg>
        ${flat.map(f => this.renderBox(f, totalExec))}
      </div>
    `;
  }

  private renderConnectors(n: LaidOutNode, offsetX: number): SVGTemplateResult[] {
    if (n.children.length === 0) { return []; }
    const parentX = offsetX + n.centerX;
    const parentBottomY = n.y + BOX_HEIGHT_EST;
    const railY = parentBottomY + ROW_GAP_Y / 2;
    let childLeftEdge = offsetX + (n.subtreeWidth - flattenChildrenWidth(n)) / 2;
    const lines: SVGTemplateResult[] = [];
    const childCenters: number[] = [];
    for (const c of n.children) {
      const cx = childLeftEdge + c.centerX;
      childCenters.push(cx);
      // Stem from rail down into child box top.
      lines.push(svg`<line x1=${cx} y1=${railY} x2=${cx} y2=${c.y} />`);
      // Recurse into the child's own subtree — flatten the result into
      // `lines` so we keep a single-level SVGTemplateResult[] type that
      // Lit can interpolate cleanly.
      lines.push(...this.renderConnectors(c, childLeftEdge));
      childLeftEdge += c.subtreeWidth + BOX_GAP_X;
    }
    // Vertical drop from parent to rail.
    lines.push(svg`<line x1=${parentX} y1=${parentBottomY} x2=${parentX} y2=${railY} />`);
    // Horizontal rail spanning min..max child center.
    if (childCenters.length > 1) {
      const railL = Math.min(...childCenters);
      const railR = Math.max(...childCenters);
      lines.push(svg`<line x1=${railL} y1=${railY} x2=${railR} y2=${railY} />`);
    }
    return lines;
  }

  private renderBox(f: LaidOutNode & { absX: number }, totalExec: number): TemplateResult {
    const node = f.node;
    const execNs = node.stats?.execNs;
    const share = execNs !== undefined && totalExec > 0 ? execNs / totalExec : 0;
    const hotspot = share >= HOTSPOT_THRESHOLD;
    const keyAttr = pickKeyAttribute(node);
    const timeLabel: string | undefined = execNs === undefined
      ? undefined
      : (() => {
          const pct = percentOfTotal(execNs, totalExec, 0);
          return pct ? `${formatNs(execNs)}  (${pct})` : formatNs(execNs);
        })();
    const ioLabel = formatIo(node.stats);
    return html`
      <div
        class=${`box ${hotspot ? 'hotspot' : 'normal'}`}
        style=${`left:${f.absX - BOX_WIDTH / 2}px; top:${f.y}px;`}
      >
        <div class="name">${node.name}</div>
        ${keyAttr ? html`<div class="key" title=${keyAttr}>${keyAttr}</div>` : null}
        ${timeLabel ? html`<div class="time">${timeLabel}</div>` : null}
        ${ioLabel ? html`<div class="io">${ioLabel}</div>` : null}
      </div>
    `;
  }
}

function pickKeyAttribute(node: QueryProfileOperator): string | undefined {
  const preferred = ['collection', 'alias', 'limit', 'field', 'table'];
  for (const key of preferred) {
    const found = node.attributes.find(a => a.key === key);
    if (found) { return found.value; }
  }
  return undefined;
}

function formatIo(stats: QueryProfileOperator['stats']): string | undefined {
  if (!stats) { return undefined; }
  const inV = stats.documentsIn;
  const outV = stats.documentsOut;
  if (inV !== undefined && outV !== undefined) { return `${inV.toLocaleString()} in / ${outV.toLocaleString()} out`; }
  if (inV !== undefined) { return `${inV.toLocaleString()} in`; }
  if (outV !== undefined) { return `${outV.toLocaleString()} out`; }
  return undefined;
}
