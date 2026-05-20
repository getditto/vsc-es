import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../logging/types.js';
import {
  ENV_DESTINATIONS,
  EDGE_SERVER_RELATIVE_DIR,
  EDGE_SERVER_YAML_NAME,
  QUICKSTART_REPO_URL,
  QUICKSTART_FOLDER_NAME,
} from './quickstart-projects.js';

/** Values written to each .env file. */
export interface EnvValues {
  databaseId: string;
  token: string;
  authUrl: string;
  /** May be empty for newer Portal configs — written as the empty string. */
  websocketUrl: string;
}

/** Values written to the edge-server YAML — same minus websocketUrl. */
export type EdgeServerValues = Omit<EnvValues, 'websocketUrl'>;

export type WriteResult =
  | { path: string; outcome: 'written' }
  | { path: string; outcome: 'skipped-no-parent' }
  | { path: string; outcome: 'failed'; error: string };

export type TargetInspection =
  | { kind: 'absent' }
  | { kind: 'git-checkout'; head: string }
  | { kind: 'non-git-folder' };

export type CloneMode = 'fresh-clone' | 'pull-existing' | 'replace-and-clone';

/**
 * Abstraction over git invocation. Default implementation uses Node's
 * `child_process.spawn` with argument-array form (no shell). Tests inject
 * a stub.
 */
export interface GitRunner {
  /** Returns the trimmed `git --version` output, or null if git is missing. */
  version(): Promise<string | null>;

  /**
   * Runs `git <args>` with optional cwd. `onStderr` receives each chunk
   * decoded as UTF-8 (git emits progress on stderr). The promise resolves
   * to the exit code. Reject only on inability to spawn at all.
   */
  run(
    args: string[],
    cwd: string | null,
    onStderr: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<number>;
}

export class QuickstartService {
  constructor(
    private readonly log: Logger,
    private readonly git: GitRunner,
  ) {}

  /**
   * Writes `.env` to every destination in ENV_DESTINATIONS, skipping any
   * whose parent directory does not exist. File bytes match SwiftUI's
   * `QuickstartDownloadService.configureEnvFiles` exactly — see design doc.
   */
  writeEnvFiles(repoRoot: string, values: EnvValues): WriteResult[] {
    const content = renderEnvContent(values);
    return ENV_DESTINATIONS.map((rel) => this.writeOne(repoRoot, rel, content));
  }

  /**
   * Writes `edge-server/quickstart_config.yaml` when the edge-server
   * directory exists in the cloned repo. Content matches SwiftUI's
   * QuickstartDownloadService.configureEdgeServerYaml exactly.
   */
  writeEdgeServerYaml(repoRoot: string, values: EdgeServerValues): WriteResult {
    const dir = path.join(repoRoot, EDGE_SERVER_RELATIVE_DIR);
    const fullPath = path.join(dir, EDGE_SERVER_YAML_NAME);
    if (!fs.existsSync(dir)) {
      this.log.info('Quickstart: skipping edge-server YAML, dir missing', { dir });
      return { path: fullPath, outcome: 'skipped-no-parent' };
    }
    try {
      fs.writeFileSync(fullPath, renderEdgeServerYaml(values), { encoding: 'utf-8' });
      this.log.info('Quickstart: wrote edge-server YAML', { path: fullPath });
      return { path: fullPath, outcome: 'written' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.warn('Quickstart: edge-server YAML write failed', { path: fullPath, error });
      return { path: fullPath, outcome: 'failed', error };
    }
  }

  /**
   * Classify a would-be clone target. We detect a `.git` directory inline
   * (no git invocation needed) and only mark the directory as "git-checkout"
   * when that marker exists. Returns 'non-git-folder' for anything else —
   * the flow controller treats this as the dangerous case and prompts.
   */
  async inspectTarget(targetDir: string): Promise<TargetInspection> {
    if (!fs.existsSync(targetDir)) {
      return { kind: 'absent' };
    }
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return { kind: 'non-git-folder' };
    }
    const dotGit = path.join(targetDir, '.git');
    if (!fs.existsSync(dotGit)) {
      return { kind: 'non-git-folder' };
    }
    // Best-effort head sha — useful for the dialog text. Failure isn't fatal.
    let head = 'unknown';
    try {
      const headFile = path.join(dotGit, 'HEAD');
      if (fs.existsSync(headFile)) {
        head = fs.readFileSync(headFile, 'utf-8').trim();
      }
    } catch {
      /* leave as 'unknown' */
    }
    return { kind: 'git-checkout', head };
  }

