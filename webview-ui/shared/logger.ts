// Webview-side logger that bridges to the host via postMessage.
// Mirrors the host's channel level so debug/trace short-circuit cheaply
// before crossing the postMessage boundary.

import { postToHost } from './messaging.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
const ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

let mirroredLevel: LogLevel = 'info';

/** Internal — called by the per-panel main.ts when it receives `log.levelChanged`. */
export function _setMirroredLevel(level: LogLevel): void {
  mirroredLevel = level;
}

function enabled(l: LogLevel): boolean {
  return ORDER.indexOf(l) <= ORDER.indexOf(mirroredLevel);
}

function emit(level: LogLevel, message: string, ctx?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  postToHost({ type: 'log', level, message, ctx });
}

export const webviewLogger = {
  error: (m: string, ctx?: Record<string, unknown>) => emit('error', m, ctx),
  warn:  (m: string, ctx?: Record<string, unknown>) => emit('warn',  m, ctx),
  info:  (m: string, ctx?: Record<string, unknown>) => emit('info',  m, ctx),
  debug: (m: string, ctx?: Record<string, unknown>) => emit('debug', m, ctx),
  trace: (m: string, ctx?: Record<string, unknown>) => emit('trace', m, ctx),
};
