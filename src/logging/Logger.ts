import * as vscode from 'vscode';
import { ChannelSink } from './ChannelSink.js';
import { FileSink } from './FileSink.js';
import { formatLogLine } from './format.js';
import { containsSecret, redactSecrets, SECRET_KEYS } from './secrets.js';
import type { Sink } from './Sink.js';
import type { Logger, LogLevel, LogContext } from './types.js';
import { LOG_LEVEL_ORDER, shouldEmit } from './types.js';

const VSCODE_TO_LOGLEVEL: Record<number, LogLevel> = {
  0: 'error',   // Off — but we treat as error for safety; channel handles its own filter
  1: 'trace',
  2: 'debug',
  3: 'info',
  4: 'warn',
  5: 'error',
};

export interface CreateLoggerOptions {
  channel: vscode.LogOutputChannel;
  fileDir: string;
  fileMin?: LogLevel;                  // default 'info'
  mode?: 'development' | 'production'; // default 'production' — guard behavior
  sessionId?: string;
  extraSinks?: Sink[];
}

interface InternalLogger extends Logger {
  flush(): Promise<void>;
}

export function createLogger(opts: CreateLoggerOptions): InternalLogger {
  const channelSink = new ChannelSink(opts.channel);
  const fileSink = new FileSink(opts.fileDir, {
    headerLines: [
      `# Ditto Edge Studio log`,
      `# session ${opts.sessionId ?? 'unknown'}`,
      `# started ${new Date().toISOString()}`,
    ],
  });
  const fileMin: LogLevel = opts.fileMin ?? 'info';
  const mode = opts.mode ?? 'production';

  // Adapters keep the existing fire-and-forget file write and level-routed
  // channel write while exposing them as the common Sink shape, so any extra
  // sinks supplied by callers fan out from the same code path below.
  const fileSinkAdapter: Sink = {
    write: (_level, line) => { void fileSink.write(line + '\n'); },
  };
  const channelSinkAdapter: Sink = {
    write: (level, line) => channelSink.write(level, line),
  };
  const extra = opts.extraSinks ?? [];

  const channelLevelEmitter = new vscode.EventEmitter<LogLevel>();
  const sdkLevelEmitter = new vscode.EventEmitter<LogLevel>();

  let channelLevel: LogLevel = mapVscodeLevel(channelSink.getLogLevel());
  let sdkLevel: LogLevel = 'info';

  // Listen for VS Code-driven channel level changes.
  channelSink.onDidChangeLogLevel((vscLevel) => {
    const next = mapVscodeLevel(vscLevel);
    if (next !== channelLevel) {
      channelLevel = next;
      channelLevelEmitter.fire(channelLevel);
    }
  });

  function emit(level: LogLevel, message: string, ctx: LogContext | undefined, tag: string | undefined) {
    let ctxToUse = ctx;
    let messageToUse = message;
    const formatted = formatLogLine({ timestamp: new Date(), level, tag, message, ctx });
    if (containsSecret(formatted)) {
      // Development tripwire: fail loudly so the call site gets fixed rather
      // than relying on redaction. Redaction below is the production path —
      // and still runs in development for anything the tripwire is disabled
      // for, so the two are not either/or.
      if (mode === 'development') {
        throw new Error('Logger: secret pattern detected in formatted message — fix the call site.');
      }
      if (ctx) {
        const cleaned: LogContext = { ...ctx };
        for (const k of SECRET_KEYS) {
          if (k in cleaned) cleaned[k] = '[redacted]';
        }
        ctxToUse = cleaned;
      }
      // Scrub the message string itself, not just the ctx object — a
      // `"token":"…"` or `?token=…` substring in the message would
      // otherwise reach the sinks (and log exports) untouched.
      messageToUse = redactSecrets(message);
    }
    const finalLine = formatLogLine({ timestamp: new Date(), level, tag, message: messageToUse, ctx: ctxToUse });

    if (shouldEmit(level, channelLevel)) {
      channelSinkAdapter.write(level, finalLine);
    }
    const effectiveFile: LogLevel =
      LOG_LEVEL_ORDER.indexOf(channelLevel) > LOG_LEVEL_ORDER.indexOf(fileMin) ? channelLevel : fileMin;
    if (shouldEmit(level, effectiveFile)) {
      fileSinkAdapter.write(level, finalLine);
    }
    for (const sink of extra) {
      try { sink.write(level, finalLine); }
      catch (err) {
        // Extra sinks must never break logging. Report the failure on the
        // channel as 'error', and swallow any failure from that too.
        try { channelSink.write('error', `[Logger] extraSink threw: ${String(err)}`); } catch { /* swallow */ }
      }
    }
  }

  function makeLogger(tag: string | undefined): InternalLogger {
    return {
      error: (m, ctx) => emit('error', m, ctx, tag),
      warn:  (m, ctx) => emit('warn',  m, ctx, tag),
      info:  (m, ctx) => emit('info',  m, ctx, tag),
      debug: (m, ctx) => emit('debug', m, ctx, tag),
      trace: (m, ctx) => emit('trace', m, ctx, tag),
      setChannelLevel: (l) => { channelLevel = l; channelLevelEmitter.fire(l); },
      getChannelLevel: () => channelLevel,
      onDidChangeChannelLevel: channelLevelEmitter.event,
      setSdkLevel: (l) => { sdkLevel = l; sdkLevelEmitter.fire(l); },
      getSdkLevel: () => sdkLevel,
      onDidChangeSdkLevel: sdkLevelEmitter.event,
      withTag: (childTag) => makeLogger(tag ? `${tag}:${childTag}` : childTag),
      flush: () => fileSink.flush(),
      readAllLogs: async () => {
        await fileSink.flush();
        return fileSink.readAllChronological();
      },
      readRecentLogLines: async (maxLines: number) => {
        await fileSink.flush();
        return fileSink.readTailLines(maxLines);
      },
      dispose: async () => {
        await fileSink.dispose();
        channelSink.dispose();
        channelLevelEmitter.dispose();
        sdkLevelEmitter.dispose();
      },
    };
  }

  return makeLogger(undefined);
}

function mapVscodeLevel(v: vscode.LogLevel): LogLevel {
  return VSCODE_TO_LOGLEVEL[v] ?? 'info';
}
