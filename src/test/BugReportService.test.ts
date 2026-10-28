import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import { window } from 'vscode';

import { BugReportService } from '../bugreport/BugReportService.js';
import { crc32 } from '../bugreport/zip.js';
import type { DittoManager } from '../ditto/DittoManager.js';
import type { Logger } from '../logging/types.js';

/**
 * The bug-report export: application log + SDK support bundle packed into
 * one zip at a user-chosen location, degrading to a log-only zip (with the
 * reason in the README) when disconnected or when bundle collection fails.
 * The zip is parsed back with an independent minimal reader rather than the
 * writer's helpers — the writer's own round-trip coverage lives in
 * zip.test.ts.
 */

const noopLogger = (): Logger => {
  const self = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {},
    withTag: () => self,
  } as unknown as Logger;
  return self;
};

const APP_LOG = '2026-10-28T09:00:00Z [info] first line\n2026-10-28T09:01:00Z [warn] second line\n';

/** Minimal tar, same shape as SupportBundleService.test.ts's fixture. */
function fakeBundleTar(): Buffer {
  const data = Buffer.from('fake bundle payload '.repeat(50));
  const header = Buffer.alloc(512);
  header.write('bundle.bin', 0, 'utf-8');
  header.write('0000644\0', 100, 8);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('        ', 148, 8);
  header.write('0', 156, 1);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i]!;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const remainder = data.length % 512;
  return Buffer.concat([header, data, Buffer.alloc(remainder === 0 ? 0 : 512 - remainder), Buffer.alloc(1024)]);
}

function mockManager(opts: { connected?: boolean; bundleFails?: boolean } = {}) {
  const connected = opts.connected ?? true;
  const executeRawCalls: string[] = [];
  const tarBytes = fakeBundleTar();
  const manager = {
    getActiveConfigId: () => (connected ? 'cfg-1' : null),
    executeRaw: async (query: string) => {
      executeRawCalls.push(query);
      if (opts.bundleFails) {
        throw new Error('support bundle rate limit exceeded');
      }
      return [{
        _id: { pk: 'abc' },
        file: { id: 'att-1', len: tarBytes.length, metadata: {} },
      }];
    },
    fetchAttachment: () => Promise.resolve({
      copyToPath: async (destPath: string) => { await fs.writeFile(destPath, tarBytes); },
    }),
  } as unknown as DittoManager;
  return { manager, executeRawCalls, tarBytes };
}

function makeService(manager: DittoManager): BugReportService {
  return new BugReportService({
    manager,
    logger: noopLogger(),
    readAllLogs: async () => APP_LOG,
    extensionVersion: '0.9.6',
    sdkVersion: '5.2.0',
  });
}

/** Stub the save dialog to accept a path inside `dir`; returns the path. */
async function stubSaveDialog(dir: string): Promise<string> {
  const target = path.join(dir, 'bug-report.zip');
  (window as unknown as Record<string, unknown>).saveDialogResult = { fsPath: target };
  return target;
}

function resetStub() {
  (window as unknown as Record<string, unknown>).saveDialogResult = undefined;
  (window as unknown as Record<string, unknown>).lastSaveDialogOptions = undefined;
}

/** Extract every entry of a written zip as name → bytes, checking CRCs. */
async function extractAll(zip: Buffer): Promise<Map<string, Buffer>> {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'valid EOCD');
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    const local = zip.readUInt32LE(pos + 42);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    assert.equal(crc32(data), crc, `${name}: stored CRC matches the extracted bytes`);
    out.set(name, data);
    pos += 46 + nameLen;
  }
  return out;
}

test('bug report: connected — zip packs README, application log, and the support bundle', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager, executeRawCalls, tarBytes } = mockManager();
  const target = await stubSaveDialog(tmpDir);

  const result = await makeService(manager).export();
  assert.ok(result, 'export succeeded');
  assert.equal(result.savedPath, target);
  assert.equal(result.includedSupportBundle, true);
  assert.equal(result.bundleNote, null);
  assert.deepEqual(executeRawCalls, ['EXECUTE FUNCTION system_request_support_bundle()'],
    'no query loop — the bundle is captured as-is');

  const zip = await fs.readFile(target);
  assert.equal(result.totalBytes, zip.length);
  const entries = await extractAll(zip);
  assert.deepEqual([...entries.keys()], ['README.txt', 'application.log', 'support-bundle.tar.gz']);

  assert.equal(entries.get('application.log')!.toString('utf8'), APP_LOG,
    'the application log lands in the zip verbatim');
  assert.deepEqual(zlib.gunzipSync(entries.get('support-bundle.tar.gz')!), tarBytes,
    'the stored bundle gunzips back to the fetched tar');

  const readme = entries.get('README.txt')!.toString('utf8');
  assert.match(readme, /Extension version: 0\.9\.6/);
  assert.match(readme, /Ditto SDK version: 5\.2\.0/);
  assert.match(readme, /VS Code: 1\.106\.0-stub/);
  assert.match(readme, /support-bundle\.tar\.gz — Ditto SDK support bundle/);
  assert.match(readme, /Review before sharing/, 'privacy note is packed with the archive');
});

test('bug report: no active connection — log-only zip with the reason in the README', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager, executeRawCalls } = mockManager({ connected: false });
  await stubSaveDialog(tmpDir);

  const result = await makeService(manager).export();
  assert.ok(result, 'export still succeeds without a connection');
  assert.equal(result.includedSupportBundle, false);
  assert.match(result.bundleNote ?? '', /no active database connection/);
  assert.equal(executeRawCalls.length, 0, 'no bundle request attempted');

  const entries = await extractAll(await fs.readFile(result.savedPath));
  assert.deepEqual([...entries.keys()], ['README.txt', 'application.log'],
    'the zip holds the log alone');
  assert.match(entries.get('README.txt')!.toString('utf8'),
    /Support bundle: NOT INCLUDED — no active database connection/);
});

test('bug report: bundle collection failure — log-only zip, failure recorded and reported', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();

  const { manager } = mockManager({ bundleFails: true });
  await stubSaveDialog(tmpDir);

  const result = await makeService(manager).export();
  assert.ok(result, 'a failed bundle must not sink the whole export');
  assert.equal(result.includedSupportBundle, false);
  assert.match(result.bundleNote ?? '', /support bundle collection failed: support bundle rate limit exceeded/);

  const entries = await extractAll(await fs.readFile(result.savedPath));
  assert.deepEqual([...entries.keys()], ['README.txt', 'application.log']);
  assert.match(entries.get('README.txt')!.toString('utf8'),
    /NOT INCLUDED — support bundle collection failed: support bundle rate limit exceeded/,
    'the README tells the support engineer exactly why the bundle is missing');
});

test('bug report: cancelling the save dialog discards the export and writes nothing', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub(); // saveDialogResult undefined = user cancelled

  const { manager } = mockManager();
  const result = await makeService(manager).export();
  assert.equal(result, null);
  assert.deepEqual(await fs.readdir(tmpDir), [], 'no file was written');
});

test('bug report: the save dialog suggests a timestamped zip name with a zip filter', async t => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'br-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  resetStub();
  await stubSaveDialog(tmpDir);

  const { manager } = mockManager();
  await makeService(manager).export();

  const opts = (window as unknown as { lastSaveDialogOptions: {
    defaultUri: { fsPath: string };
    filters: Record<string, string[]>;
    saveLabel: string;
  } }).lastSaveDialogOptions;
  assert.match(opts.defaultUri.fsPath, /ditto-bug-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/,
    'suggested name is timestamped and .zip');
  assert.deepEqual(opts.filters, { 'Zip archives': ['zip'] });
});
