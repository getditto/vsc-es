/**
 * Test-only stand-in for `src/ditto/HttpQueryService.ts`.
 *
 * Panels import `executeRemoteQuery` as a module binding, so a test can't
 * substitute it through a constructor — a module-level seam is required.
 * The owning test file registers a `module.registerHooks` resolve hook that
 * rewrites the panel's `../ditto/HttpQueryService.js` specifier to this file
 * (per test-file process, so no other suite sees it), then scripts responses
 * through {@link __setExecuteRemoteQuery}.
 *
 * The indirection through `impl` keeps the live named binding intact: the
 * panel holds `executeRemoteQuery` itself, so the impl must be swappable
 * between tests without re-importing the panel.
 */

import type { HttpQueryRequest, HttpQueryResponse } from '../../ditto/HttpQueryService.js';

type Impl = (req: HttpQueryRequest) => Promise<HttpQueryResponse>;

let impl: Impl = () => Promise.resolve({ items: [] });

/** Script the next responses. Each call shifts the next scripted outcome;
 *  when the script is exhausted the default empty response answers. */
export function __setExecuteRemoteQuery(next: Impl): void {
  impl = next;
}

export function __resetFakeHttp(): void {
  impl = () => Promise.resolve({ items: [] });
}

/** Mirror of the real class shape so importing modules can `instanceof`
 *  it; scripted impls may throw this to exercise error paths. */
export class HttpQueryError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'HttpQueryError';
  }
}

export async function executeRemoteQuery(req: HttpQueryRequest): Promise<HttpQueryResponse> {
  return impl(req);
}
