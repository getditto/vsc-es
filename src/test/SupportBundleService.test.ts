import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import { window } from 'vscode';

const gunzip = promisify(zlib.gunzip);

import { SupportBundleService, MIN_QUERY_SECONDS } from '../ditto/SupportBundleService.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { Logger } from '../logging/types.js';

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

/** Create a minimal tar archive containing the given entries. */
function createTarBytes(entries: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(name.length, 100), 'utf-8');
    header.write('0000644\0', 100, 8); // mode
    header.write('0000000\0', 108, 8); // uid
    header.write('0000000\0', 116, 8); // gid
    const sizeOctal = data.length.toString(8).padStart(11, '0') + '\0';
    header.write(sizeOctal, 124, 12); // size
    header.write('00000000000\0', 136, 12); // mtime
    header.write('        ', 148, 8); // checksum placeholder
    header.write('0', 156, 1); // type: regular file
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    const chksum = checksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chksum, 148, 8);
    blocks.push(header);
    blocks.push(data);
    const remainder = data.length % 512;
    if (remainder !== 0) { blocks.push(Buffer.alloc(512 - remainder)); }
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

/** Build a mock DittoManager that satisfies the SupportBundleService. */
function mockManager(opts: {
  bundleDoc?: Record<string, unknown>;
  attachmentBytes?: Buffer;
  fetchNull?: boolean;
}) {
  const executeRawCalls: string[] = [];

  const bundleDoc = opts.bundleDoc ?? {
    _id: { pk: 'abc123', created_at: '2026-10-20T12:00:00Z' },
    reason: 'USER_INITIATED',
    file: { id: 'att-1', len: 100, metadata: {} },
  };

  const attachmentBytes = opts.attachmentBytes ?? createTarBytes({
    'dial9/dial9.bin.gz': zlib.gzipSync(Buffer.from('fake dial9 trace data')),
    'logs/ditto.log': Buffer.from('fake log content'),
  });

  const manager = {
    executeRaw: async (query: string) => {
      executeRawCalls.push(query);
      if (query === 'EXECUTE FUNCTION system_request_support_bundle()') {
        return [bundleDoc];
      }
      return [];
    },
    fetchAttachment: opts.fetchNull
      ? () => null
      : (_token: unknown) => {
          // Return a proper PromiseLike that resolves with the mock attachment.
          const attachment = {
            copyToPath: async (destPath: string) => {
              await fs.writeFile(destPath, attachmentBytes);
            },
          };
          return Promise.resolve(attachment);
        },
  } as unknown as DittoManager;

  return { manager, executeRawCalls, bundleDoc, attachmentBytes };
}

/** Stub the save dialog to auto-accept with a path in `dir`. */
function stubSaveDialog(dir: string, filename = 'bundle.tar.gz'): string {
  const target = path.join(dir, filename);
  (window as unknown as Record<string, unknown>).saveDialogResult = { fsPath: target };
  return target;
}

function resetStub() {
  (window as unknown as Record<string, unknown>).saveDialogResult = undefined;
  (window as unknown as Record<string, unknown>).lastSaveDialogOptions = undefined;
}

// ─── Tests ──────────────────────────────────────────────────────

test('MIN_QUERY_SECONDS is 70 (matches benchy)', () => {
  assert.equal(MIN_QUERY_SECONDS, 70);
});

test('collect: no query → skips load generation, requests bundle, saves .tar.gz', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager, executeRawCalls } = mockManager({});
  const service = new SupportBundleService(manager, noopLogger());
  const savedPath = stubSaveDialog(tmpDir);

  const result = await service.collect(undefined, undefined, 0.01);
  assert.ok(result, 'expected a result');
  assert.equal(result.savedPath, savedPath);
  assert.equal(result.queryExecutions, 0, 'no query loop without a query');
  assert.equal(result.querySeconds, 0);

  // Verify the DQL calls
  assert.deepEqual(executeRawCalls, ['EXECUTE FUNCTION system_request_support_bundle()']);

  // Verify the file was written and is valid gzip
  const gzBytes = await fs.readFile(savedPath);
  const tarBytes = await gunzip(gzBytes);
  assert.ok(tarBytes.length > 0, 'decompressed tar has content');
  assert.ok(result.compressedBytes > 0);
  assert.ok(result.originalBytes > 0);
});

