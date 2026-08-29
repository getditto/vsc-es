#!/usr/bin/env node
// Generate synthetic NDJSON test data for the injector, sized by how long you
// intend to run it: --rate × --duration decides the document count.
//
//   node scripts/test-injector/generate-data.mjs --collection=orders --rate=4 --duration=15m
//   node scripts/test-injector/generate-data.mjs --collection=tasks --count=500 --seed=7
//
// Writes <out>.ndjson (one document per line — the same format the
// memory-benchmarks-compare datasets use, so those files work here too) plus a
// <collection>.meta.json next to it ({ current_date, preload_date, preload,
// stream, seed } — same shape as the benchmarks' meta files; preload is 0
// because generated data is all "stream").
//
// No pre-generated data is committed — generation is deterministic per --seed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMAS, makeRng, uuid } from './schemas.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    // Bare `--flag` counts as a boolean switch; `--key=value` as a value.
    if (eq > 2) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = 'true';
  }
  return out;
}

function parseDurationMs(s) {
  if (s.endsWith('ms')) return Number(s.slice(0, -2));
  if (s.endsWith('s')) return Number(s.slice(0, -1)) * 1000;
  if (s.endsWith('m')) return Number(s.slice(0, -1)) * 60_000;
  if (s.endsWith('h')) return Number(s.slice(0, -1)) * 3_600_000;
  return Number(s);
}

const args = parseArgs(process.argv);
if (process.argv.includes('--help')) {
  console.log(`Usage: node generate-data.mjs --collection=<${Object.keys(SCHEMAS).join('|')}>
                  [--rate=4] [--duration=15m] | [--count=N]
                  [--seed=42] [--out=path.ndjson]`);
  process.exit(0);
}

const schemaName = args.collection;
const schema = SCHEMAS[schemaName];
if (!schema) {
  console.error(`Unknown collection "${schemaName}". Pick one of: ${Object.keys(SCHEMAS).join(', ')}`);
  process.exit(1);
}

const rate = Number(args.rate ?? '4');
const durationMs = parseDurationMs(args.duration ?? '15m');
const count = args.count !== undefined
  ? Number(args.count)
  : Math.ceil((rate * durationMs) / 1000);
if (!Number.isInteger(count) || count <= 0) {
  console.error(`Computed document count must be a positive integer (got ${count}).`);
  process.exit(1);
}

const seed = Number(args.seed ?? '42');
const rng = makeRng(seed);
const out = args.out ?? path.join(DATA_DIR, `${schemaName}.ndjson`);

// Per-collection generator context (orders need a stable org/store per run).
const today = new Date();
const businessDate = today.toISOString().slice(0, 10);
const ctx = { seq: 0, businessDate, org: 'bench_org', store: String(rng.int(1000, 9999)) };

fs.mkdirSync(path.dirname(out), { recursive: true });
const fd = fs.openSync(out, 'w');
let bytes = 0;
for (let i = 0; i < count; i++) {
  const line = JSON.stringify(schema.build(rng, ctx)) + '\n';
  bytes += Buffer.byteLength(line);
  fs.writeSync(fd, line);
  ctx.seq += 1;
}
fs.closeSync(fd);

const meta = {
  current_date: businessDate,
  preload_date: new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10),
  preload: 0,
  stream: count,
  seed,
};
fs.writeFileSync(path.join(path.dirname(out), `${schemaName}.meta.json`), JSON.stringify(meta, null, 2) + '\n');

console.log(`[generate-data] ${count} ${schemaName} docs → ${out} (${(bytes / 1024 / 1024).toFixed(1)} MiB), seed=${seed}`);
console.log(`[generate-data] sized for rate=${rate}/s duration=${(durationMs / 1000).toFixed(0)}s` + (args.count !== undefined ? ' (overridden by --count)' : ''));
void uuid; // re-exported for parity; not used directly here
