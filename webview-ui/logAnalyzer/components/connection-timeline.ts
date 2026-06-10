import { LitElement, html, css, svg, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Session } from '../../../src/logAnalyzer/types.js';

/** Per-transport color mapping for the timeline lanes. Keys mirror the
 *  transport labels emitted by ConnectionTracker. Anything unknown
 *  falls back to a neutral gray. */
const TRANSPORT_COLOR: Record<string, string> = {
  Websocket: '#4ea1ff',
  Bluetooth: '#5cb85c',
  Tcp: '#f0ad4e',
  Awdl: '#d63384',
  MdnsTcp: '#ffce00',
  StaticTcp: '#17a2b8',
  unknown: '#888',
};

/** SVG timeline of peer sessions grouped into per-(peer, transport)
 *  lanes. Each session is a rectangle spanning [start, end] in the
 *  global time range; an open session (end === null) extends to "now"
 *  at render time. Vertical red lines mark ditto_init events
 *  (`reinits`) so the user can spot SDK re-initialization within the
 *  same session window.
 *
 *  Note: `Session.start`/`end` are typed `Date | null` in TS but arrive
 *  here as ISO strings after JSON serialization across the IPC
 *  boundary. `new Date(...)` handles both cases. */
@customElement('connection-timeline')
export class ConnectionTimeline extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      padding: 8px;
    }
    svg { width: 100%; }
  `;

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Array }) reinits: Date[] = [];

  render(): TemplateResult {
    if (this.sessions.length === 0) {
      return html`<div class="empty">No connection events captured in this session.</div>`;
    }

    const allTs = this.sessions.flatMap((s) => [
      new Date(s.start).getTime(),
      new Date(s.end ?? new Date()).getTime(),
    ]);
    const tMin = Math.min(...allTs);
    const tMax = Math.max(...allTs);
    const range = Math.max(tMax - tMin, 1);

    // Group sessions by (peer, transport) so each peer/transport pair
    // gets its own horizontal lane. Insertion order is preserved by
    // Map iteration, which roughly maps to first-seen-first.
    const lanes = new Map<string, Session[]>();
    for (const s of this.sessions) {
      const key = `${s.remotePeer}__${s.transport}`;
      const arr = lanes.get(key) ?? [];
      arr.push(s);
      lanes.set(key, arr);
    }
    const laneList = [...lanes.entries()];
    const rowH = 100 / Math.max(laneList.length, 1);
    const height = laneList.length * 16;

    return html`
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="height:${height}px">
        ${laneList.map(
          ([, ss], idx) => svg`
          ${ss.map((s) => {
            const startMs = new Date(s.start).getTime();
            const endMs = new Date(s.end ?? new Date()).getTime();
            const x = ((startMs - tMin) / range) * 100;
            const w = ((endMs - startMs) / range) * 100;
            return svg`<rect x="${x}" y="${idx * rowH + 1}" width="${w}" height="${rowH - 2}" fill="${TRANSPORT_COLOR[s.transport] ?? '#888'}"><title>${s.remotePeer} via ${s.transport} (${s.role})</title></rect>`;
          })}
        `,
        )}
        ${this.reinits.map((d) => {
          const ms = new Date(d).getTime();
          const x = ((ms - tMin) / range) * 100;
          return svg`<line x1="${x}" y1="0" x2="${x}" y2="100" stroke="red" stroke-width="0.5"><title>ditto_init</title></line>`;
        })}
      </svg>
    `;
  }
}
