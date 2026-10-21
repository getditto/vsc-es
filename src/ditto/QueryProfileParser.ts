import type {
  QueryProfile,
  QueryProfileOperator,
  QueryProfileStats,
  QueryProfileTimes,
} from './QueryProfile.js';

/** Returns true iff `query`'s first non-whitespace word is `SELECT`.
 *  Used to gate the PROFILE prefix — Ditto's PROFILE keyword only
 *  supports SELECT (INSERT/UPDATE/DELETE/EVICT would syntax-error).
 *  Case-insensitive. Rejects `SELECTOR` / `SELECTED` by requiring a
 *  whitespace boundary after the keyword. */
export function isSelectStatement(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) { return false; }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT')) { return false; }
  if (upper.length === 'SELECT'.length) { return true; }
  const next = upper.charAt('SELECT'.length);
  return /\s/.test(next);
}

/** Returns true iff the user has already typed `PROFILE` at the start
 *  of their statement. Prevents double-prepending — `PROFILE PROFILE
 *  SELECT …` would be a syntax error. */
export function alreadyHasProfilePrefix(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) { return false; }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('PROFILE')) { return false; }
  if (upper.length === 'PROFILE'.length) { return true; }
  const next = upper.charAt('PROFILE'.length);
  return /\s/.test(next);
}

/** Whole-word, case-insensitive `ADVISE` gate — mirrors `isSelectStatement`.
 *  Used to skip the `EXPLAIN` side-trip in `DittoManager.executeQuery`:
 *  `EXPLAIN ADVISE <SELECT…>` is not valid syntax, so the metrics capture
 *  would burn a doomed SDK call. (The PROFILE prefix gate never fires for
 *  ADVISE already — the first word isn't SELECT.) Rejects `ADVISORY` /
 *  `ADVISED` by requiring a whitespace boundary, like the SELECT gate. */
export function isAdviseStatement(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) { return false; }
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('ADVISE')) { return false; }
  if (upper.length === 'ADVISE'.length) { return true; }
  const next = upper.charAt('ADVISE'.length);
  return /\s/.test(next);
}

/** Returns true iff the statement is a SELECT *or* a PROFILE-wrapped
 *  SELECT — i.e. anything that would produce a `~request_profile`
 *  envelope in the result when profiling is enabled. Used as the
 *  envelope-strip gate in `DittoManager.executeQuery`: even when the
 *  user typed `PROFILE` themselves (so we don't re-prefix), the
 *  envelope still lands in the response and the row needs stripping.
 *
 *  `isSelectStatement` alone misses the user-typed-PROFILE case
 *  because the leading word is `PROFILE`, not `SELECT`. */
export function isProfilableSelect(query: string): boolean {
  if (isSelectStatement(query)) { return true; }
  if (!alreadyHasProfilePrefix(query)) { return false; }
  // Strip the leading PROFILE keyword (and its trailing whitespace)
  // and re-check whether what's left starts with SELECT.
  const inner = query.trim().replace(/^PROFILE\s+/i, '');
  return isSelectStatement(inner);
}

/** Profile envelope key Ditto emits as the trailing item. Exported
 *  so the host's "did we get a profile back?" check uses the same
 *  literal as the parser. */
const PROFILE_ENVELOPE_KEY = '~request_profile';

/** Forgiving parser for the `~request_profile` envelope. Returns null
 *  if the input doesn't look like a profile (no `~request_profile` key,
 *  missing required envelope markers, or missing required fields).
 *  Caller treats null as "PROFILE didn't fire" rather than throwing. */
export function parseProfileItem(item: Record<string, unknown>): QueryProfile | null {
  // Envelope can be either { "~request_profile": { … } } or the bare
  // profile dict if the SDK already unwrapped it.
  let envelope: Record<string, unknown> | undefined;
  const nested = item[PROFILE_ENVELOPE_KEY];
  if (isObject(nested)) {
    envelope = nested;
  } else if (
    typeof item._id === 'string'
    && isObject(item.plan)
    && hasEnvelopeMarker(item)
  ) {
    envelope = item;
  } else {
    return null;
  }

  const id = stringValue(envelope._id);
  const planDict = envelope.plan;
  if (!id || !isObject(planDict)) { return null; }
  const plan = parseOperator(planDict);
  if (!plan) { return null; }

  return {
    id,
    appId: stringValue(envelope.app_id) ?? '',
    featureFlags: stringValue(envelope.featureFlags) ?? '',
    queryType: stringValue(envelope.queryType) ?? '',
    requestType: stringValue(envelope.requestType) ?? '',
    resultCount: intValue(envelope.resultCount) ?? 0,
    state: stringValue(envelope.state) ?? '',
    text: stringValue(envelope.text) ?? '',
    times: parseTimes(isObject(envelope.times) ? envelope.times : undefined),
    plan,
    capturedAtMs: Date.now(),
  };
}

