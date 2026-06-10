// src/logging/ChannelSink.ts
import * as vscode from 'vscode';
import type { LogLevel } from './types.js';
import type { Sink } from './Sink.js';

/**
 * Adapter over LogOutputChannel.
 * The channel itself handles its own level filtering via VS Code's
 * built-in `Developer: Set Log Level…` integration. We additionally
 * filter at the Logger layer based on the channel's reported level.
 */
export class ChannelSink implements Sink {
  constructor(private readonly channel: vscode.LogOutputChannel) {}

  write(level: LogLevel, formatted: string): void {
    switch (level) {
      case 'error': this.channel.error(formatted); break;
      case 'warn':  this.channel.warn(formatted);  break;
      case 'info':  this.channel.info(formatted);  break;
      case 'debug': this.channel.debug(formatted); break;
      case 'trace': this.channel.trace(formatted); break;
    }
  }

  /** VS Code-reported channel level, controlled by the user. */
  getLogLevel(): vscode.LogLevel { return this.channel.logLevel; }

  /** Fires when the user changes the channel's log level via VS Code's command. */
  onDidChangeLogLevel(listener: (level: vscode.LogLevel) => void): vscode.Disposable {
    return this.channel.onDidChangeLogLevel(listener);
  }

  show(): void { this.channel.show(); }
  dispose(): void { this.channel.dispose(); }
}
