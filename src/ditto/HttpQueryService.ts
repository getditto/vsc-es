import * as https from 'node:https';
import type { Logger } from '../logging/types.js';

/**
 * Configuration for a single call to the Ditto Server's
 * `/api/v5/store/execute` endpoint. Keys mirror the shape stored on a
 * connection ({@link StoredDittoConfig.httpApiUrl},
 * {@link SecretSet.httpApiKey}, {@link StoredDittoConfig.allowUntrustedCerts}).
 */
export interface HttpQueryRequest {
  /** `httpApiUrl` from the connection — host[:port] without scheme. */
  httpApiUrl: string;
  /** `httpApiKey` from the secret store — sent as `Authorization: Bearer …`. */
  httpApiKey: string;
  /** Mirrors the connection's `allowUntrustedCerts` flag. */
  allowUntrustedCerts: boolean;
  /** DQL query string to send as `{"statement": …}`. */
  query: string;
}

/**
 * Response shape we care about. The full server response is richer
 * (mutated document IDs, commit ID) but for the read paths exercised by
 * the importer we only need `items`. Kept narrow on purpose — callers
 * doing more should add their own typed wrapper rather than widening
 * this one.
 */
export interface HttpQueryResponse {
  items: unknown[];
}

/** Thrown when the server returns a non-2xx response or unparseable body. */
export class HttpQueryError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'HttpQueryError';
  }
}

/**
 * Validate a stored httpApiUrl/authUrl BEFORE it is glued into
 * `https://${value}` alongside the bearer key. The trap: URL userinfo.
 * `https://good.com@evil.com/…` parses as host `evil.com` with username
 * `good.com` — pasting that into the connection editor would send the
 * Authorization header (the app token) to the attacker's host.
 *
 * Returns a human-readable error, or null when the value is empty (the
 * field stays optional — only present values are validated here) or a
 * sane scheme-less host[:port][/path].
 */
export function validateHttpApiUrl(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) { return null; }
  if (v.includes('@')) {
    return 'URLs must not contain a username or "@" — enter only the host (e.g. example.ditto.live:443).';
  }
  let url: URL;
  try {
    url = new URL(`https://${v}`);
  } catch {
    return 'Not a valid host[:port] — enter it without a scheme, e.g. example.ditto.live.';
  }
  if (url.username || url.password) {
    return 'URLs must not embed credentials — enter only the host (e.g. example.ditto.live:443).';
  }
  if (!url.hostname) {
    return 'Not a valid host — enter it without a scheme, e.g. example.ditto.live.';
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
    return 'Enter the host without a scheme (leave off "https://" — it is added automatically).';
  }
  return null;
}

/** A hung server must not leave the query panel in 'running' forever. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Responses are buffered fully in memory before parsing — cap them so a
 *  pathological server can't OOM the extension host. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Bounded response-body accumulator.
 *
 * Extracted from the socket plumbing so the byte cap is testable without a
 * server: the cap is the difference between a pathological response being an
 * error and being an extension-host OOM, and that is not something to leave
 * to an integration test that needs a TLS listener to run.
 */
