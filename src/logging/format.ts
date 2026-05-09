import type { LogLevel, LogContext } from './types.js';

const LEVEL_LABEL: Record<LogLevel, string> = {
  error: 'ERROR',
  warn:  'WARN ',
  info:  'INFO ',
  debug: 'DEBUG',
  trace: 'TRACE',
};

export interface FormatInput {
  timestamp: Date;
  level: LogLevel;
  tag: string | undefined;
  message: string;
  ctx: LogContext | undefined;
}

export function formatLogLine(input: FormatInput): string {
  const ts = input.timestamp.toISOString();
  const lvl = LEVEL_LABEL[input.level];
  const tagPart = input.tag ? `[${input.tag}]  ` : '';
  let line = `${ts}  ${lvl}  ${tagPart}${input.message}`;
  if (input.ctx && Object.keys(input.ctx).length > 0) {
    line += `  ${JSON.stringify(input.ctx)}`;
  }
  return line;
}
