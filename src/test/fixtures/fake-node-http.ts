/**
 * Test-only stand-in for `node:http`.
 *
 * Sibling of `fake-node-https.ts`: `HttpQueryService.executeRemoteQuery`
 * picks `node:http` when the connection's server URL is plain HTTP (a
 * self-managed Big Peer), so tests that assert the scheme selection need
 * to observe which module received the request. A separate module (with
 * its own `exchanges` array) makes that observation unambiguous — the
 * registerHooks resolve hook in the owning test file rewrites the
 * service's `node:http` specifier here, exactly as `node:https` is
 * rewritten to the sibling fixture.
 *
 * Classes are re-exported from `fake-node-https.ts` so both fakes speak
 * the same FakeRequest/FakeResponse contract.
 */

import { FakeRequest, FakeResponse } from './fake-node-https.js';

export { FakeRequest, FakeResponse };

export interface FakeHttpExchange {
  /** The options object the service handed to http.request. */
  readonly options: Record<string, unknown>;
  readonly req: FakeRequest;
  readonly res: FakeResponse;
  /** Invoke the response callback the service passed to http.request,
   *  attaching its data/end listeners to {@link res}. */
  respond(): void;
}

/** Every request the service made over plain HTTP, in order. Reset per test. */
export const exchanges: FakeHttpExchange[] = [];

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

export function __resetFakeNodeHttp(): void {
  exchanges.length = 0;
}
