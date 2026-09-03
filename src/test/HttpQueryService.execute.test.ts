import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Logger, LogLevel } from '../logging/types.js';
import type { HttpQueryRequest } from '../ditto/HttpQueryService.js';
import type { FakeExchange } from './fixtures/fake-node-https.js';

/**
 * executeRemoteQuery against a scripted `node:https`.
 *
 * The service imports `node:https` as a module binding, so the
 * `registerHooks` resolve hook below rewrites that one import (this test
 * file's process only) to the fake in `fixtures/`. The pure halves of the
 * module (URL validation, body accumulator, response classifier, settle-once)
 * are covered in HttpQueryService.test.ts; here the socket plumbing is the
 * subject: request shape, happy path, and every failure branch (non-2xx,
 * unparseable body, over-limit abort, timeout, socket error, settle-once
 * races).
 *
 * The hook must be registered BEFORE the service module resolves, so the
 * service is pulled in with a dynamic import — a static top-level import
 * would hoist above the registration.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:https'
        && context.parentURL?.endsWith('/src/ditto/HttpQueryService.ts')) {
      return {
        url: new URL('./fixtures/fake-node-https.ts', import.meta.url).href,
        shortCircuit: true,
        format: 'module',
      };
    }
    return nextResolve(specifier, context);
  },
});

const fakeHttps = await import('./fixtures/fake-node-https.js');
const {
  executeRemoteQuery,
  HttpQueryError,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} = await import('../ditto/HttpQueryService.js');

const REQ: HttpQueryRequest = {
  httpApiUrl: 'server.example',
  httpApiKey: 'secret-key',
  allowUntrustedCerts: false,
  query: 'SELECT * FROM tasks',
};

function lastExchange(): FakeExchange {
  const ex = fakeHttps.exchanges[fakeHttps.exchanges.length - 1];
  assert.ok(ex, 'the service opened no https request');
  return ex;
}

test.beforeEach(() => { fakeHttps.__resetFakeNodeHttps(); });

// ─── Request shape ─────────────────────────────────────────────

test('executeRemoteQuery: POSTs the statement to /api/v5/store/execute with the bearer key', async () => {
  const promise = executeRemoteQuery(REQ);

  const ex = lastExchange();
  assert.equal(ex.options.method, 'POST');
  assert.equal(ex.options.hostname, 'server.example');
  assert.equal(ex.options.port, 443, 'no port in the URL falls back to 443');
  assert.equal(ex.options.path, '/api/v5/store/execute');
  const headers = ex.options.headers as Record<string, unknown>;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers.Authorization, 'Bearer secret-key');
  assert.equal(ex.options.rejectUnauthorized, true, 'certs verified by default');
  assert.equal(ex.req.ended, true, 'request body was flushed');
  assert.equal(ex.req.bodyText(), JSON.stringify({ statement: REQ.query }));
  assert.equal(
    headers['Content-Length'], Buffer.byteLength(ex.req.bodyText()),
    'Content-Length matches the actual body bytes',
  );
  assert.equal(ex.req.timeoutMs, REQUEST_TIMEOUT_MS, 'a hung server must not spin forever');

  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[{"_id":"a"}]}'));
  ex.res.emit('end');
  assert.deepEqual(await promise, { items: [{ _id: 'a' }] });
});

test('executeRemoteQuery: a custom port and base path land in the request line', async () => {
  const promise = executeRemoteQuery({
    ...REQ,
    httpApiUrl: 'localhost:8443/some/base',
    allowUntrustedCerts: true,
  });

  const ex = lastExchange();
  assert.equal(ex.options.hostname, 'localhost');
  assert.equal(ex.options.port, '8443', 'URL.port is the string form');
  assert.equal(ex.options.path, '/some/base/api/v5/store/execute');
  assert.equal(
    ex.options.rejectUnauthorized, false,
    'allowUntrustedCerts opts out of verification for this request only',
  );

  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[]}'));
  ex.res.emit('end');
  await promise;
});

test('executeRemoteQuery: logs the POST with a bounded query preview', async () => {
  const debugs: { message: string; ctx: unknown }[] = [];
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, trace: () => {},
    debug: (m: string, ctx?: unknown) => { debugs.push({ message: m, ctx }); },
    withTag: () => self,
    getChannelLevel: (): LogLevel => 'info',
    onDidChangeChannelLevel: () => ({ dispose: () => {} }),
  } as unknown as Logger;

  const promise = executeRemoteQuery(
    { ...REQ, query: `SELECT ${'x'.repeat(200)}` },
    self,
  );

  assert.equal(debugs.length, 1);
  assert.equal(debugs[0]?.message, 'POST /store/execute');
  const ctx = debugs[0]?.ctx as { host: string; queryPreview: string; allowUntrustedCerts: boolean };
  assert.equal(ctx.host, 'server.example');
  assert.equal(ctx.queryPreview.length, 80, 'the preview is capped, not the whole statement');
  assert.equal(ctx.allowUntrustedCerts, false);

  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[]}'));
  ex.res.emit('end');
  await promise;
});

// ─── Happy-path body handling ──────────────────────────────────

test('executeRemoteQuery: a body split across chunks is reassembled', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[{"_id":"a"},'));
  ex.res.emit('data', Buffer.from('{"_id":"b"}]}'));
  ex.res.emit('end');
  assert.deepEqual(await promise, { items: [{ _id: 'a' }, { _id: 'b' }] });
});

test('executeRemoteQuery: a 2xx without an items array resolves to no rows', async () => {
  // INSERT / ALTER SYSTEM return no rows; that is success, not a malformed
  // response.
  const promise = executeRemoteQuery({ ...REQ, query: 'ALTER SYSTEM SET x = 1' });
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 204;
  ex.res.emit('data', Buffer.from('{}'));
  ex.res.emit('end');
  assert.deepEqual(await promise, { items: [] });
});

// ─── Failure branches ──────────────────────────────────────────

test('executeRemoteQuery: an empty httpApiUrl is refused before any socket opens', async () => {
  for (const httpApiUrl of ['', '   ']) {
    await assert.rejects(
      executeRemoteQuery({ ...REQ, httpApiUrl }),
      (err: unknown) => {
        assert.ok(err instanceof HttpQueryError);
        assert.match(err.message, /httpApiUrl is empty/);
        return true;
      },
    );
  }
  assert.equal(fakeHttps.exchanges.length, 0, 'no request was attempted');
});

test('executeRemoteQuery: a non-2xx response rejects with status and body', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 401;
  ex.res.emit('data', Buffer.from('{"error":"bad token"}'));
  ex.res.emit('end');

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.equal(err.status, 401);
    assert.equal(err.body, '{"error":"bad token"}', 'the server explains itself in the body');
    assert.match(err.message, /401/);
    return true;
  });
});

test('executeRemoteQuery: an unparseable 2xx body rejects as a parse failure', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('<html>not json</html>'));
  ex.res.emit('end');

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.match(err.message, /Failed to parse server response/);
    assert.equal(err.status, 200);
    return true;
  });
});

test('executeRemoteQuery: a response with no status line classifies as an error', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  // statusCode never set — `res.statusCode ?? 0` falls to the error branch.
  ex.res.emit('data', Buffer.from('{}'));
  ex.res.emit('end');

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.match(err.message, /returned 0/);
    return true;
  });
});

test('executeRemoteQuery: an over-limit response rejects and destroys the stream', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1));

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.match(err.message, /exceeded the 64 MB limit/);
    return true;
  });
  assert.equal(ex.res.destroyed, true, 'the socket is torn down, not drained');

  // The destroy *causes* further socket events in real life; settle-once must
  // swallow them rather than double-settle or throw.
  ex.res.emit('end');
  ex.req.emit('error', new Error('socket hang up'));
});

test('executeRemoteQuery: the timeout rejects and destroys the request', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  assert.equal(ex.req.timeoutMs, REQUEST_TIMEOUT_MS);

  ex.req.fireTimeout();

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.match(err.message, /timed out after 30s/);
    return true;
  });
  assert.equal(ex.req.destroyed, true);

  // A late response arriving after the timeout must not change the outcome.
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[{"_id":"late"}]}'));
  ex.res.emit('end');
  await assert.rejects(promise, /timed out/, 'the first outcome stands');
});

test('executeRemoteQuery: a socket error rejects with the error message', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.req.emit('error', new Error('connect ECONNREFUSED 10.0.0.1:443'));

  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpQueryError);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

test('executeRemoteQuery: an error after a normal end is swallowed by settle-once', async () => {
  const promise = executeRemoteQuery(REQ);
  const ex = lastExchange();
  ex.respond();
  ex.res.statusCode = 200;
  ex.res.emit('data', Buffer.from('{"items":[]}'));
  ex.res.emit('end');
  assert.deepEqual(await promise, { items: [] });

  // Node can still raise an 'error' on an ended request; it must not become
  // an unhandled rejection or flip the result.
  ex.req.emit('error', new Error('late reset'));
  assert.deepEqual(await promise, { items: [] });
});
