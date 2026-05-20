import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuickstartService } from '../quickstart/QuickstartService.js';
import type { GitRunner } from '../quickstart/QuickstartService.js';
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

const EXPECTED_YAML =
  'resources:\n' +
  '  my_ditto_db:\n' +
  '    resource_type: DittoDatabase\n' +
  '    db_id: "abc-123"\n' +
  '    device_name: "edge-studio-quickstart"\n' +
  '    subscriptions:\n' +
  '      - "SELECT * FROM tasks"\n' +
  '    auth:\n' +
  '      server:\n' +
  '        access_token: "tok-456"\n' +
  '        auth_url: "https://auth.example"\n' +
  '        provider: "__playgroundProvider"\n' +
  '  my_http_server:\n' +
  '    resource_type: HttpServer\n' +
  '    listen_addr: "0.0.0.0:8080"\n' +
  '    databases:\n' +
  '      my_db:\n' +
  '        db_id: "abc-123"\n' +
  '        base_path: my_server\n' +
  '        http_api: true';

test('writeEdgeServerYaml writes config when edge-server/ exists', () => {
  const root = tmpdir('qs-yaml-');
  try {
    fs.mkdirSync(path.join(root, 'edge-server'));
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = svc.writeEdgeServerYaml(root, {
      databaseId: 'abc-123', token: 'tok-456', authUrl: 'https://auth.example',
    });
    assert.equal(result.outcome, 'written');
    const written = fs.readFileSync(path.join(root, 'edge-server', 'quickstart_config.yaml'), 'utf-8');
    assert.equal(written, EXPECTED_YAML);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeEdgeServerYaml skips when edge-server/ is absent', () => {
  const root = tmpdir('qs-yaml-absent-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = svc.writeEdgeServerYaml(root, {
      databaseId: 'a', token: 'b', authUrl: 'c',
    });
    assert.equal(result.outcome, 'skipped-no-parent');
    assert.equal(fs.existsSync(path.join(root, 'edge-server', 'quickstart_config.yaml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — absent', async () => {
  const root = tmpdir('qs-inspect-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(path.join(root, 'quickstart'));
    assert.equal(result.kind, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — non-git folder', async () => {
  const root = tmpdir('qs-inspect-nongit-');
  try {
    fs.mkdirSync(path.join(root, 'quickstart'));
    fs.writeFileSync(path.join(root, 'quickstart', 'README.md'), 'mine');
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(path.join(root, 'quickstart'));
    assert.equal(result.kind, 'non-git-folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — git checkout reports head sha', async () => {
  const root = tmpdir('qs-inspect-git-');
  try {
    const target = path.join(root, 'quickstart');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    fs.writeFileSync(path.join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const gitStub: GitRunner = {
      version: async () => 'git version 2.45.0',
      run: async (args, cwd) => {
        assert.deepEqual(args, ['rev-parse', 'HEAD']);
        assert.equal(cwd, target);
        return 0;
      },
    };
    const svc = new QuickstartService(makeStubLogger(), gitStub);
    const result = await svc.inspectTarget(target);
    assert.equal(result.kind, 'git-checkout');
    // Narrowing the discriminated union — only here do we get `.head`.
    if (result.kind === 'git-checkout') {
      assert.equal(result.head, 'ref: refs/heads/main');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isGitAvailable — returns true when GitRunner.version resolves to a string', async () => {
  const gitStub: GitRunner = {
    version: async () => 'git version 2.45.0',
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), true);
});

test('isGitAvailable — returns false when GitRunner.version resolves to null', async () => {
  const gitStub: GitRunner = {
    version: async () => null,
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), false);
});

test('isGitAvailable — returns false when GitRunner.version throws', async () => {
  const gitStub: GitRunner = {
    version: async () => { throw new Error('ENOENT'); },
    run: async () => 0,
  };
  const svc = new QuickstartService(makeStubLogger(), gitStub);
  assert.equal(await svc.isGitAvailable(), false);
});
