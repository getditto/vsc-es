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

/** Profile envelope key Ditto emits as the trailing item. Exported
 *  so the host's "did we get a profile back?" check uses the same
 *  literal as the parser. */
export const PROFILE_ENVELOPE_KEY = '~request_profile';

/** Forgiving parser for the `~request_profile` envelope. Returns null
 *  if the input doesn't look like a profile (no `~request_profile` key,
 *  missing required fields). Caller treats null as "PROFILE didn't
 *  fire" rather than throwing. */
export function parseProfileItem(item: Record<string, unknown>): QueryProfile | null {
  // Envelope can be either { "~request_profile": { … } } or the bare
  // profile dict if the SDK already unwrapped it.
  let envelope: Record<string, unknown> | undefined;
  const nested = item[PROFILE_ENVELOPE_KEY];
  if (isObject(nested)) {
    envelope = nested as Record<string, unknown>;
  } else if (typeof item._id === 'string' && isObject(item.plan)) {
    envelope = item;
  } else {
    return null;
  }

  const id = stringValue(envelope._id);
  const planDict = envelope.plan;
  if (!id || !isObject(planDict)) { return null; }
  const plan = parseOperator(planDict as Record<string, unknown>);
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
    times: parseTimes(isObject(envelope.times) ? (envelope.times as Record<string, unknown>) : undefined),
    plan,
    capturedAtMs: Date.now(),
  };
}

function parseOperator(dict: Record<string, unknown>): QueryProfileOperator | null {
  const name = stringValue(dict['#operator']);
  if (!name) { return null; }

  const statsRaw = dict['#stats'];
  const stats = isObject(statsRaw)
    ? parseStats(statsRaw as Record<string, unknown>)
    : undefined;

  const childrenRaw = dict.children;
  const children: QueryProfileOperator[] = [];
  if (Array.isArray(childrenRaw)) {
    for (const c of childrenRaw) {
      if (isObject(c)) {
        const parsed = parseOperator(c as Record<string, unknown>);
        if (parsed) { children.push(parsed); }
      }
    }
  }

  // Preserve attributes in sorted-key order so the same node renders
  // the same way every render (Object.entries is unordered for some
  // keys on some engines; sorting is deterministic).
  const reserved = new Set(['#operator', '#stats', 'children']);
  const attributes: Array<{ key: string; value: string }> = [];
  for (const key of Object.keys(dict).sort()) {
    if (reserved.has(key)) { continue; }
    const raw = dict[key];
    if (raw === undefined || raw === null) { continue; }
    attributes.push({ key, value: renderAttribute(raw) });
  }

  return { name, stats, children, attributes };
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
    ? (dict.phaseTimes as Record<string, unknown>)
    : undefined;
  return {
    documentsIn: intValue(dict.documentsIn),
    documentsOut: intValue(dict.documentsOut),
    execNs: intValue(phase?.exec),
    recvNs: intValue(phase?.recv),
    sendNs: intValue(phase?.send),
  };
}

function parseTimes(dict: Record<string, unknown> | undefined): QueryProfileTimes {
  if (!dict) {
    return { elapsedNs: 0, parseNs: 0, planNs: 0, startISO: '' };
  }
  return {
    elapsedNs: intValue(dict.elapsed) ?? 0,
    parseNs: intValue(dict.parse) ?? 0,
    planNs: intValue(dict.plan) ?? 0,
    startISO: stringValue(dict.start) ?? '',
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringValue(v: unknown): string | undefined {
  if (typeof v === 'string') { return v; }
  if (typeof v === 'number' || typeof v === 'bigint') { return String(v); }
  return undefined;
}

function intValue(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) { return v; }
  if (typeof v === 'bigint') { return Number(v); }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
