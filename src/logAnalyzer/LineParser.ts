import type { LogLevel } from '../logging/types.js';
import type { LogLine } from './types.js';

const MAX_LINE_BYTES = 16 * 1024;
const TRUNC_MARKER = '…[truncated]';
const LEVEL_TOKENS: Record<string, LogLevel> = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  TRACE: 'trace',
};

// Format (per src/logging/format.ts): `ISO_TS  LEVEL_PADDED  [tag]  message[  ctx_json]`.
// LEVEL labels are padded to 5 chars (e.g. `WARN `, `INFO `), so the visual gap
// between LEVEL and the next field is the padding space (if any) plus the 2-space
// separator. Use `\s{2,}` for the inter-field separators to absorb that padding.
const LINE_RE = /^(\S+)\s{2,}(\S+)\s{2,}(?:\[([^\]]+)\]\s{2,})?(.*)$/;

export function parseLine(raw: string, id: number): LogLine {
  let safe = raw;
  if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
    safe = raw.slice(0, MAX_LINE_BYTES) + TRUNC_MARKER;
  }
  const m = LINE_RE.exec(safe);
  if (!m) {
    return { id, timestamp: null, level: 'info', tag: null, raw: safe, text: safe };
  }
  const [, tsRaw, lvlRaw, tag] = m;
  const level = LEVEL_TOKENS[lvlRaw.trim()] ?? 'info';
  let timestamp: Date | null = null;
  const d = new Date(tsRaw);
  if (!isNaN(d.getTime())) timestamp = d;
  // `text` is a lazy, memoised, ENUMERABLE getter rather than an eagerly
  // captured substring: the AnalyzerSink retains up to 50k parsed lines for
  // the life of the extension, and most of them never have their message
  // body read at all (it is only needed while an analyzer panel is open).
  // Enumerable matters: lines cross to the webview via postMessage, whose
  // JSON serialisation only picks up own enumerable properties.
  let textMemo: string | null = null;
  return {
    id,
    timestamp,
    level,
    tag: tag ?? null,
    raw: safe,
    get text(): string {
      if (textMemo === null) {
        textMemo = LINE_RE.exec(safe)?.[4] ?? '';
      }
      return textMemo;
    },
  };
}
