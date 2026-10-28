import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeRemoteQuery, HttpQueryError } from '../ditto/HttpQueryService.js';

/**
 * Live validation of the HTTP API scheme derivation (the query-side
 * sibling of the websocket scheme pin): against a self-managed Big Peer
 * serving plain HTTP, the HTTP API must be called over http — not https.
 *
 * A real loopback `node:http` server stands in for the Big Peer. This is
 * the exact scenario behind the bug report: before the fix, the service
 * always opened a TLS connection, so a query against the plain-HTTP port
 * died in the SSL handshake ("wrong version number") even with "Allow
 * untrusted certificates" checked — that flag only relaxes certificate
 * verification, it cannot downgrade a TLS handshake to plaintext.
 *
 * Asserted here:
 *   1. The failure mode is real: with no serverUrl (the old behavior),
 *      the request fails with a TLS error against a plaintext server.
 *   2. With an http:// serverUrl, the same request succeeds over
 *      plaintext, with the bearer key and statement intact.
 *   3. An https:// serverUrl keeps the TLS default (Cloud is a no-op).
 */

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

async function withPlainHttpServer(
  t: test.TestContext,
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"items":[{"_id":"a","v":1}]}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  });
  const { port } = server.address() as AddressInfo;
  await run(`127.0.0.1:${port}`, seen);
}

test('http api: a plain-HTTP Big Peer answers when the server URL is http://', async t => {
  await withPlainHttpServer(t, async (host, seen) => {
    const res = await executeRemoteQuery({
      httpApiUrl: host,
      httpApiKey: 'secret-key',
      allowUntrustedCerts: false,
      serverUrl: `http://${host}`,
      query: 'SELECT * FROM tasks',
    });

    assert.deepEqual(res, { items: [{ _id: 'a', v: 1 }] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, '/api/v5/store/execute');
    assert.equal(seen[0]!.authorization, 'Bearer secret-key');
    assert.deepEqual(JSON.parse(seen[0]!.body), { statement: 'SELECT * FROM tasks' });
  });
});

test('http api: the old always-https behavior fails against a plaintext port', async t => {
  // Premise check: this is the reported bug. With no serverUrl the
  // service defaults to https, and a TLS handshake against a plaintext
  // HTTP server raises an SSL error. If Node/TLS ever changes that
  // failure mode this test must fail loudly rather than silently pass.
  await withPlainHttpServer(t, async (host, seen) => {
    await assert.rejects(
      executeRemoteQuery({
        httpApiUrl: host,
        httpApiKey: 'secret-key',
        allowUntrustedCerts: true, // the checkbox cannot rescue a TLS-to-plaintext handshake
        query: 'SELECT * FROM tasks',
      }),
      (err: unknown) => {
        assert.ok(err instanceof HttpQueryError, `expected HttpQueryError, got ${String(err)}`);
        assert.match(err.message, /SSL|TLS|wrong version|EPROTO|handshake/i);
        return true;
      },
    );
    assert.equal(seen.length, 0, 'the server never saw an HTTP request — the handshake died first');
  });
});

test('http api: an https:// server URL keeps the TLS default', async t => {
  await withPlainHttpServer(t, async (host, seen) => {
    await assert.rejects(
      executeRemoteQuery({
        httpApiUrl: host,
        httpApiKey: 'secret-key',
        allowUntrustedCerts: false,
        serverUrl: `https://${host}`,
        query: 'SELECT * FROM tasks',
      }),
      /SSL|TLS|wrong version|EPROTO|handshake/i,
    );
    assert.equal(seen.length, 0, 'https against plaintext still fails — Cloud behavior unchanged');
  });
});
