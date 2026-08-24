/** A single observer-firing snapshot. Mirrors `DittoObserveEvent` in
 *  the SwiftUI Edge Studio: each event carries the *full* current
 *  result-set rows AND the diff vs. the previous firing (insertion /
 *  update / move / deletion indexes into the rows array). The diff
 *  is computed on the host side via the SDK's `Differ`. */
export interface ObserverEvent {
  /** Host-generated UUID, used to address a single event in the UI. */
  id: string;
  /** ISO-8601 wall-clock instant the event was captured on the host. */
  eventTimeISO: string;
  /** The materialized rows for this firing — the same shape as
   *  a query result. The detail pane renders these via the existing
   *  JSON viewer / shared result table. Capped on the host (see
   *  `OBSERVER_ROW_CAP` in DittoManager) so a huge result set isn't
   *  structured-cloned to the webview on every firing. */
  data: Record<string, unknown>[];
  /** Uncapped row count of the firing's full result set. When
   *  `totalRows > data.length`, `data` holds only the first
   *  OBSERVER_ROW_CAP rows and the UI should indicate the cap. */
  totalRows: number;
  /** Diff arrays from the SDK's `Differ`. Each entry is an index
   *  into `data` (insertions/updates) or into the previous firing's
   *  data (deletions). `moves` is a list of `{from, to}` tuples. */
  insertions: number[];
  updates: number[];
  deletions: number[];
  moves: Array<{ from: number; to: number }>;
}

/** Bounded FIFO buffer for `ObserverEvent` instances. Capacity matches
 *  the SwiftUI version (500). When the cap is exceeded, the oldest
 *  events are evicted first. Lookup-by-id is O(1) via a parallel
 *  dictionary index so the events table doesn't pay a linear scan
 *  on every re-render. */
export class ObserverEventStore {
  static readonly capacity = 500;

  private _events: ObserverEvent[] = [];
  private _byId = new Map<string, ObserverEvent>();

  get events(): readonly ObserverEvent[] { return this._events; }
  get size(): number { return this._events.length; }
  get isEmpty(): boolean { return this._events.length === 0; }

  /** O(1) lookup by event id. */
  get(id: string): ObserverEvent | undefined {
    return this._byId.get(id);
  }

  /** Append a single event and apply the FIFO eviction policy. */
  append(event: ObserverEvent): void {
    this._events.push(event);
    this._byId.set(event.id, event);
    this.applyCapacity();
  }

  /** Append a batch and apply the FIFO eviction policy once. */
  appendBatch(events: ObserverEvent[]): void {
    if (events.length === 0) { return; }
    for (const e of events) {
      this._events.push(e);
      this._byId.set(e.id, e);
    }
    this.applyCapacity();
  }

  /** Drop all events. */
  clear(): void {
    this._events = [];
    this._byId.clear();
  }

  private applyCapacity(): void {
    if (this._events.length <= ObserverEventStore.capacity) { return; }
    const overflow = this._events.length - ObserverEventStore.capacity;
    const evicted = this._events.splice(0, overflow);
    for (const e of evicted) { this._byId.delete(e.id); }
  }
}
