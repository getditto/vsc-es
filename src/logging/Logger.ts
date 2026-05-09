import * as vscode from 'vscode';
import { ChannelSink } from './ChannelSink.js';
import { FileSink } from './FileSink.js';
import { formatLogLine } from './format.js';
import { containsSecret, SECRET_KEYS } from './secrets.js';
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
      if (mode === 'development' || (vscode.env as any)?.appName === undefined) {
        if (mode === 'development') {
          throw new Error('Logger: secret pattern detected in formatted message — fix the call site.');
        }
      }
      if (ctx) {
        const cleaned: LogContext = { ...ctx };
        for (const k of SECRET_KEYS) {
          if (k in cleaned) cleaned[k] = '[redacted]';
        }
        ctxToUse = cleaned;
      }
      messageToUse = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    }
    const finalLine = formatLogLine({ timestamp: new Date(), level, tag, message: messageToUse, ctx: ctxToUse });

    if (shouldEmit(level, channelLevel)) {
      channelSink.write(level, finalLine);
    }
    const effectiveFile: LogLevel =
      LOG_LEVEL_ORDER.indexOf(channelLevel) > LOG_LEVEL_ORDER.indexOf(fileMin) ? channelLevel : fileMin;
    if (shouldEmit(level, effectiveFile)) {
      void fileSink.write(finalLine + '\n');
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
