import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBodyAccumulator,
  createSettleOnce,
  interpretResponse,
  HttpQueryError,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../ditto/HttpQueryService.js';

// ─── createBodyAccumulator ─────────────────────────────────────

test('createBodyAccumulator: concatenates chunks into one body', () => {
  const acc = createBodyAccumulator(1024);
  assert.equal(acc.push(Buffer.from('{"items":')), true);
  assert.equal(acc.push(Buffer.from('[1,2]}')), true);
  assert.equal(acc.text(), '{"items":[1,2]}');
  assert.equal(acc.byteLength(), 15);
});

test('createBodyAccumulator: multi-byte characters split across chunks survive', () => {
  // Decoding per-chunk would mangle a UTF-8 sequence that straddles a chunk
  // boundary, which is exactly what happens on a real socket.
  const full = Buffer.from('{"n":"日本語"}', 'utf8');
  const acc = createBodyAccumulator(1024);
  acc.push(full.subarray(0, 7));
  acc.push(full.subarray(7));
  assert.equal(acc.text(), '{"n":"日本語"}');
});

test('createBodyAccumulator: refuses the chunk that crosses the cap', () => {
  const acc = createBodyAccumulator(10);
  assert.equal(acc.push(Buffer.alloc(6)), true);
  assert.equal(acc.push(Buffer.alloc(6)), false, 'over the cap');
  // Everything after stays refused, so a server that keeps streaming after
  // the socket destroy can't sneak past the cap.
  assert.equal(acc.push(Buffer.alloc(1)), false);
});

test('createBodyAccumulator: exactly at the cap is accepted', () => {
  const acc = createBodyAccumulator(10);
  assert.equal(acc.push(Buffer.alloc(10)), true, 'off-by-one would reject a legal maximum response');
  assert.equal(acc.push(Buffer.alloc(1)), false);
});

test('createBodyAccumulator: the default cap is MAX_RESPONSE_BYTES', () => {
  assert.equal(MAX_RESPONSE_BYTES, 64 * 1024 * 1024);
  const acc = createBodyAccumulator();
  assert.equal(acc.push(Buffer.alloc(1024)), true);
});

// ─── interpretResponse ─────────────────────────────────────────

test('interpretResponse: 2xx with items returns them', () => {
  const r = interpretResponse(200, '{"items":[{"_id":"a"},{"_id":"b"}]}');
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.kind === 'ok' && r.items, [{ _id: 'a' }, { _id: 'b' }]);
});

test('interpretResponse: 2xx without an items array is success with no rows', () => {
  // INSERT and ALTER SYSTEM return no rows. Treating that as a parse failure
  // would surface an error for a statement that actually worked.
  for (const body of ['{}', '{"items":null}', '{"mutatedDocumentIds":[]}']) {
    const r = interpretResponse(200, body);
    assert.equal(r.kind, 'ok', body);
    assert.deepEqual(r.kind === 'ok' && r.items, [], body);
  }
});

test('interpretResponse: the whole 2xx range is success', () => {
  for (const status of [200, 201, 204, 299]) {
    assert.equal(interpretResponse(status, '{"items":[]}').kind, 'ok', String(status));
  }
});

test('interpretResponse: non-2xx carries the status and the body', () => {
  const r = interpretResponse(401, 'permission denied');
  assert.equal(r.kind, 'error');
  const err = r.kind === 'error' ? r.error : null;
  assert.ok(err instanceof HttpQueryError);
  assert.equal(err?.status, 401);
  // The body is where the server explains itself — dropping it leaves the
  // user with a bare status code.
  assert.equal(err?.body, 'permission denied');
  assert.match(err?.message ?? '', /401/);
});

test('interpretResponse: a non-2xx body is never parsed as JSON', () => {
  // An HTML error page from a proxy must produce the status error, not a
  // confusing "failed to parse" that hides what actually happened.
  const r = interpretResponse(502, '<html>Bad Gateway</html>');
  assert.equal(r.kind, 'error');
  assert.match(r.kind === 'error' ? r.error.message : '', /502/);
});

test('interpretResponse: a 0 status (no response line) is an error', () => {
  assert.equal(interpretResponse(0, '').kind, 'error');
});

test('interpretResponse: unparseable 2xx body reports a parse failure with the body', () => {
  const r = interpretResponse(200, 'not json at all');
  assert.equal(r.kind, 'error');
  const err = r.kind === 'error' ? r.error : null;
  assert.match(err?.message ?? '', /Failed to parse server response/);
  assert.equal(err?.status, 200);
  assert.equal(err?.body, 'not json at all');
});

// ─── createSettleOnce ──────────────────────────────────────────

test('createSettleOnce: only the first outcome runs', () => {
  // A single request races a timeout, a socket error, an over-limit abort and
  // a normal end — and the over-limit path's res.destroy() *causes* an error
  // event. Without this guard the later outcomes are silent no-ops at best.
  const ran: string[] = [];
  const settle = createSettleOnce();
  assert.equal(settle.settled, false);

  settle(() => ran.push('timeout'));
  settle(() => ran.push('error'));
  settle(() => ran.push('end'));

  assert.deepEqual(ran, ['timeout']);
  assert.equal(settle.settled, true);
});

test('createSettleOnce: instances are independent', () => {
  const a = createSettleOnce();
  const b = createSettleOnce();
  a(() => {});
  assert.equal(a.settled, true);
  assert.equal(b.settled, false, 'one request settling must not settle another');
});

test('REQUEST_TIMEOUT_MS: a hung server is bounded', () => {
  // The value matters less than it existing and being finite — an unbounded
  // request leaves the Query panel spinning in 'running' forever.
  assert.ok(Number.isFinite(REQUEST_TIMEOUT_MS));
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 60_000);
});
