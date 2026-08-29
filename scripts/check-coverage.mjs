#!/usr/bin/env node
// Coverage gate: node:test's built-in V8 coverage only reports files the test
// run LOADED — files never imported vanish from the denominator, which makes
// "90% coverage" claims hollow. This script reconciles the report against the
// real source tree so the gate is over ALL runtime files.
//
// Definition (see PR discussion):
//   line coverage = covered lines / physical lines, over every .ts file under
//   src/ and webview-ui/ except tests and the documented exclusions below.
//   Loaded files contribute (totalLines - uncoveredLines from the report);
//   never-loaded files contribute 0 covered.
//
// Threshold: 85% lines (override with --threshold=N).
//
// Exclusions, each documented inline — keeping this list honest is a review
// duty: every entry must be type-only, host-bound, or bootstrap code.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files excluded from the denominator, with the reason each is excluded. */
const EXCLUSIONS = [
  // Activation entry point — requires a real Extension Host; exercised by the
  // integration suite (src/test/integration) instead.
  'src/extension.ts',
  // Type-only modules: erased at compile time, nothing executable to cover.
  'src/ipc/messages.ts',
  'src/models/DittoCollection.ts',
  'src/models/DittoConfig.ts',
  'src/models/StoredObserver.ts',
  'src/ditto/QueryProfile.ts',
  'src/logAnalyzer/types.ts',
  'src/logging/Sink.ts',
  'src/tree/DatabaseTreeItem.ts',
];
/** Whole-directory prefixes excluded (webview bootstraps register elements at
 *  import; they are smoke-tested but excluded from the gate per the agreed
 *  definition). */
const EXCLUDED_PREFIXES = [
  /^webview-ui\/[^/]+\/main\.ts$/,
];

function listSources(dir, prefix) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel === 'src/test') continue;
      out.push(...listSources(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(rel);
    }
  }
  return out;
}

const loadList = [...listSources(path.join(ROOT, 'src'), 'src'),
                  ...listSources(path.join(ROOT, 'webview-ui'), 'webview-ui')]
  .filter(f => !EXCLUSIONS.includes(f) && !EXCLUDED_PREFIXES.some(re => re.test(f)));

// ─── Run the suite with coverage ────────────────────────────────
const report = execFileSync('node', [
  '--import', 'tsx',
  '--import', './scripts/register-vscode-stub.mjs',
  '--test', '--experimental-test-coverage',
  'src/test/*.test.ts', 'src/test/webview/*.test.ts',
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

// ─── Parse the nested text report ───────────────────────────────
// Format: "ℹ" (Node 23+/24) or "#" (Node 22) + depth spaces + name + padding
// + | line% | branch% | func% | uncovered-ranges
const ROW_PREFIX = /^(?:ℹ|#)(\s+)(\S[^|]*?)\s*\|/;
const rows = new Map(); // full path → { pct, uncovered: number }
const stack = [];
for (const line of report.split('\n')) {
  const m = line.match(ROW_PREFIX);
  if (!m) continue;
  const indent = m[1].length;
  const name = m[2].trim();
  if (name === 'file' || /^-+$/.test(name) || name === 'all files') continue;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  if (name.endsWith('.ts')) {
    const file = [...stack.map(s => s.name), name].join('/');
    // Data row cells: | line% | branch% | func% | space-separated uncovered ranges
    const cells = line.split('|').slice(1);
    const pct = Number(cells[0]);
    let uncovered = 0;
    const rangeText = cells[3] ?? '';
    for (const tok of rangeText.trim().split(/\s+/).filter(Boolean)) {
      const [a, b] = tok.split('-').map(Number);
      uncovered += (b ?? a) - a + 1;
    }
    rows.set(file, { pct, uncovered });
  } else {
    stack.push({ indent, name });
  }
}

// ─── Reconcile against the full load list ───────────────────────
let covered = 0;
let total = 0;
const worst = [];
const neverLoaded = [];
for (const file of loadList) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
  const row = rows.get(file);
  const fileCovered = row ? lines - row.uncovered : 0;
  covered += fileCovered;
  total += lines;
  if (!row) neverLoaded.push(file);
  const pct = (fileCovered / lines) * 100;
  worst.push({ file, pct, lines });
}
worst.sort((a, b) => a.pct - b.pct);

const threshold = Number((process.argv.find(a => a.startsWith('--threshold=')) ?? '--threshold=85').split('=')[1]);

if (rows.size === 0) {
  console.error('FAIL: no file rows parsed from the coverage report — the node:test coverage text format is not what this parser expects (Node version drift?).');
  process.exit(2);
}

const pct = (covered / total) * 100;

console.log(`\nCoverage gate: ${pct.toFixed(2)}% lines over ${loadList.length} runtime files (${covered}/${total} lines) — threshold ${threshold}%`);
if (neverLoaded.length > 0) {
  console.log(`\nNever loaded by any test (${neverLoaded.length}) — each counts as 0%:`);
  for (const f of neverLoaded) console.log(`  ${f}`);
}
console.log('\nLowest-covered files:');
for (const w of worst.slice(0, 12)) console.log(`  ${w.pct.toFixed(1).padStart(5)}%  ${w.file}`);
console.log(`\nExclusions (${EXCLUSIONS.length} files + webview main.ts bootstraps) are listed with reasons in scripts/check-coverage.mjs.`);

if (pct < threshold) {
  console.error(`\nFAIL: ${pct.toFixed(2)}% < ${threshold}%`);
  process.exit(1);
}
console.log('\nPASS');