function parseOperator(dict: Record<string, unknown>): QueryProfileOperator | null {
  const name = stringValue(dict['#operator']);
  if (!name) { return null; }

  const statsRaw = dict['#stats'];
  const stats = isObject(statsRaw) ? parseStats(statsRaw) : undefined;

  const childrenRaw = dict.children;
  const children: QueryProfileOperator[] = [];
  if (Array.isArray(childrenRaw)) {
    for (const c of childrenRaw) {
      if (isObject(c)) {
        const parsed = parseOperator(c);
        if (parsed) { children.push(parsed); }
      }
    }
  }

  // Subplans — non-`children`, non-`#`-prefixed fields whose value is
  // itself a plan node (has `#operator`). The canonical example is
  // `nlJoin.inner` (SDK 5.1+). Stored separately from `children` so
  // renderers can label them (e.g. "inner" under a nlJoin card).
  const reserved = new Set(['#operator', '#stats', 'children']);
  const subplans: Array<{ key: string; plan: QueryProfileOperator }> = [];
  const attributes: Array<{ key: string; value: string }> = [];
  for (const key of Object.keys(dict).sort()) {
    if (reserved.has(key)) { continue; }
    const raw = dict[key];
    if (raw === undefined || raw === null) { continue; }
    if (isObject(raw) && typeof raw['#operator'] === 'string') {
      const sub = parseOperator(raw);
      if (sub) { subplans.push({ key, plan: sub }); continue; }
    }
    attributes.push({ key, value: renderAttribute(raw) });
  }

  return { name, stats, children, attributes, subplans };
}

function renderAttribute(raw: unknown): string {
  if (typeof raw === 'string') { return raw; }
  if (typeof raw === 'number' || typeof raw === 'boolean') { return String(raw); }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function parseStats(dict: Record<string, unknown>): QueryProfileStats {
  const phase = isObject(dict.phaseTimes)
    ? (dict.phaseTimes)
    : undefined;
  const yields = isObject(dict.yields) ? parseYields(dict.yields) : undefined;
  return {
    documentsIn: intValue(dict.documentsIn),
    documentsOut: intValue(dict.documentsOut),
    documentsSkipped: intValue(dict.documentsSkipped),
    execNs: intValue(phase?.exec),
    recvNs: intValue(phase?.recv),
    sendNs: intValue(phase?.send),
    storNs: intValue(phase?.stor),
    yields,
  };
}

/** Parse the `#stats.yields` object (SDK 5.1+). Drops zero/non-numeric
 *  entries so the UI doesn't render noise for counters that never fired.
 *  Returns undefined when no non-zero entries remain. */
function parseYields(dict: Record<string, unknown>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dict)) {
    const n = intValue(v);
    if (n !== undefined && n !== 0) { out[k] = n; }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseTimes(dict: Record<string, unknown> | undefined): QueryProfileTimes {
  if (!dict) {
    return { elapsedNs: 0, parseNs: 0, planNs: 0, startISO: undefined };
  }
  return {
    elapsedNs: intValue(dict.elapsed) ?? 0,
    parseNs: intValue(dict.parse) ?? 0,
    planNs: intValue(dict.plan) ?? 0,
    startISO: stringValue(dict.start),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Discriminator for bare profile dicts (where Ditto didn't wrap in
 *  `~request_profile`). A user document might coincidentally have a
 *  string `_id` and a JSON `plan` field, so we require at least one
 *  envelope-only marker to avoid false-positives. The keys checked
 *  are ones Ditto's profile envelope always emits but user collections
 *  effectively never use as field names.
 *
 *  We deliberately do NOT include `text` as a marker — `text` is a
 *  common user field name (chat messages, notes, posts) so accepting
 *  it would re-open the false-positive class we're guarding against. */
function hasEnvelopeMarker(item: Record<string, unknown>): boolean {
  return (
    isObject(item.times)
    || typeof item.queryType === 'string'
    || typeof item.requestType === 'string'
    || typeof item.featureFlags === 'string'
    || typeof item.state === 'string'
    || typeof item.resultCount === 'number'
  );
}

/** Best-effort string coercion. Strings pass through; numbers and
 *  bigints stringify losslessly via `String(v)` — bigint IDs above
 *  Number.MAX_SAFE_INTEGER preserve full precision through this path. */
function stringValue(v: unknown): string | undefined {
  if (typeof v === 'string') { return v; }
  if (typeof v === 'number' || typeof v === 'bigint') { return String(v); }
  return undefined;
}

/** Best-effort integer coercion. All numeric paths route through
 *  `number`, which is **lossy for bigints above Number.MAX_SAFE_INTEGER
 *  (2^53 − 1)**. This is acceptable for the call sites:
 *
 *  - `documentsIn` / `documentsOut`: realistic profile envelopes report
 *    document counts well below 2^53 (a single Ditto SELECT returning
 *    9 quadrillion rows is not a real workload).
 *  - Phase times in nanoseconds: 2^53 ns is ~104 days; a single query
 *    elapsed time that long is a runaway, not a precision concern.
 *
 *  IDs that genuinely need bigint precision should route through
 *  `stringValue` instead — see the `id`, `app_id` reads in
 *  `parseProfileItem`. */
function intValue(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) { return v; }
  if (typeof v === 'bigint') { return Number(v); }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
