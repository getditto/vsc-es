import type { LogLevel } from '../logging/types.js';
import type { LogLine } from './types.js';

export interface RawPattern {
  pattern: string;
  severity: number;
  recommendation: string;
  level_filter?: LogLevel;
  tag_filter?: string;
  /** Optional user-defined label attached to every line this pattern
   *  matches. Distinct from `tag_filter` (which scopes when the pattern
   *  fires by regex-matching the line's existing tag). Surfaces in the
   *  log table's User Tag column and participates in free-text search.
   *  Use to label lines with semantic categories ('query', 'auth', etc.). */
  user_tag?: string;
}

export interface KeyedRawPattern extends RawPattern {
  key: string;
}

export interface PatternStoreView {
  listAll(): { bundled: KeyedRawPattern[]; user: KeyedRawPattern[] };
}

export interface CompiledPattern {
  key: string;
  regex: RegExp;
  severity: 1 | 2 | 3 | 4 | 5;
  recommendation: string;
  levelFilter?: LogLevel | undefined;
  tagFilter?: RegExp | undefined;
  /** Trimmed, non-empty user tag to attach to matching lines, or
   *  undefined when the pattern didn't supply one. */
  userTag?: string | undefined;
  source: 'bundled' | 'user';
}

const SEV_RANGE = new Set([1, 2, 3, 4, 5]);

/** Upper bound on a user-supplied pattern's source length. Every compiled
 *  pattern is tested against every log line, so the cost of a pattern is
 *  paid tens of thousands of times per session. */
const MAX_USER_PATTERN_LENGTH = 512;

/** Nested-quantifier shapes — `(a+)+`, `(\w+\s*)+`, `(a*){2,}` — the class
 *  of pattern whose backtracking cost is exponential in the input length.
 *  `scan()` runs on the extension host's only thread against lines up to
 *  LineParser's 16 KB cap, so one of these in a user pattern file wedges the
 *  whole host, not just the analyzer. Rejected rather than sandboxed: there
 *  is no way to time-bound a RegExp on this thread, and the heuristic costs
 *  a user nothing but rewriting `(a+)+` as `a+`. Bundled patterns are ours
 *  and are covered by tests, so they skip the check. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/** Reject patterns that are unsafe to compile or run. Returns a reason for
 *  the log, or null when the pattern is acceptable. */
function rejectReason(pattern: string, source: 'bundled' | 'user'): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    // `new RegExp(undefined)` is `/(?:)/`, which matches every line — a
    // malformed entry would silently turn every log line into a problem.
    return 'pattern must be a non-empty string';
  }
  if (source === 'bundled') { return null; }
  if (pattern.length > MAX_USER_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_USER_PATTERN_LENGTH} characters`;
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return 'pattern nests a quantifier inside a quantified group, which can backtrack exponentially';
  }
  return null;
}

function compileOne(
  raw: KeyedRawPattern,
  source: 'bundled' | 'user',
  onReject?: (key: string, reason: string) => void,
): CompiledPattern | null {
  if (!raw.recommendation || raw.recommendation.trim() === '') return null;
  if (!SEV_RANGE.has(raw.severity)) return null;
  const unsafe = rejectReason(raw.pattern, source);
  if (unsafe) { onReject?.(raw.key, unsafe); return null; }
  let regex: RegExp;
  try { regex = new RegExp(raw.pattern, 'i'); }
  catch { return null; }
  let tagFilter: RegExp | undefined;
  if (raw.tag_filter) {
    const unsafeTag = rejectReason(raw.tag_filter, source);
    if (unsafeTag) { onReject?.(raw.key, `tag_filter: ${unsafeTag}`); return null; }
    try { tagFilter = new RegExp(raw.tag_filter); }
    catch { return null; }
  }
  const userTag = raw.user_tag?.trim();
  return {
    key: raw.key,
    regex,
    severity: raw.severity as 1 | 2 | 3 | 4 | 5,
    recommendation: raw.recommendation,
    levelFilter: raw.level_filter,
    tagFilter,
    userTag: userTag && userTag.length > 0 ? userTag : undefined,
    source,
  };
}

export class PatternEngine {
  private compiled = new Map<string, CompiledPattern>();
  /** Keys skipped by the last load(), with the reason. Surfaced so a user
   *  whose pattern was rejected can find out why instead of watching it
   *  silently never match. */
  private rejected: { key: string; reason: string }[] = [];

  constructor(private readonly store: PatternStoreView) {}

  load(): void {
    this.compiled.clear();
    this.rejected = [];
    const onReject = (key: string, reason: string): void => {
      this.rejected.push({ key, reason });
    };
    const { bundled, user } = this.store.listAll();
    for (const raw of bundled) {
      const c = compileOne(raw, 'bundled', onReject);
      if (c) this.compiled.set(c.key, c);
    }
    for (const raw of user) {
      const c = compileOne(raw, 'user', onReject);
      if (c) this.compiled.set(c.key, c); // user overrides bundled
    }
  }

  /** Patterns skipped by the last load(), with the reason each was skipped. */
  listRejected(): { key: string; reason: string }[] { return [...this.rejected]; }

  reload(): void { this.load(); }

  listKeys(): string[] { return [...this.compiled.keys()]; }

  scan(line: LogLine): CompiledPattern[] {
    const out: CompiledPattern[] = [];
    for (const p of this.compiled.values()) {
      // Exact level match (not "at least") so tiered patterns (e.g. deadlock at
      // ERROR vs WARN) stay mutually exclusive instead of both firing on the
      // more severe variant.
      if (p.levelFilter && line.level !== p.levelFilter) continue;
      if (p.tagFilter && !p.tagFilter.test(line.tag ?? '')) continue;
      if (p.regex.test(line.text)) out.push(p);
    }
    return out;
  }
}