test('collect: with query → runs query loop before requesting bundle', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager, executeRawCalls } = mockManager({});
  const service = new SupportBundleService(manager, noopLogger());
  stubSaveDialog(tmpDir);

  // Use a very short target so the loop finishes quickly
  const result = await service.collect('SELECT * FROM tasks', undefined, 0.001);
  assert.ok(result);
  assert.ok(result.queryExecutions > 0, 'query ran at least once');
  assert.ok(result.querySeconds > 0);

  // First calls are the query loop, last is the bundle request
  const bundleCallIndex = executeRawCalls.indexOf('EXECUTE FUNCTION system_request_support_bundle()');
  assert.ok(bundleCallIndex > 0, 'bundle request comes after query loop');
  assert.equal(executeRawCalls.length, bundleCallIndex + 1);
  // All calls before the bundle request are the user query
  for (let i = 0; i < bundleCallIndex; i++) {
    assert.equal(executeRawCalls[i], 'SELECT * FROM tasks');
  }
});

test('collect: save dialog cancelled → returns null, no file written', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();
  // Leave saveDialogResult as undefined → user cancelled

  const { manager } = mockManager({});
  const service = new SupportBundleService(manager, noopLogger());

  const result = await service.collect(undefined, undefined, 0.01);
  assert.equal(result, null);

  const files = await fs.readdir(tmpDir);
  assert.equal(files.length, 0);
});

test('collect: bundle request returning empty rows throws', async () => {
  resetStub();
  const { manager } = mockManager({});
  // Override executeRaw to return empty for the bundle request
  const origExecuteRaw = manager.executeRaw.bind(manager);
  (manager as unknown as Record<string, unknown>).executeRaw = async (query: string) => {
    if (query === 'EXECUTE FUNCTION system_request_support_bundle()') { return []; }
    return origExecuteRaw(query);
  };

  const service = new SupportBundleService(manager, noopLogger());
  await assert.rejects(
    () => service.collect(undefined, undefined, 0.01),
    /no result/i,
  );
});

test('collect: bundle doc without file attachment throws', async () => {
  resetStub();
  const { manager } = mockManager({
    bundleDoc: { _id: 'x', reason: 'USER_INITIATED' }, // no file
  });
  const service = new SupportBundleService(manager, noopLogger());
  await assert.rejects(
    () => service.collect(undefined, undefined, 0.01),
    /no file attachment/i,
  );
});

test('collect: no active connection for attachment fetch throws', async () => {
  resetStub();
  const { manager } = mockManager({ fetchNull: true });

  const service = new SupportBundleService(manager, noopLogger());
  await assert.rejects(
    () => service.collect(undefined, undefined, 0.01),
    /no active database/i,
  );
});

test('collect: progress reporter receives updates', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager } = mockManager({});
  const service = new SupportBundleService(manager, noopLogger());
  stubSaveDialog(tmpDir);

  const messages: string[] = [];
  const progress = { report: (msg: string) => messages.push(msg) };

  await service.collect('SELECT 1', progress, 0.001);
  assert.ok(messages.length > 0, 'progress was reported');
  assert.ok(messages.some(m => m.includes('trace data')), 'trace phase reported');
  assert.ok(messages.some(m => m.includes('support bundle')), 'bundle phase reported');
  assert.ok(messages.some(m => m.includes('Downloading')), 'download phase reported');
  assert.ok(messages.some(m => m.includes('Compressing')), 'compress phase reported');
});

test('collect: saved file contains valid tar with dial9 entry', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const dial9Content = zlib.gzipSync(Buffer.from('fake dial9 trace'));
  const tarBytes = createTarBytes({
    'dial9/dial9.bin.gz': dial9Content,
    'logs/ditto.log': Buffer.from('log content'),
  });

  const { manager } = mockManager({ attachmentBytes: tarBytes });
  const service = new SupportBundleService(manager, noopLogger());
  const savedPath = stubSaveDialog(tmpDir);

  const result = await service.collect(undefined, undefined, 0.01);
  assert.ok(result);

  // Verify the saved file is a valid .tar.gz
  const gzBytes = await fs.readFile(savedPath);
  const extracted = await gunzip(gzBytes);
  assert.deepEqual(extracted, tarBytes, 'round-trip preserves the original tar');
});