  async isGitAvailable(): Promise<boolean> {
    try {
      const v = await this.git.version();
      return v !== null && v.length > 0;
    } catch (err) {
      this.log.warn('Quickstart: git version probe failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async cloneOrPull(
    parentDir: string,
    mode: CloneMode,
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<{ repoRoot: string }> {
    const repoRoot = path.join(parentDir, QUICKSTART_FOLDER_NAME);
    const onStderr = (chunk: string) => {
      // Git progress arrives on stderr (e.g. "Receiving objects: 12% …").
      // Forward the last non-empty line as a status string.
      const last = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0).pop();
      if (last) { onProgress(last.trim()); }
    };

    const runClone = async (): Promise<void> => {
      const exit = await this.git.run(
        ['clone', '--progress', QUICKSTART_REPO_URL, QUICKSTART_FOLDER_NAME],
        parentDir,
        onStderr,
        signal,
      );
      if (exit !== 0) { throw new Error(`git clone failed with exit ${exit}`); }
    };

    if (mode === 'fresh-clone') {
      await runClone();
      return { repoRoot };
    }

    if (mode === 'pull-existing') {
      const exit = await this.git.run(['pull', '--ff-only'], repoRoot, onStderr, signal);
      if (exit !== 0) {
        // Keep the error UI-agnostic — the flow controller composes the
        // user-facing remediation (e.g. "choose Replace"). Service-level
        // errors describe the technical condition only.
        throw new Error(
          `git pull failed with exit ${exit} (fast-forward refused; checkout may be dirty or diverged)`,
        );
      }
      return { repoRoot };
    }

    if (mode === 'replace-and-clone') {
      onProgress('Removing existing folder…');
      this.log.info('Quickstart: removing existing folder for replace-and-clone', { repoRoot });
      fs.rmSync(repoRoot, { recursive: true, force: true });
      await runClone();
      return { repoRoot };
    }

    throw new Error(`cloneOrPull mode not implemented: ${String(mode)}`);
  }

  private writeOne(repoRoot: string, relativePath: string, content: string): WriteResult {
    const fullPath = path.join(repoRoot, relativePath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      this.log.info('Quickstart: skipping .env, parent missing', { path: fullPath });
      return { path: fullPath, outcome: 'skipped-no-parent' };
    }
    try {
      fs.writeFileSync(fullPath, content, { encoding: 'utf-8' });
      this.log.info('Quickstart: wrote .env', { path: fullPath });
      return { path: fullPath, outcome: 'written' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.warn('Quickstart: .env write failed', { path: fullPath, error });
      return { path: fullPath, outcome: 'failed', error };
    }
  }
}

/**
 * Byte-exact reproduction of SwiftUI's envContent — no trailing newline,
 * single comment line credited to "Edge Studio" (the product name shared
 * by SwiftUI and VS Code editions).
 */
function renderEnvContent(v: EnvValues): string {
  return [
    '#!/usr/bin/env bash',
    '',
    '# Auto-configured by Edge Studio',
    `DITTO_APP_ID="${v.databaseId}"`,
    `DITTO_PLAYGROUND_TOKEN="${v.token}"`,
    `DITTO_AUTH_URL="${v.authUrl}"`,
    `DITTO_WEBSOCKET_URL="${v.websocketUrl}"`,
  ].join('\n');
}

function renderEdgeServerYaml(v: EdgeServerValues): string {
  return [
    'resources:',
    '  my_ditto_db:',
    '    resource_type: DittoDatabase',
    `    db_id: "${v.databaseId}"`,
    '    device_name: "edge-studio-quickstart"',
    '    subscriptions:',
    '      - "SELECT * FROM tasks"',
    '    auth:',
    '      server:',
    `        access_token: "${v.token}"`,
    `        auth_url: "${v.authUrl}"`,
    '        provider: "__playgroundProvider"',
    '  my_http_server:',
    '    resource_type: HttpServer',
    '    listen_addr: "0.0.0.0:8080"',
    '    databases:',
    '      my_db:',
    `        db_id: "${v.databaseId}"`,
    '        base_path: my_server',
    '        http_api: true',
  ].join('\n');
}
