import test from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { webviewMessageHandler } from '../panels/webview-utils.js';
import type { Logger, LogContext } from '../logging/types.js';

/**
 * Every async webview-message handler must report its failures.
 *
 * `onDidReceiveMessage` discards the listener's return value, so both
 * `(msg) => this.handle(msg)` and `(msg) => { void this.handle(msg); }` drop a
 * rejection on the floor: nothing is logged and the user reads it as "the
 * button did nothing". `webviewMessageHandler` is the single wrapper all twelve
 * panels now go through, so testing it covers all of them.
 *
 * This replaces a MANUAL_TESTING recipe that asked a human to disconnect and
 * click Run in six different panels.
 */

const stub = vscode as unknown as {
  window: { shownErrors: string[] };
  __resetStub(): void;
};

function recordingLogger(): { logger: Logger; errors: { msg: string; ctx?: LogContext | undefined }[] } {
  const errors: { msg: string; ctx?: LogContext | undefined }[] = [];
  const logger = {
    error: (msg: string, ctx?: LogContext) => { errors.push({ msg, ctx }); },
    warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => logger,
  } as unknown as Logger;
  return { logger, errors };
}

test('webviewMessageHandler: a rejected handler is logged and surfaced to the user', async () => {
  stub.__resetStub();
  const { logger, errors } = recordingLogger();
  const handler = webviewMessageHandler<{ type: string }>(
    logger, 'ext:test', 'Query editor action failed',
    () => Promise.reject(new Error('no active database')),
  );

  handler({ type: 'query.run' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1, 'logged exactly once');
  assert.equal(errors[0]?.msg, 'Query editor action failed');
  assert.equal(errors[0]?.ctx?.err, 'no active database', 'the cause is in the log line');
  assert.equal(errors[0]?.ctx?.messageType, 'query.run', 'and which message caused it');

  assert.deepEqual(
    stub.window.shownErrors,
    ['Query editor action failed: no active database'],
    'the user is told, rather than watching nothing happen',
  );
});

test('webviewMessageHandler: a synchronous throw is caught too', async () => {
  // A handler can throw before its first await — argument validation, a
  // destructuring failure on a malformed message. That path has no promise to
  // reject, so a promise-only guard would let it escape into VS Code's event
  // dispatcher.
  stub.__resetStub();
  const { logger, errors } = recordingLogger();
  const handler = webviewMessageHandler<{ type: string }>(
    logger, 'ext:test', 'Import data failed',
    () => { throw new Error('malformed message'); },
  );

  assert.doesNotThrow(() => handler({ type: 'import.start' }));
  assert.equal(errors.length, 1);
  assert.deepEqual(stub.window.shownErrors, ['Import data failed: malformed message']);
});

test('webviewMessageHandler: a non-Error rejection still produces a readable message', async () => {
  stub.__resetStub();
  const { logger, errors } = recordingLogger();
  const handler = webviewMessageHandler<{ type: string }>(
    logger, 'ext:test', 'Save observer failed',
    // Rejecting with a non-Error is the whole point of this case — the SDK and
    // the webview boundary both produce them.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    () => Promise.reject('plain string'),
  );

  handler({ type: 'observer.save' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors[0]?.ctx?.err, 'plain string');
  assert.deepEqual(stub.window.shownErrors, ['Save observer failed: plain string']);
});

test('webviewMessageHandler: a handler that succeeds says nothing', async () => {
  // The wrapper must be invisible on the happy path — a notification per
  // message would make every panel unusable.
  stub.__resetStub();
  const { logger, errors } = recordingLogger();
  const seen: unknown[] = [];
  const handler = webviewMessageHandler<{ type: string }>(
    logger, 'ext:test', 'Should not appear',
    (msg) => { seen.push(msg); return Promise.resolve(); },
  );

  handler({ type: 'query.run' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(seen, [{ type: 'query.run' }], 'the handler still ran');
  assert.deepEqual(errors, []);
  assert.deepEqual(stub.window.shownErrors, []);
});

test('webviewMessageHandler: a synchronous (non-promise) handler is supported', async () => {
  stub.__resetStub();
  const { logger, errors } = recordingLogger();
  let ran = false;
  const handler = webviewMessageHandler<{ type: string }>(
    logger, 'ext:test', 'Should not appear', () => { ran = true; },
  );
  handler({ type: 'log.setLevel' });
  assert.equal(ran, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(stub.window.shownErrors, []);
});

test('every panel routes its webview messages through the wrapper', async () => {
  // The defect was never in one panel — it was that four panels passed a bare
  // async function and eight more used `void` with no catch. Asserting the
  // wrapper is used everywhere is what stops the thirteenth panel from
  // reintroducing it, since a new panel is normally written by copying one.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const roots = ['src/panels', 'src/inspector'];
  const offenders: string[] = [];

  for (const root of roots) {
    for (const file of await fs.readdir(root)) {
      if (!file.endsWith('.ts')) { continue; }
      const full = path.join(root, file);
      const text = await fs.readFile(full, 'utf8');
      if (!text.includes('onDidReceiveMessage')) { continue; }
      // Check the call site, not just the identifier: an unused import would
      // otherwise satisfy a bare `includes`, which made an earlier version of
      // this test pass against a panel that had been reverted to a bare
      // `(msg) => this.handle(msg)`.
      // The generic argument sits between the name and the paren
      // (`webviewMessageHandler<QueryIn>(`), so match that shape
      // rather than a bare `name(`.
      const CALL = /webviewMessageHandler\s*(<[^>]*>)?\s*\(/;
      for (const m of text.matchAll(/onDidReceiveMessage\(/g)) {
        const window = text.slice(m.index, m.index + 200);
        if (!CALL.test(window)) {
          offenders.push(`${full}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'these register a webview message listener without webviewMessageHandler',
  );
});
