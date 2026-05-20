import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuickstartService } from '../quickstart/QuickstartService.js';
import type { Logger, LogLevel } from '../logging/types.js';

function makeStubLogger(): Logger {
  const noop: any = () => {};
  const logger: any = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop,
    withTag: () => logger,
    getChannelLevel: (): LogLevel => 'info',
    setChannelLevel: noop,
    onDidChangeChannelLevel: () => ({ dispose: noop }),
  };
  return logger as Logger;
}

function failingGit(): never {
  throw new Error('GitRunner.run should not be called in this test');
}
const stubGit = { run: failingGit, version: async () => null as string | null };

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

const EXPECTED_ENV =
  '#!/usr/bin/env bash\n' +
  '\n' +
  '# Auto-configured by Edge Studio\n' +
  'DITTO_APP_ID="abc-123"\n' +
  'DITTO_PLAYGROUND_TOKEN="tok-456"\n' +
  'DITTO_AUTH_URL="https://auth.example"\n' +
  'DITTO_WEBSOCKET_URL="wss://ws.example"';

test('writeEnvFiles writes root .env and per-project .env where parent exists', () => {
  const root = tmpdir('qs-env-');
  try {
    // Create flutter_app/ but NOT go-tui/
    fs.mkdirSync(path.join(root, 'flutter_app'));

    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const results = svc.writeEnvFiles(root, {
      databaseId: 'abc-123',
      token: 'tok-456',
      authUrl: 'https://auth.example',
      websocketUrl: 'wss://ws.example',
    });

    assert.equal(results.length, 3);
    const byPath = new Map(results.map((r) => [r.path, r]));

    // Root .env written
    const rootEnvPath = path.join(root, '.env');
    assert.equal(byPath.get(rootEnvPath)?.outcome, 'written');
    assert.equal(fs.readFileSync(rootEnvPath, 'utf-8'), EXPECTED_ENV);

    // flutter_app/.env written
    const flutterEnvPath = path.join(root, 'flutter_app', '.env');
    assert.equal(byPath.get(flutterEnvPath)?.outcome, 'written');
    assert.equal(fs.readFileSync(flutterEnvPath, 'utf-8'), EXPECTED_ENV);

    // go-tui/.env skipped — parent absent
    const goEnvPath = path.join(root, 'go-tui', '.env');
    assert.equal(byPath.get(goEnvPath)?.outcome, 'skipped-no-parent');
    assert.equal(fs.existsSync(goEnvPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeEnvFiles reports failed outcome and continues on write error', () => {
  const root = tmpdir('qs-env-fail-');
  try {
    // Create flutter_app/.env as a directory so the file write fails
    fs.mkdirSync(path.join(root, 'flutter_app'));
    fs.mkdirSync(path.join(root, 'flutter_app', '.env'));

    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const results = svc.writeEnvFiles(root, {
      databaseId: 'a', token: 'b', authUrl: 'c', websocketUrl: 'd',
    });

    const flutterResult = results.find((r) => r.path.endsWith(path.join('flutter_app', '.env')));
    assert.equal(flutterResult?.outcome, 'failed');

    // Root .env still got written
    const rootResult = results.find((r) => r.path === path.join(root, '.env'));
    assert.equal(rootResult?.outcome, 'written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
