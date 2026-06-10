import type { LogLevel } from './types.js';

/** Minimal sink contract: receives a formatted line at a level. */
export interface Sink {
  write(level: LogLevel, formatted: string): void;
}
