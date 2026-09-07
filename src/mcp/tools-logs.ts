import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok } from './tool-result.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import { shouldEmit, type LogLevel } from '../logging/types.js';

/**
 * Log tools read the extension's own rotating log file (secrets already
 * pattern/value-redacted at write time — see src/logging/secrets.ts).
 *
 * Line format (src/logging/format.ts): `<ISO ts>  <LEVEL>  [<tag>]  msg`.
 * Ditto-origin tags: `sdk` (the DittoLogger bridge), `transport` and
 * `connection-request` (session log observers) — these are what the
 * SwiftUI server's get_ditto_logs reads out of the SDK's own .log files;
 * our bridge keeps one canonical sink instead.
 */
const LINE_RE = /^(\S+)\s+(ERROR|WARN |INFO |DEBUG|TRACE)\s+(?:\[([^\]]*)\]\s+)?/;

const LEVEL_FROM_LABEL: Record<string, LogLevel> = {
  'ERROR': 'error', 'WARN ': 'warn', 'INFO ': 'info', 'DEBUG': 'debug', 'TRACE': 'trace',
};

const DITTO_TAGS = new Set(['sdk', 'transport', 'connection-request']);

interface ParsedLine { level: LogLevel; tag: string | undefined }

function parseLine(line: string): ParsedLine | null {
  const m = LINE_RE.exec(line);
  if (!m) { return null; }
  const level = m[2] ? LEVEL_FROM_LABEL[m[2]] : undefined;
  if (!level) { return null; }
  return { level, tag: m[3] };
}

interface LogToolArgs { lines: number; filter?: string; level?: LogLevel }

function sliceAndFilter(
  all: string[],
  args: LogToolArgs,
): string[] {
  const needle = args.filter?.toLowerCase();
  const out: string[] = [];
  for (const line of all) {
    if (needle && !line.toLowerCase().includes(needle)) { continue; }
    out.push(line);
  }
  return out;
}

async function getAppLogs(ctx: McpToolContext, args: LogToolArgs): Promise<CallToolResult> {
  // Read more than requested when filtering so the result isn't tiny just
  // because most lines didn't match. Cap the read at a generous bound.
  const readCount = args.filter ? Math.max(args.lines * 10, 2000) : args.lines;
  const all = await ctx.logger.readRecentLogLines(readCount);
  const matched = sliceAndFilter(all, args).slice(-args.lines);
  return ok({ lines: matched, count: matched.length });
}

async function getDittoLogs(ctx: McpToolContext, args: LogToolArgs): Promise<CallToolResult> {
  const minLevel = args.level;
  const readCount = (args.filter || minLevel) ? Math.max(args.lines * 10, 2000) : args.lines;
  const all = await ctx.logger.readRecentLogLines(readCount);
  const out: { timestamp: string; level: LogLevel; tag: string | undefined; message: string }[] = [];
  const needle = args.filter?.toLowerCase();
  for (const line of all) {
    const parsed = parseLine(line);
    if (!parsed || !parsed.tag || !DITTO_TAGS.has(parsed.tag)) { continue; }
    if (minLevel && !shouldEmit(parsed.level, minLevel)) { continue; }
    if (needle && !line.toLowerCase().includes(needle)) { continue; }
    const m = LINE_RE.exec(line);
    out.push({
      timestamp: m?.[1] ?? '',
      level: parsed.level,
      tag: parsed.tag,
      message: line.slice(m?.[0].length ?? 0),
    });
  }
  return ok({ entries: out.slice(-args.lines), count: Math.min(out.length, args.lines) });
}

const logArgsSchema = {
  lines: z.number().int().min(1).max(2000).default(200).describe('Max lines to return (newest last).'),
  filter: z.string().optional().describe('Case-insensitive substring filter applied before slicing.'),
};

export const logTools: ToolDef[] = [
  tool({
    name: 'get_app_logs',
    description:
      'Recent lines from the Ditto Edge Studio extension log (all subsystems; secrets are ' +
      'already redacted at write time). Oldest-to-newest, capped at the requested line count.',
    schema: logArgsSchema,
    handler: (ctx, args: LogToolArgs) => getAppLogs(ctx, args),
  }),
  tool({
    name: 'get_ditto_logs',
    description:
      'Ditto SDK-originated log lines (tags sdk/transport/connection-request) with optional ' +
      'minimum severity ("error" < "warn" < "info" < "debug" < "trace") and substring filter. ' +
      'Note: the file sink defaults to info-and-above; debug/trace appear only after raising ' +
      'the application log level.',
    schema: {
      ...logArgsSchema,
      level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional()
        .describe('Minimum severity — e.g. "warn" returns warnings and errors.'),
    },
    handler: (ctx, args: LogToolArgs) => getDittoLogs(ctx, args),
  }),
];
