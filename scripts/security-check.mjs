#!/usr/bin/env node
// One command that runs everything from the security-tooling checklist
// (docs/Developer.md → "Security release checklist"), so a dev — or the AI
// coding tools that write a lot of this codebase's diffs — can check before
// pushing instead of waiting on CI or GitHub's own scanners to catch it.
//
// npm-native checks (audit, knip, license-check) always run — every Node
// environment has npx. The external-binary checks (gitleaks, semgrep,
// actionlint, zizmor) are best-effort locally: if a tool isn't installed,
// this warns with an install hint and skips it rather than failing, since
// not every contributor has Go/Python/uv on their machine. CI installs all
// four explicitly and does not skip (see .github/workflows/security.yml).

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GH_TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout?.trim();

function commandExists(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...opts.env } });
  if (result.error?.code === 'ENOENT') {
    console.log(`skipped — '${cmd}' not installed.${opts.installHint ? ` ${opts.installHint}` : ''}`);
    return 'skipped';
  }
  return result.status === 0 ? 'pass' : 'fail';
}

const results = [];

results.push(['npm audit (production deps)', run('npm audit', 'npm', ['run', 'audit'])]);
results.push(['eslint (incl. security / no-unsanitized)', run('eslint', 'npm', ['run', 'lint'])]);
results.push(['knip (dead code / unused deps)', run('knip', 'npm', ['run', 'knip'])]);
results.push(['license-checker (production deps)', run('license-checker', 'npm', ['run', 'license-check'])]);

if (commandExists('gitleaks')) {
  results.push(['gitleaks (full history)', run(
    'gitleaks', 'gitleaks', ['detect', '--source', '.', '--redact', '--config', '.gitleaks.toml'],
  )]);
} else {
  console.log('\n── gitleaks ─────────────────────────────────────────────');
  console.log('skipped — not installed. Install: brew install gitleaks (see README).');
  results.push(['gitleaks (full history)', 'skipped']);
}

if (commandExists('semgrep')) {
  results.push(['semgrep', run('semgrep', 'semgrep', [
    '--config', 'p/security-audit', '--config', 'p/typescript',
    '--config', 'p/javascript', '--config', 'p/owasp-top-ten',
    '--metrics=off', '--error', '--quiet', 'src/', 'webview-ui/',
  ])]);
} else {
  console.log('\n── semgrep ──────────────────────────────────────────────');
  console.log('skipped — not installed. Install: brew install semgrep (or pipx install semgrep).');
  results.push(['semgrep', 'skipped']);
}

if (commandExists('actionlint')) {
  results.push(['actionlint', run('actionlint', 'actionlint', [])]);
} else {
  console.log('\n── actionlint ───────────────────────────────────────────');
  console.log('skipped — not installed. Install: brew install actionlint.');
  results.push(['actionlint', 'skipped']);
}

if (commandExists('uvx')) {
  results.push(['zizmor (GitHub Actions)', run('zizmor', 'uvx', [
    'zizmor', '--min-severity', 'medium', '.github/workflows/',
  ], { env: GH_TOKEN ? { GH_TOKEN } : {} })]);
} else {
  console.log('\n── zizmor ───────────────────────────────────────────────');
  console.log('skipped — uv/uvx not installed. Install: brew install uv (see https://docs.astral.sh/uv).');
  results.push(['zizmor (GitHub Actions)', 'skipped']);
}

console.log('\n' + '═'.repeat(62));
console.log('Security check summary');
console.log('═'.repeat(62));
const width = Math.max(...results.map(([label]) => label.length));
for (const [label, status] of results) {
  const marker = { pass: '✓', fail: '✗', skipped: '·' }[status];
  console.log(`  ${marker} ${label.padEnd(width)}  ${status}`);
}

const failed = results.filter(([, status]) => status === 'fail');
if (failed.length > 0) {
  console.log(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll runnable checks passed.');
