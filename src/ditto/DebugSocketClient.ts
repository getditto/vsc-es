// Client for the Ditto SDK 5.1 `debug_socket` subsystem
// (crates/ditto-peer/src/subsystems/debug_socket.rs).
//
// A running app's SDK, once `ALTER SYSTEM SET debug_socket = '/path/to.sock'`
// is applied to it, listens on a Unix domain socket. This extension is the
// CLIENT: it connects to that socket and issues DQL over a newline-delimited
// text protocol:
//
//   - one DQL statement per line, client → server;
//   - exactly one reply line per statement, in order: either a single-line
//     JSON ARRAY of result items (empty result = `[]`), or a line starting
//     with `ERROR: <message>`;
//   - blank lines are ignored; one connection stays open for many queries.
//
// Because replies arrive strictly in request order, a FIFO of pending
// statements lines each reply up with its request — no IDs on the wire.
//
// Full DQL (mutations, ALTER SYSTEM) is enabled over the socket by default in
// 5.1 (`dql_enable_remote_full_syntax` defaults true) and the socket bypasses
// the service-layer 10 MiB remote-query cap, so the defensive limits below
// are the only thing between a runaway reply and the shared extension host.
//
// Pure Node service on purpose (no `vscode` import) so node:test can drive
// it against a real in-process `net.createServer`.

import * as net from 'node:net';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type DebugSocketState = 'disconnected' | 'connecting' | 'connected';

/** The outcome of one statement. `query()` never rejects — every failure
 *  mode (socket errors, timeouts, malformed replies) arrives here so the
 *  panel has a single error path to render. */
export type DebugSocketQueryResult =
  | { ok: true; items: unknown[] }
  | { ok: false; error: string };

export interface DebugSocketClientOptions {
  /** Per-request timeout. The server answers statements in order, so when
   *  one times out the FIFO can no longer be realigned: the client fails the
   *  timed-out request, closes the connection, and fails the rest of the
   *  queue rather than risk delivering the wrong reply to the wrong request.
   *  Default 30s. */
  requestTimeoutMs?: number;
  /** Maximum bytes accepted for a single response line before the connection
   *  is torn down. There is no server-side cap, so this is the extension
   *  host's only guard against a multi-hundred-MB result line. Default 64 MiB. */
  maxLineBytes?: number;
  /** Maximum statements awaiting a reply. The console UI runs one statement
   *  at a time, so 10 is generous; it exists to keep an unhandle-queued
   *  flood (e.g. a key repeat) from pinning memory. Default 10. */
  maxInFlight?: number;
  /** State-change sink (connection established / dropped). Fired only on
   *  transitions. */
  onStateChange?: (state: DebugSocketState, detail?: { error?: string }) => void;
}

/** Narrow structural logger: the extension `Logger` satisfies this, and
 *  tests satisfy it with three no-ops. */
export interface DebugSocketLogger {
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
}

interface PendingRequest {
  resolve: (r: DebugSocketQueryResult) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 10;

export class DebugSocketClient {
  private socket: net.Socket | undefined;
  private decoder: StringDecoder | undefined;
  /** Decoded-but-not-yet-newline-terminated text. */
  private text = '';
  /** Bytes received since the last complete line was consumed — the basis
   *  for the maxLineBytes check (counts raw bytes, not decoded chars). */
  private bufferedBytes = 0;
  private pending: PendingRequest[] = [];
  private socketPath = '';
  private currentState: DebugSocketState = 'disconnected';

  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxInFlight: number;
  private readonly onStateChange: DebugSocketClientOptions['onStateChange'];

  constructor(
    private readonly logger: DebugSocketLogger,
    options: DebugSocketClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.onStateChange = options.onStateChange;
  }

  get state(): DebugSocketState { return this.currentState; }

