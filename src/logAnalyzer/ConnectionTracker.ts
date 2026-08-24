import type { LogLine, Session } from './types.js';

const RE_REMOTE    = /remote=([^\s]+)/i;
// SDK emits `transport_type=Websocket` (not `transport=…`); see grep of
// ditto-edge-studio.log. Matching the wrong key silently defaulted every
// session to transport="unknown".
const RE_TRANSPORT = /transport_type=([^\s]+)/i;
const RE_ROLE      = /role=([^\s]+)/i;

const RE_START   = /physical connection.*started/i;
const RE_END     = /physical connection.*ended/i;
const RE_REINIT  = /ditto_init/;

interface OpenSession extends Session {
  matchKey: string;
}

/** Bounds on the session/reinit history — a flapping mesh would otherwise
 *  grow these arrays for the life of the panel. Trimmed in chunks so the
 *  per-line cost stays amortized O(1). */
const SESSION_HISTORY_CAP = 1_000;

export class ConnectionTracker {
  private open: OpenSession[] = [];
  private closed: Session[] = [];
  private reinitTs: Date[] = [];
  private unmatched = 0;
  /** Bumped on every mutation so consumers can snapshot only when something
   *  actually changed instead of copying the session arrays per log line. */
  private version = 0;

  consume(line: LogLine): void {
    const text = line.text;
    const ts = line.timestamp;
    if (!ts) return;

    if (RE_REINIT.test(text)) {
      this.reinitTs.push(ts);
      if (this.reinitTs.length > SESSION_HISTORY_CAP * 2) {
        this.reinitTs.splice(0, this.reinitTs.length - SESSION_HISTORY_CAP);
      }
      for (const s of this.open) s.end = ts;
      this.closed.push(...this.open);
      this.open = [];
      this.trimClosed();
      this.version++;
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
      // `closed` was bounded but `open` was not. A start line whose matching
      // "ended" never arrives — a killed process, a truncated log, a phrasing
      // the END regex misses — leaves an entry here forever, so a long session
      // grew this without limit. Unbounded memory, and every consumer that
      // copies the array paid for it.
      if (this.open.length > SESSION_HISTORY_CAP * 2) {
        this.open.splice(0, this.open.length - SESSION_HISTORY_CAP);
      }
      this.version++;
      return;
    }

    if (RE_END.test(text)) {
      const key = `${remote}::${role}`;
      const idx = this.open.findIndex(s => s.matchKey === key);
      if (idx === -1) { this.unmatched++; return; }
      const s = this.open[idx];
      if (!s) { this.unmatched++; return; }
      s.end = ts;
      this.closed.push(s);
      this.open.splice(idx, 1);
      this.trimClosed();
      this.version++;
    }
  }

  private trimClosed(): void {
    if (this.closed.length > SESSION_HISTORY_CAP * 2) {
      this.closed.splice(0, this.closed.length - SESSION_HISTORY_CAP);
    }
  }

  /** Drop all session history. Called when the analyzer's state is cleared
   *  so "Clear" actually clears — without this the next connection event
   *  resurrects every pre-Clear session, because snapshot() is rebuilt from
   *  these arrays rather than from what the consumer already displayed. */
  reset(): void {
    this.open = [];
    this.closed = [];
    this.reinitTs = [];
    this.unmatched = 0;
    this.version++;
  }

  snapshot(): Session[] { return [...this.closed, ...this.open]; }
  reinits(): Date[] { return this.reinitTs.slice(); }
  unmatchedEnds(): number { return this.unmatched; }
  /** Monotonic mutation counter — snapshot()/reinits() results are
   *  unchanged unless this has advanced. */
  getVersion(): number { return this.version; }
}
