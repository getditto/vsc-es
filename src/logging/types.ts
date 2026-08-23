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

  /** Flush + read all log files chronologically. Used by the Export Logs command. */
  readAllLogs(): Promise<string>;
  /** Newest `maxLines` log lines across the rotation set, oldest-first. Use
   *  this instead of readAllLogs when only recent history matters — it reads
   *  backwards and stops early rather than materialising the whole retention
   *  window. */
  readRecentLogLines(maxLines: number): Promise<string[]>;

  /** Flush + close. Call from extension.deactivate(). */
  dispose(): Promise<void>;
}

/** Returns true if `level` should be emitted given the current `minimum`. */
export function shouldEmit(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) <= LOG_LEVEL_ORDER.indexOf(minimum);
}
