// src/ditto/QueryProfile.ts

/** Top-level timings from `~request_profile.times`. All values are
 *  nanoseconds at source (Ditto's `ditto-dql` engine reports
 *  `as_nanos() as u64` for elapsed/parse/plan and per-operator phase
 *  times). Use `formatNs` from src/util/profileTimeFormatter for display. */
export interface QueryProfileTimes {
  /** Total elapsed wall-clock time the request took, end to end. */
  elapsedNs: number;
  /** Time spent parsing the statement text into an AST. */
  parseNs: number;
  /** Time spent planning (operator selection, optimisation). */
  planNs: number;
  /** Server-side ISO timestamp of when the request started. Preserved
   *  as the raw string for round-trip fidelity. `undefined` when Ditto
   *  doesn't emit it (forward-compatible degrade). */
  startISO?: string | undefined;
}

/** Per-operator throughput and timing from `#stats`. Every field is
 *  optional because Ditto omits keys that don't apply to a given
 *  operator (a `scan` has no `documentsIn`; a `limit` may have no
 *  `recv` phase time). */
export interface QueryProfileStats {
  documentsIn?: number | undefined;
  documentsOut?: number | undefined;
  /** CPU time inside the operator. */
  execNs?: number | undefined;
  /** Time waiting on upstream operators to feed input. */
  recvNs?: number | undefined;
  /** Time pushing output to downstream operators. */
  sendNs?: number | undefined;
}

/** One node in the execution-plan tree. Profile JSON uses `#operator`
 *  for the type name, `#stats` for timing/throughput, an optional
 *  `children` array, and zero or more operator-specific attribute
 *  keys (`collection`, `alias`, `datasource`, `limit`, `descriptor`,
 *  …). The attribute set varies per operator type — we keep them as
 *  ordered (key, value) string pairs so the card view renders them
 *  deterministically. */
export interface QueryProfileOperator {
  /** Operator type name from `#operator` (e.g. `"scan"`, `"sequence"`). */
  name: string;
  stats?: QueryProfileStats | undefined;
  children: QueryProfileOperator[];
  attributes: Array<{ key: string; value: string }>;
}

/** Captured execution profile for a single DQL `SELECT` statement.
 *  Ditto emits this as an extra item with key `~request_profile`
 *  appended to the result set when the statement is prefixed with
 *  `PROFILE`. */
export interface QueryProfile {
  /** Profile request identifier from Ditto (`~request_profile._id`). */
  id: string;
  /** Database ID. Comes back as `app_id` on the envelope, kept under
   *  that historical name in the field for parity with the SwiftUI
   *  type, but surfaced in the UI as "db" (matches the screenshot).
   *  TODO(terminology): rename to `databaseId` to match the
   *  Ditto-Portal-terminology rename (App ID → Database ID); the
   *  parser would keep reading `app_id` off the wire either way. */
  appId: string;
  featureFlags: string;
  queryType: string;
  requestType: string;
  resultCount: number;
  state: string;
  /** The statement Ditto saw — includes the leading `PROFILE` keyword
   *  we prepended. The webview strips this when showing the user's
   *  original query in the header card. */
  text: string;
  times: QueryProfileTimes;
  plan: QueryProfileOperator;
  /** Wall-clock instant (epoch ms) we parsed the profile on the host.
   *  Used for the "captured at" timestamp in the header — `times.startISO`
   *  is the server-side instant which can differ from the local one. */
  capturedAtMs: number;
}
