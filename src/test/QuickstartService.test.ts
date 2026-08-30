import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuickstartService, createNodeGitRunner } from '../quickstart/QuickstartService.js';
import type { GitRunner } from '../quickstart/QuickstartService.js';
import { QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME } from '../quickstart/quickstart-projects.js';
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

test('writeEnvFiles escapes quotes and backslashes inside the token', () => {
  // A token with `"` or `\` would otherwise break out of the double-quoted
  // env assignment and corrupt (or weaponise) the generated file.
  const root = tmpdir('qs-env-esc-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    svc.writeEnvFiles(root, {
      databaseId: 'abc-123',
      token: 'tok"with\\meta',
      authUrl: 'https://auth.example',
      websocketUrl: 'wss://ws.example',
    });
    const content = fs.readFileSync(path.join(root, '.env'), 'utf-8');
    assert.ok(
      content.includes('DITTO_PLAYGROUND_TOKEN="tok\\"with\\\\meta"'),
      `escaped token not found in:\n${content}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeEdgeServerYaml escapes quotes and backslashes inside the token', () => {
  const root = tmpdir('qs-yaml-esc-');
  try {
    fs.mkdirSync(path.join(root, 'edge-server'));
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    svc.writeEdgeServerYaml(root, {
      databaseId: 'abc-123', token: 'a"b\\c', authUrl: 'https://auth.example',
    });
    const written = fs.readFileSync(path.join(root, 'edge-server', 'quickstart_config.yaml'), 'utf-8');
    assert.ok(written.includes('access_token: "a\\"b\\\\c"'), `escaped token not found in:\n${written}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a newline in any interpolated value is refused outright', () => {
  // A newline can't be neutralised by escaping — it jump-starts another env
  // assignment / YAML line, so we throw instead of writing a corrupted file.
  const root = tmpdir('qs-env-nl-');
  try {
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    assert.throws(() => svc.writeEnvFiles(root, {
      databaseId: 'abc', token: 'tok\nMALICIOUS=1', authUrl: 'x', websocketUrl: 'y',
    }), /newline/);
    assert.equal(fs.existsSync(path.join(root, '.env')), false, 'no file written on refusal');

    fs.mkdirSync(path.join(root, 'edge-server'));
    // The YAML writer reports failures as a result object rather than
    // throwing (its whole contract is "try, and tell the flow controller"),
    // so the refusal surfaces as a failed write that names the cause.
    const result = svc.writeEdgeServerYaml(root, {
      databaseId: 'abc', token: 'x', authUrl: 'x\nfoo: bar',
    });
    assert.equal(result.outcome, 'failed');
    if (result.outcome === 'failed') { assert.match(result.error, /newline/); }
    assert.equal(
      fs.existsSync(path.join(root, 'edge-server', 'quickstart_config.yaml')), false,
      'no file written on refusal',
    );
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

interface RecordedCall {
  args: string[];
  cwd: string | null;
}

function recordingGit(exitCode = 0): { git: GitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const git: GitRunner = {
    version: async () => 'git version 2.45.0',
    run: async (args, cwd) => {
      calls.push({ args, cwd });
      return exitCode;
    },
  };
  return { git, calls };
}

test('cloneOrPull fresh-clone runs `git clone` into the parent dir', async () => {
  const parent = tmpdir('qs-clone-');
  try {
    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'fresh-clone', () => {}, ac.signal);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME]);
    assert.equal(calls[0]?.cwd, parent);
    assert.equal(result.repoRoot, path.join(parent, QUICKSTART_FOLDER_NAME));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull pull-existing runs `git pull` inside the existing checkout', async () => {
  const parent = tmpdir('qs-pull-');
  try {
    fs.mkdirSync(path.join(parent, QUICKSTART_FOLDER_NAME, '.git'), { recursive: true });
    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'pull-existing', () => {}, ac.signal);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['pull', '--ff-only']);
    assert.equal(calls[0]?.cwd, path.join(parent, QUICKSTART_FOLDER_NAME));
    assert.equal(result.repoRoot, path.join(parent, QUICKSTART_FOLDER_NAME));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull replace-and-clone removes existing folder then clones', async () => {
  const parent = tmpdir('qs-replace-');
  try {
    const target = path.join(parent, QUICKSTART_FOLDER_NAME);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'stale.txt'), 'stale');

    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    const ac = new AbortController();
    const result = await svc.cloneOrPull(parent, 'replace-and-clone', () => {}, ac.signal);

    // Stale file gone before clone ran
    assert.equal(fs.existsSync(path.join(target, 'stale.txt')), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME]);
    assert.equal(result.repoRoot, target);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull throws on non-zero git exit', async () => {
  const parent = tmpdir('qs-clone-fail-');
  try {
    const { git } = recordingGit(128);
    const svc = new QuickstartService(makeStubLogger(), git);
    await assert.rejects(
      () => svc.cloneOrPull(parent, 'fresh-clone', () => {}, new AbortController().signal),
      /git clone failed with exit 128/,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull pull-existing throws a fast-forward-specific error on non-zero exit', async () => {
  const parent = tmpdir('qs-pull-fail-');
  try {
    fs.mkdirSync(path.join(parent, QUICKSTART_FOLDER_NAME, '.git'), { recursive: true });
    const { git } = recordingGit(1);
    const svc = new QuickstartService(makeStubLogger(), git);
    await assert.rejects(
      () => svc.cloneOrPull(parent, 'pull-existing', () => {}, new AbortController().signal),
      /git pull failed with exit 1 \(fast-forward refused; checkout may be dirty or diverged\)/,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull rejects an unimplemented mode', async () => {
  const parent = tmpdir('qs-mode-');
  try {
    const { git, calls } = recordingGit(0);
    const svc = new QuickstartService(makeStubLogger(), git);
    await assert.rejects(
      () => svc.cloneOrPull(
        parent, 'shallow-clone' as never, () => {}, new AbortController().signal,
      ),
      /cloneOrPull mode not implemented: shallow-clone/,
    );
    assert.equal(calls.length, 0, 'no git invocation for an unknown mode');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('cloneOrPull forwards the last non-empty stderr line as progress', async () => {
  const parent = tmpdir('qs-progress-');
  try {
    // Git streams progress on stderr, \r- or \n-separated, with blank fragments
    // at chunk boundaries. Only the last non-empty line is a status update.
    const git: GitRunner = {
      version: async () => 'git version 2.45.0',
      run: async (_args, _cwd, onStderr) => {
        onStderr('Cloning into \'getstarted\'...\r\n');
        onStderr('Receiving objects:  12% (50/416)\r\nReceiving objects:  34% (142/416)\n');
        onStderr('\n\n');
        return 0;
      },
    };
    const svc = new QuickstartService(makeStubLogger(), git);
    const progress: string[] = [];
    await svc.cloneOrPull(parent, 'fresh-clone', (m) => { progress.push(m); },
      new AbortController().signal);

    assert.deepEqual(progress, [
      'Cloning into \'getstarted\'...',
      'Receiving objects:  34% (142/416)',
    ], 'blank-only chunks produce no update');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('inspectTarget — a plain file at the target path is a non-git-folder', async () => {
  const root = tmpdir('qs-inspect-file-');
  try {
    const target = path.join(root, 'quickstart');
    fs.writeFileSync(target, 'I am a file, not a directory');
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(target);
    assert.equal(result.kind, 'non-git-folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — a git checkout without a HEAD file reports head "unknown"', async () => {
  const root = tmpdir('qs-inspect-nohead-');
  try {
    const target = path.join(root, 'quickstart');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(target);
    assert.equal(result.kind, 'git-checkout');
    if (result.kind === 'git-checkout') {
      assert.equal(result.head, 'unknown', 'a missing HEAD is best-effort, not fatal');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectTarget — an unreadable HEAD file still reports the checkout', async () => {
  const root = tmpdir('qs-inspect-badhead-');
  try {
    const target = path.join(root, 'quickstart');
    // A directory named HEAD makes readFileSync throw (EISDIR) — the catch
    // leaves head as 'unknown' instead of failing the inspection.
    fs.mkdirSync(path.join(target, '.git', 'HEAD'), { recursive: true });
    const svc = new QuickstartService(makeStubLogger(), stubGit);
    const result = await svc.inspectTarget(target);
    assert.equal(result.kind, 'git-checkout');
    if (result.kind === 'git-checkout') {
      assert.equal(result.head, 'unknown');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── createNodeGitRunner (real child_process) ──────────────────
//
// These spawn the real `git` binary — no repo needed. Git is present on the
// dev machines and CI runners this suite targets; where it is not, the
// version probe test skips rather than fails.

test('createNodeGitRunner version() reports the installed git', async (t) => {
  const runner = createNodeGitRunner();
  const v = await runner.version();
  if (v === null) {
    t.skip('git is not on PATH in this environment');
    return;
  }
  assert.match(v, /^git version \d+\./);
});

test('createNodeGitRunner version() resolves null when git cannot be spawned', async () => {
  // Emptying PATH makes the spawn fail with ENOENT, which must surface as
  // null (not a rejection) so the flow controller can offer remediation.
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    const runner = createNodeGitRunner();
    assert.equal(await runner.version(), null);
  } finally {
    process.env.PATH = saved;
  }
});

test('createNodeGitRunner run() resolves the exit code and forwards stderr', async () => {
  const runner = createNodeGitRunner();
  const chunks: string[] = [];
  // A bogus subcommand: exits non-zero and explains itself on stderr.
  const exit = await runner.run(['definitely-not-a-git-subcommand'], null,
    (c) => { chunks.push(c); }, new AbortController().signal);

  assert.notEqual(exit, 0, 'a bogus subcommand fails');
  assert.ok(
    chunks.join('').includes('definitely-not-a-git-subcommand'),
    `stderr was forwarded; saw: ${JSON.stringify(chunks)}`,
  );
});

test('createNodeGitRunner run() resolves 0 for a successful command', async (t) => {
  const runner = createNodeGitRunner();
  if (await runner.version() === null) {
    t.skip('git is not on PATH in this environment');
    return;
  }
  const exit = await runner.run(['--version'], null, () => {}, new AbortController().signal);
  assert.equal(exit, 0);
});

test('createNodeGitRunner run() rejects when the working directory does not exist', async () => {
  // spawn() reports a bad cwd via the child's 'error' event; the runner must
  // reject rather than leak a pending Promise.
  const runner = createNodeGitRunner();
  await assert.rejects(
    runner.run(['--version'], path.join(os.tmpdir(), 'qs-no-such-dir-9f8e7d6c'), () => {},
      new AbortController().signal),
    /ENOENT/,
  );
});

test('createNodeGitRunner run() rejects when spawn itself throws synchronously', async () => {
  // A malformed signal makes spawn() throw in the call frame; without the
  // guard the returned Promise would leak pending forever.
  const runner = createNodeGitRunner();
  await assert.rejects(
    runner.run(['--version'], null, () => {}, {} as AbortSignal),
    (err: unknown) => err instanceof Error && /AbortSignal/.test(err.message),
  );
});
