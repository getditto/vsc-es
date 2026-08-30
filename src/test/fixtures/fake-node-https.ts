/**
 * Test-only stand-in for `node:https`.
 *
 * `HttpQueryService.executeRemoteQuery` imports `node:https` as a module
 * binding, so a test can't substitute it through a constructor — a
 * module-level seam is required. The owning test file registers a
 * `module.registerHooks` resolve hook that rewrites the service's
 * `node:https` specifier to this file (per test-file process, so no other
 * suite sees it), then drives the recorded exchange directly: respond(),
 * emit data/end/error, or fire the armed timeout.
 *
 * This models only what executeRemoteQuery touches: `request(options, cb)`
 * returning a ClientRequest with write/end/setTimeout/on/destroy, and a
 * response EventEmitter with statusCode + destroy. Recording the exchange
 * (rather than scripting a server) keeps every outcome deterministic —
 * timeouts, over-limit aborts and mid-stream errors included.
 */

import { EventEmitter } from 'node:events';

export class FakeResponse extends EventEmitter {
  statusCode: number | undefined;
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

export class FakeRequest extends EventEmitter {
  readonly chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  timeoutMs: number | undefined;
  private timeoutCb: (() => void) | undefined;

  setTimeout(ms: number, cb?: () => void): this {
    this.timeoutMs = ms;
    this.timeoutCb = cb;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  /** Test driver: fire the timeout the service armed via setTimeout. */
  fireTimeout(): void {
    this.timeoutCb?.();
  }

  /** The concatenated request body the service wrote. */
  bodyText(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export interface FakeExchange {
  /** The options object the service handed to https.request. */
  readonly options: Record<string, unknown>;
  readonly req: FakeRequest;
  readonly res: FakeResponse;
  /** Invoke the response callback the service passed to https.request,
   *  attaching its data/end listeners to {@link res}. */
  respond(): void;
}

/** Every request the service made, in order. Reset per test. */
export const exchanges: FakeExchange[] = [];

export function request(
  options: Record<string, unknown>,
  onResponse?: (res: FakeResponse) => void,
): FakeRequest {
  const req = new FakeRequest();
  const res = new FakeResponse();
  exchanges.push({
    options,
    req,
    res,
    respond() {
      onResponse?.(res);
    },
  });
  return req;
}

export function __resetFakeNodeHttps(): void {
  exchanges.length = 0;
}
