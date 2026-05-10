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
  const url = new URL(`https://${req.httpApiUrl}/api/v5/store/execute`);
  const body = JSON.stringify({ statement: req.query });

  log?.debug('POST /store/execute', {
    host: url.host,
    queryPreview: req.query.slice(0, 80),
    allowUntrustedCerts: req.allowUntrustedCerts,
  });

  return new Promise<HttpQueryResponse>((resolve, reject) => {
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
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new HttpQueryError(`Ditto Server returned ${status}`, status, text));
            return;
          }
          try {
            const parsed = JSON.parse(text) as { items?: unknown[] };
            resolve({ items: Array.isArray(parsed.items) ? parsed.items : [] });
          } catch (err) {
            reject(new HttpQueryError(
              `Failed to parse server response: ${err instanceof Error ? err.message : String(err)}`,
              status,
              text,
            ));
          }
        });
      },
    );
    r.on('error', (err) => reject(new HttpQueryError(err.message)));
    r.write(body);
    r.end();
  });
}
