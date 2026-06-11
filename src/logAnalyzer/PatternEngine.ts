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
  levelFilter?: LogLevel;
  tagFilter?: RegExp;
  /** Trimmed, non-empty user tag to attach to matching lines, or
   *  undefined when the pattern didn't supply one. */
  userTag?: string;
  source: 'bundled' | 'user';
}

const SEV_RANGE = new Set([1, 2, 3, 4, 5]);

function compileOne(raw: KeyedRawPattern, source: 'bundled' | 'user'): CompiledPattern | null {
  if (!raw.recommendation || raw.recommendation.trim() === '') return null;
  if (!SEV_RANGE.has(raw.severity)) return null;
  let regex: RegExp;
  try { regex = new RegExp(raw.pattern, 'i'); }
  catch { return null; }
  let tagFilter: RegExp | undefined;
  if (raw.tag_filter) {
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

  constructor(private readonly store: PatternStoreView) {}

  load(): void {
    this.compiled.clear();
    const { bundled, user } = this.store.listAll();
    for (const raw of bundled) {
      const c = compileOne(raw, 'bundled');
      if (c) this.compiled.set(c.key, c);
    }
    for (const raw of user) {
      const c = compileOne(raw, 'user');
      if (c) this.compiled.set(c.key, c); // user overrides bundled
    }
  }

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
