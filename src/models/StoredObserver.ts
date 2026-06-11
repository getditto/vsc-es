/** Persisted metadata for a Ditto store observer. The live SDK
 *  observer (the thing that actually consumes memory and pumps
 *  events) is NEVER persisted — it's created when the user clicks
 *  "Activate" inside an open ObserverPanel, and cancelled when the
 *  panel is disposed or the user clicks Stop. This matches the
 *  SwiftUI Edge Studio behaviour and keeps observers from auto-running
 *  on app open. */
export interface StoredObserver {
  /** Stable, host-generated UUID. */
  id: string;
  /** User-facing name (shown in the tree and panel title). */
  name: string;
  /** DQL SELECT statement. Ditto's `registerObserver` only accepts
   *  queries that return a result set, so non-SELECTs are rejected
   *  at save time. */
  query: string;
}
