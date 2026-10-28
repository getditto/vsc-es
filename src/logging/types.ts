// src/logging/types.ts
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Levels in order from least to most verbose. Index = priority. */
export const LOG_LEVEL_ORDER: ReadonlyArray<LogLevel> = ['error', 'warn', 'info', 'debug', 'trace'];

export interface LogContext {
  tag?: string;                       // 'ext' | 'sdk' | 'webview:dittoQueryEditor' | …
  databaseId?: string;
  [key: string]: unknown;
}

export interface Logger {
  error(message: string, ctx?: LogContext): void;
  warn(message: string, ctx?: LogContext): void;
  info(message: string, ctx?: LogContext): void;
  debug(message: string, ctx?: LogContext): void;
  trace(message: string, ctx?: LogContext): void;

  setChannelLevel(level: LogLevel): void;
  getChannelLevel(): LogLevel;
  onDidChangeChannelLevel: import('vscode').Event<LogLevel>;

  setSdkLevel(level: LogLevel): void;
  getSdkLevel(): LogLevel;
  onDidChangeSdkLevel: import('vscode').Event<LogLevel>;

  withTag(tag: string): Logger;

  /** Register exact secret VALUES (e.g. a live auth token) to redact from
   *  all output, in addition to the built-in pattern-based redaction.
   *  Values shorter than 8 chars are ignored to avoid over-redaction, and
   *  duplicates collapse. The values are held in memory only and are never
   *  themselves logged. Registration is shared across withTag children. */
  registerKnownSecrets(values: readonly string[]): void;
  /** Forget every value registered via registerKnownSecrets (e.g. after a
   *  disconnect, so a recycled token does not over-redact later sessions). */
  clearKnownSecrets(): void;

  /** Flush + read all log files chronologically. Used by the Export Logs command. */
  readAllLogs(): Promise<string>;
  /** Newest `maxLines` log lines across the rotation set, oldest-first. Use
   *  this instead of readAllLogs when only recent history matters — it reads
   *  backwards and stops early rather than materialising the whole retention
   *  window. */
  readRecentLogLines(maxLines: number): Promise<string[]>;

  /** Update the file sink's rotation limits at runtime (the
   *  `dittoVsce.logMaxMegabytes` / `dittoVsce.logRetainFiles` settings).
   *  Rotations beyond a shrunken retain count are deleted immediately. */
  setFileLimits(limits: { maxBytes: number; retain: number }): Promise<void>;
  /** Delete rotated backups older than `maxAgeMs` (the active file is never
   *  touched). Returns the number deleted. Runs at activation. */
  pruneLogFilesOlderThan(maxAgeMs: number): Promise<number>;
  /** Delete every application log file (active + rotations). The next write
   *  re-creates the active file with its session header. Backs the Clear
   *  Application Log command. */
  clearLogFiles(): Promise<void>;

  /** Flush + close. Call from extension.deactivate(). */
  dispose(): Promise<void>;
}

/** Returns true if `level` should be emitted given the current `minimum`. */
export function shouldEmit(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) <= LOG_LEVEL_ORDER.indexOf(minimum);
}
