#!/usr/bin/env node
// Host-side Ditto v5 injector — a local test app for exercising the
// extension's diagnostics features (Debug Console, system:metrics, Log Analyzer).
// Concept ported from memory-benchmarks-compare/injector/dittov5-node with two
// additions for diagnostics testing:
//
//   --debug-socket=<path>   ALTER SYSTEM SET debug_socket (test the Debug Console)
//   --metrics               export system:metrics in THIS process, so the Debug
//                           Console can SELECT from it (startup-gated env var)
//
// License/sync are OPTIONAL: with DITTO_LICENSE set (repo-root .env or --license)
// it activates offline and starts sync like the benchmark injector; without it
// the app runs local-only, which is all the diagnostics features need.
//
// Usage:
//   node scripts/test-injector/injector.mjs --collection=orders \
//       [--dataset=path.ndjson] [--rate=4] [--duration=15m] [--skip=N]
//       [--work-dir=/tmp/ditto-injector] [--debug-socket=/tmp/ditto-injector-debug.sock]
//       [--metrics] [--database-id=...] [--license=...]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

function readDotEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  const out = { DITTO_DATABASE_ID: '', DITTO_LICENSE: '' };
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (k in out) out[k] = line.slice(eq + 1).trim();
  }
  return out;
}

function makePacer(ratePerSec) {
  const intervalNs = BigInt(Math.round(1_000_000_000 / ratePerSec));
  let nextAt = process.hrtime.bigint();
  return async function tick() {
    nextAt += intervalNs;
    const now = process.hrtime.bigint();
    if (nextAt > now) {
      const sleepMs = Number((nextAt - now) / 1_000_000n);
      if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
    }
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (process.argv.includes('--help')) {
    console.log('See header comment. Flags: --collection --dataset --rate --duration --skip --work-dir --debug-socket --metrics --database-id --license');
    process.exit(0);
  }

  const env = readDotEnv();
  const collection = args.collection || 'tasks';
  const datasetPath = args.dataset || path.join(DATA_DIR, `${collection}.ndjson`);
  if (!fs.existsSync(datasetPath)) {
    throw new Error(
      `Dataset not found: ${datasetPath}\n` +
      `Generate one first, e.g.:  npm run injector:generate -- --collection=${collection} --rate=4 --duration=15m`,
    );
  }
  const ratePerSec = Number(args.rate ?? '4');
  const durationMs = parseDurationMs(args.duration ?? '15m');
  const skip = Number(args.skip ?? '0');
  const workDir = args['work-dir'] || '/tmp/ditto-injector';
  const debugSocket = args['debug-socket'];
  const metrics = 'metrics' in args;
  const databaseId = args['database-id'] || env.DITTO_DATABASE_ID || 'ditto-edge-studio-injector';
  const license = args.license ?? env.DITTO_LICENSE;

  if (metrics) {
    // Startup-gated system parameter — must be in the env before Ditto.open.
    process.env.DITTO_METRICS_EXPORTER_VIRTUAL_COLLECTION_ENABLED = 'true';
  }

  fs.mkdirSync(workDir, { recursive: true });
  const lines = fs.readFileSync(datasetPath, 'utf8').split('\n').filter(l => l.trim() !== '');
  const { Ditto, DittoConfig } = await import('@dittolive/ditto');
  const ditto = await Ditto.open(
    new DittoConfig(databaseId, { mode: 'smallPeersOnly', privateKey: null }, workDir),
  );

  const execute = async (query, parameters) => {
    const result = await ditto.store.execute(query, parameters);
    await result.close();
  };
  const tick = makePacer(ratePerSec);
  const deadlineNs = process.hrtime.bigint() + BigInt(durationMs) * 1_000_000n;

  console.log(`[injector] work-dir=${workDir} docs=${lines.length} skip=${skip} rate=${ratePerSec}/s duration=${durationMs}ms`);
  console.log(`[injector] ${license ? 'licensed — sync will start' : 'no license — running LOCAL-ONLY (fine for diagnostics testing)'}`);
  if (debugSocket) console.log(`[injector] debug socket → ${debugSocket}  (open it with: Ditto: Open Debug Console)`);

  try {
    if (license) {
      await ditto.setOfflineOnlyLicenseToken(license);
      await execute(
        'ALTER SYSTEM SET USER_COLLECTION_SYNC_SCOPES = :scopes',
        { scopes: { [collection]: 'SmallPeersOnly' } },
      );
      ditto.updateTransportConfig((tc) => {
        tc.peerToPeer.bluetoothLE.isEnabled = false;
        tc.peerToPeer.lan.isEnabled = true;
        tc.peerToPeer.wifiAware.isEnabled = false;
      });
      ditto.sync.start();
      ditto.sync.registerSubscription(`SELECT * FROM ${collection}`);
    }

    if (debugSocket) {
      await execute('ALTER SYSTEM SET debug_socket = :socket', { socket: debugSocket });
    }

    let pushed = 0;
    const start = skip;
    for (let i = start; i < lines.length && process.hrtime.bigint() < deadlineNs; i++) {
      await execute(
        `INSERT INTO ${collection} DOCUMENTS (deserialize_json(:doc)) ON ID CONFLICT DO UPDATE`,
        { doc: lines[i] },
      );
      pushed += 1;
      if (pushed % 100 === 0) console.log(`[injector] pushed=${pushed}`);
      await tick();
    }
    console.log(`[injector] done — pushed=${pushed}`);

    // Keep the process alive past the injection window when a debug socket or
    // sync is active, so the console/mesh can be exercised after the feed ends.
    // The keepalive below holds the event loop open.
    if (debugSocket || license) {
      console.log('[injector] staying alive (Ctrl+C to exit)');
      await new Promise(() => {});
    }
  } finally {
    await ditto.close();
  }
}

// SDK 5.3 RC1 can exit or abort a standalone Node process while an
// asynchronous native query is still pending when the event loop is idle.
const keepAlive = setInterval(() => {}, 60_000);
try {
  await main();
} catch (err) {
  console.error('[injector] fatal:', err.message);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