export function createBodyAccumulator(maxBytes: number = MAX_RESPONSE_BYTES): {
  /** Returns false once the cap is exceeded; the caller destroys the socket. */
  push(chunk: Buffer): boolean;
  text(): string;
  byteLength(): number;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  let overLimit = false;
  return {
    push(chunk: Buffer): boolean {
      if (overLimit) { return false; }
      total += chunk.length;
      if (total > maxBytes) { overLimit = true; return false; }
      chunks.push(chunk);
      return true;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    byteLength: () => total,
  };
}

/** What to do with a fully-received response. */
export type ResponseOutcome =
  | { kind: 'ok'; items: unknown[] }
  | { kind: 'error'; error: HttpQueryError };

/**
 * Classify a complete response. Pure, so the status/parse branches are
 * testable directly — they are the ones that decide whether the user sees a
 * useful message or a spinner that never stops.
 */
export function interpretResponse(status: number, text: string): ResponseOutcome {
  if (status < 200 || status >= 300) {
    return { kind: 'error', error: new HttpQueryError(`Ditto Server returned ${status}`, status, text) };
  }
  try {
    const parsed = JSON.parse(text) as { items?: unknown[] };
    // A 2xx without an `items` array is a successful statement that returned
    // no rows (INSERT, ALTER SYSTEM), not a malformed response.
    return { kind: 'ok', items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (err) {
    return {
      kind: 'error',
      error: new HttpQueryError(
        `Failed to parse server response: ${err instanceof Error ? err.message : String(err)}`,
        status,
        text,
      ),
    };
  }
}

/**
 * One-shot guard for a Promise that several socket events can settle.
 *
 * A single request can race a timeout, a socket error, an over-limit abort,
 * and a normal end — and `res.destroy()` on the over-limit path *causes* an
 * error event. Without this, the first outcome resolves and the rest are
 * silent no-ops at best; the point of naming it is that the invariant is
 * testable rather than implied by reading the callback nest.
 */
export function createSettleOnce(): {
  (fn: () => void): void;
  get settled(): boolean;
} {
  let settled = false;
  const settle = (fn: () => void): void => {
    if (settled) { return; }
    settled = true;
    fn();
  };
  Object.defineProperty(settle, 'settled', { get: () => settled });
  return settle as ReturnType<typeof createSettleOnce>;
}

/**
 * POST a DQL statement to the Ditto Server's REST endpoint and return
 * the items array. Implemented against `node:https` (rather than the
 * global `fetch`) because we need per-request control over
 * `rejectUnauthorized` for the `allowUntrustedCerts` flag, which fetch
 * doesn't expose without pulling in undici directly.
 *
 * Mirrors the SwiftUI `executeSelectedAppQueryHttp` semantics:
 * `https://<httpApiUrl>/api/v5/store/execute` with
 * `Authorization: Bearer <httpApiKey>` and a JSON body of
 * `{"statement": "<query>"}`.
 */
export async function executeRemoteQuery(
  req: HttpQueryRequest,
  logger?: Logger,
): Promise<HttpQueryResponse> {
  const log = logger?.withTag('ext:HttpQueryService');

  // Defensive refuse: even if a bad value slipped past the connection
  // editor's own validation (older configs, manual JSON edit), never
  // send the bearer key to a host the user didn't mean. A malformed
  // URL is rejected up front with a clear HttpQueryError instead of a
  // node's opaque ECONNREFUSED-style message.
  const urlProblem = req.httpApiUrl.trim().length > 0
    ? validateHttpApiUrl(req.httpApiUrl)
    : 'httpApiUrl is empty';
  if (urlProblem) {
    throw new HttpQueryError(`Refusing to query: httpApiUrl is invalid (${urlProblem})`);
  }
  const url = new URL(`https://${req.httpApiUrl}/api/v5/store/execute`);
  const body = JSON.stringify({ statement: req.query });

  log?.debug('POST /store/execute', {
    host: url.host,
    queryPreview: req.query.slice(0, 80),
    allowUntrustedCerts: req.allowUntrustedCerts,
  });

  return new Promise<HttpQueryResponse>((resolve, reject) => {
    const settle = createSettleOnce();
    const r = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${req.httpApiKey}`,
        },
        // Per-request opt-out of cert validation, matching
        // appConfig.allowUntrustedCerts in the SwiftUI implementation.
        rejectUnauthorized: !req.allowUntrustedCerts,
      },
      (res) => {
        const bodyBuffer = createBodyAccumulator(MAX_RESPONSE_BYTES);
        res.on('data', (chunk: Buffer) => {
          if (!bodyBuffer.push(chunk)) {
            settle(() => reject(new HttpQueryError(
              `Server response exceeded the ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB limit`,
            )));
            res.destroy();
          }
        });
        res.on('end', () => {
          const outcome = interpretResponse(res.statusCode ?? 0, bodyBuffer.text());
          settle(() => {
            if (outcome.kind === 'ok') { resolve({ items: outcome.items }); }
            else { reject(outcome.error); }
          });
        });
      },
    );
    r.setTimeout(REQUEST_TIMEOUT_MS, () => {
      settle(() => reject(new HttpQueryError(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)));
      r.destroy();
    });
    r.on('error', (err) => settle(() => reject(new HttpQueryError(err.message))));
    r.write(body);
    r.end();
  });
}
