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

  /** Flush + close. Call from extension.deactivate(). */
  dispose(): Promise<void>;
}

/** Returns true if `level` should be emitted given the current `minimum`. */
export function shouldEmit(level: LogLevel, minimum: LogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) <= LOG_LEVEL_ORDER.indexOf(minimum);
}
