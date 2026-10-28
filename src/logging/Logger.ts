import * as vscode from 'vscode';
import { ChannelSink } from './ChannelSink.js';
import { FileSink } from './FileSink.js';
import { formatLogLine } from './format.js';
import { containsKnownSecret, containsSecret, redactKnownSecrets, redactSecrets } from './secrets.js';
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
  fileMaxBytes?: number;               // rotation threshold — default FileSink's 5 MB
  fileRetain?: number;                 // rotated backups kept — default FileSink's 5
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
    ...(opts.fileMaxBytes !== undefined ? { maxBytes: opts.fileMaxBytes } : {}),
    ...(opts.fileRetain !== undefined ? { retain: opts.fileRetain } : {}),
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

  // Exact secret VALUES registered by callers (e.g. a connection's live
  // token on connect, cleared on disconnect). Held longest-first so a value
  // that is a prefix of another cannot partially redact it. Shared across
  // withTag children — they all write through the same emit below.
  let knownSecretsSorted: string[] = [];
  const registerKnownSecrets = (values: readonly string[]): void => {
    const next = new Set(knownSecretsSorted);
    for (const v of values) {
      // Short strings are too common as ordinary words — redacting 'to'
      // everywhere would destroy the logs. Dedupe via the Set.
      if (typeof v === 'string' && v.length >= 8) next.add(v);
    }
    knownSecretsSorted = [...next].sort((a, b) => b.length - a.length);
  };
  const clearKnownSecrets = (): void => { knownSecretsSorted = []; };

  // Listen for VS Code-driven channel level changes.
  channelSink.onDidChangeLogLevel((vscLevel) => {
    const next = mapVscodeLevel(vscLevel);
    if (next !== channelLevel) {
      channelLevel = next;
      channelLevelEmitter.fire(channelLevel);
    }
  });

  function emit(level: LogLevel, message: string, ctx: LogContext | undefined, tag: string | undefined) {
    // Level gate FIRST: formatting (JSON.stringify of ctx, timestamping) and
    // the secret scan are the expensive parts of a log call, and none of
    // them may run when no sink will receive the line.
    const toChannel = shouldEmit(level, channelLevel);
    const effectiveFile: LogLevel =
      LOG_LEVEL_ORDER.indexOf(channelLevel) > LOG_LEVEL_ORDER.indexOf(fileMin) ? channelLevel : fileMin;
    const toFile = shouldEmit(level, effectiveFile);
    if (!toChannel && !toFile && extra.length === 0) return;

    // Format once. The previous implementation formatted a probe line for
    // the secret scan, then formatted the redacted copy a second time.
    let line = formatLogLine({ timestamp: new Date(), level, tag, message, ctx });
    const hasPatternSecret = containsSecret(line);
    const hasKnownSecret = knownSecretsSorted.length > 0 && containsKnownSecret(line, knownSecretsSorted);
    if (hasPatternSecret || hasKnownSecret) {
      // Development tripwire: fail loudly so the call site gets fixed rather
      // than relying on redaction. Redaction below is the production path —
      // and still runs in development for anything the tripwire is disabled
      // for, so the two are not either/or.
      if (mode === 'development') {
        throw new Error('Logger: secret pattern detected in formatted message — fix the call site.');
      }
      // Scrub the whole formatted line: a `"token":"…"`, `?token=…`, or
      // registered secret value in either the message or the ctx would
      // otherwise reach the sinks (and log exports) untouched.
      if (hasPatternSecret) line = redactSecrets(line);
      if (hasKnownSecret) line = redactKnownSecrets(line, knownSecretsSorted);
    }

    if (toChannel) {
      channelSinkAdapter.write(level, line);
    }
    if (toFile) {
      fileSinkAdapter.write(level, line);
    }
    for (const sink of extra) {
      try { sink.write(level, line); }
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
      registerKnownSecrets,
      clearKnownSecrets,
      flush: () => fileSink.flush(),
      readAllLogs: async () => {
        await fileSink.flush();
        return fileSink.readAllChronological();
      },
      readRecentLogLines: async (maxLines: number) => {
        await fileSink.flush();
        return fileSink.readTailLines(maxLines);
      },
      setFileLimits: (limits) => fileSink.setLimits(limits),
      pruneLogFilesOlderThan: (maxAgeMs) => fileSink.pruneRotationsOlderThan(maxAgeMs),
      clearLogFiles: () => fileSink.clear(),
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