  /**
   * Connect to the socket at `socketPath` (must be absolute). Rejects with
   * the underlying socket error when the connection cannot be established.
   * Calling connect() while already connected/connecting tears the existing
   * connection down first — that IS the reconnect path.
   */
  connect(socketPath: string): Promise<void> {
    if (this.currentState !== 'disconnected') {
      this.disconnect();
    }
    if (!path.isAbsolute(socketPath)) {
      return Promise.reject(new Error(`Debug socket path must be absolute: ${socketPath}`));
    }
    this.socketPath = socketPath;
    this.setState('connecting');

    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      this.socket = socket;
      this.decoder = new StringDecoder('utf8');
      this.text = '';
      this.bufferedBytes = 0;

      let settled = false;
      const settleConnect = (err?: Error): void => {
        if (settled) { return; }
        settled = true;
        if (err) {
          // Never connected: 'close' will follow and run the normal teardown.
          reject(err);
        } else {
          this.setState('connected');
          resolve();
        }
      };

      socket.on('connect', () => {
        this.logger.info('Debug socket connected', { path: this.socketPath });
        settleConnect();
      });
      socket.on('data', (chunk: Buffer) => {
        if (this.socket !== socket) { return; } // stale teardown after a reconnect
        this.onData(chunk);
      });
      socket.on('error', (err: Error) => {
        if (this.socket !== socket) { return; }
        this.logger.error('Debug socket error', { path: this.socketPath, err: err.message });
        settleConnect(err);
        this.failAll(`Debug socket error: ${err.message}`);
        // 'close' fires after 'error'; the close handler ends the state.
      });
      socket.on('close', () => {
        // A stale socket finishing its teardown after a reconnect must not
        // touch the replacement connection's decoder, pending queue, or state.
        if (this.socket !== socket) { return; }
        // Swallow any decoded-but-unterminated tail; a reply without its
        // newline is indistinguishable from a truncated one, and the pending
        // queue is about to fail anyway.
        this.decoder = undefined;
        this.socket = undefined;
        this.failAll('Debug socket closed before a reply arrived');
        if (this.currentState !== 'disconnected') {
          this.setState('disconnected');
          this.logger.info('Debug socket disconnected', { path: socketPath });
        }
      });
    });
  }

  /** Send one DQL statement and await its single-line reply. Never rejects. */
  query(statement: string): Promise<DebugSocketQueryResult> {
    if (this.currentState !== 'connected' || !this.socket) {
      return Promise.resolve({ ok: false, error: 'Not connected to a debug socket.' });
    }
    if (statement.includes('\n') || statement.includes('\r')) {
      // The protocol is one statement per line; embedding a newline would
      // silently split one request into two and desync the reply FIFO.
      return Promise.resolve({
        ok: false,
        error: 'Newlines are not allowed — run one statement at a time.',
      });
    }
    const line = statement.trim();
    if (line.length === 0) {
      return Promise.resolve({ ok: false, error: 'Empty statement.' });
    }
    if (this.pending.length >= this.maxInFlight) {
      return Promise.resolve({
        ok: false,
        error: `Debug console request queue is full (${this.maxInFlight} in flight) — wait for a reply before running more.`,
      });
    }
    const socket = this.socket;
    return new Promise<DebugSocketQueryResult>((resolve) => {
      const timer = setTimeout(() => this.onTimeout(), this.requestTimeoutMs);
      this.pending.push({ resolve, timer });
      socket.write(line + '\n', (err) => {
        if (err) {
          this.failAllThenDestroy(`Debug socket write failed: ${err.message}`);
        }
      });
    });
  }

  /** Idempotent teardown. Pending requests resolve with an error result. */
  disconnect(): void {
    this.failAll('Disconnected from the debug socket');
    const socket = this.socket;
    this.socket = undefined;
    if (socket) { socket.destroy(); }
    if (this.currentState !== 'disconnected') {
      this.setState('disconnected');
      this.logger.info('Debug socket disconnected', { path: this.socketPath });
    }
  }

  private onData(chunk: Buffer): void {
    this.bufferedBytes += chunk.length;
    if (this.bufferedBytes > this.maxLineBytes) {
      this.failAllThenDestroy(
        `Debug socket response exceeded the ${Math.round(this.maxLineBytes / (1024 * 1024))} MiB safety limit — connection closed.`,
      );
      return;
    }
    if (!this.decoder) { return; }
    this.text += this.decoder.write(chunk);
    for (;;) {
      const nl = this.text.indexOf('\n');
      if (nl < 0) { break; }
      const line = this.text.slice(0, nl);
      this.text = this.text.slice(nl + 1);
      this.bufferedBytes = Buffer.byteLength(this.text, 'utf8');
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.length === 0) { continue; } // blank lines are ignored
      this.deliverLine(trimmed);
    }
  }

  /** Pair one reply line with the head of the pending FIFO. */
  private deliverLine(line: string): void {
    const req = this.pending.shift();
    if (!req) {
      this.logger.warn('Debug socket sent an unsolicited reply line; ignoring', {
        preview: line.slice(0, 200),
      });
      return;
    }
    clearTimeout(req.timer);
    if (line.startsWith('ERROR:')) {
      req.resolve({ ok: false, error: line.slice('ERROR:'.length).trim() });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      req.resolve({ ok: false, error: 'Malformed reply from the debug socket (not JSON).' });
      return;
    }
    if (!Array.isArray(parsed)) {
      req.resolve({ ok: false, error: 'Malformed reply from the debug socket (expected a JSON array).' });
      return;
    }
    req.resolve({ ok: true, items: parsed as unknown[] });
  }

  private onTimeout(): void {
    // Replies are positional: with no per-request ID on the wire, a timed-out
    // head means every later reply would be attributed to the wrong request.
    // Close the connection so ordering stays honest.
    this.failAll(`Statement timed out after ${Math.round(this.requestTimeoutMs / 1000)}s — connection closed to keep replies aligned`);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.setState('disconnected', { error: 'Statement timed out; connection closed.' });
  }

  private failAll(error: string): void {
    const pending = this.pending;
    this.pending = [];
    for (const req of pending) {
      clearTimeout(req.timer);
      req.resolve({ ok: false, error });
    }
  }

  private failAllThenDestroy(error: string): void {
    this.failAll(error);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.setState('disconnected', { error });
  }

  private setState(state: DebugSocketState, detail?: { error?: string }): void {
    if (this.currentState === state) { return; }
    this.currentState = state;
    this.onStateChange?.(state, detail);
  }
}
