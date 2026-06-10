import type { LogLine, Session } from './types.js';

const RE_REMOTE    = /remote=([^\s]+)/i;
const RE_TRANSPORT = /transport=([^\s]+)/i;
const RE_ROLE      = /role=([^\s]+)/i;

const RE_START   = /physical connection.*started/i;
const RE_END     = /physical connection.*ended/i;
const RE_REINIT  = /ditto_init/;

interface OpenSession extends Session {
  matchKey: string;
}

export class ConnectionTracker {
  private open: OpenSession[] = [];
  private closed: Session[] = [];
  private reinitTs: Date[] = [];
  private unmatched = 0;

  consume(line: LogLine): void {
    const text = line.text;
    const ts = line.timestamp;
    if (!ts) return;

    if (RE_REINIT.test(text)) {
      this.reinitTs.push(ts);
      for (const s of this.open) s.end = ts;
      this.closed.push(...this.open);
      this.open = [];
      return;
    }

    const remote = RE_REMOTE.exec(text)?.[1] ?? 'unknown';
    const transport = RE_TRANSPORT.exec(text)?.[1] ?? 'unknown';
    const role = RE_ROLE.exec(text)?.[1] ?? 'unknown';

    if (RE_START.test(text)) {
      this.open.push({
        matchKey: `${remote}::${role}`,
        start: ts, end: null,
        remotePeer: remote, transport, role,
      });
      return;
    }

    if (RE_END.test(text)) {
      const key = `${remote}::${role}`;
      const idx = this.open.findIndex(s => s.matchKey === key);
      if (idx === -1) { this.unmatched++; return; }
      const s = this.open[idx];
      s.end = ts;
      this.closed.push(s);
      this.open.splice(idx, 1);
    }
  }

  snapshot(): Session[] { return [...this.closed, ...this.open]; }
  reinits(): Date[] { return this.reinitTs.slice(); }
  unmatchedEnds(): number { return this.unmatched; }
}
