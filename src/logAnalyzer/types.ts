import type { LogLevel } from '../logging/types.js';

export interface LogLine {
  /** Monotonic id; backfill ids are negative, live ids non-negative. */
  id: number;
  timestamp: Date | null;
  level: LogLevel;
  tag: string | null;
  raw: string;
  /** Message body after the tag prefix; what patterns scan. */
  text: string;
  /** User-defined tags attached when one or more patterns with a
   *  `user_tag` matched this line. Lets the developer label lines with
   *  semantic categories on top of the SDK/extension tag (e.g. "query",
   *  "auth", "sync") for filtering. Undefined when no pattern with a
   *  user_tag matched. Sorted + deduped. */
  userTags?: string[];
}

export interface ProblemInstance {
  patternKey: string;
  severity: 1 | 2 | 3 | 4 | 5;
  recommendation: string;
  line: LogLine;
}

export interface Session {
  start: Date;
  end: Date | null;
  remotePeer: string;
  transport: string;
  role: string;
}

export interface SummaryCounts {
  critical: number;
  errors: number;
  warnings: number;
  problems: number;
  totalLines: number;
  unparseableLines: number;
}

export interface AnalyzerState {
  counts: SummaryCounts;
  problems: Map<string, ProblemInstance[]>;
  sessions: Session[];
  reinits: Date[];
  histograms: {
    volumeByLevel: { binStartMs: number; counts: Record<LogLevel, number> }[];
    problemsOverTime: { binStartMs: number; count: number; maxSeverity: 1 | 2 | 3 | 4 | 5 }[];
    connectionDurations: { binLabel: string; count: number }[];
  };
  startTime: Date | null;
  endTime: Date | null;
  sdkVersion: string | null;
  tags: Set<string>;
}
