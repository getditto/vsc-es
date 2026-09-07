import { quoteIdentifier } from '../ditto/dql-identifier.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DittoManager } from '../ditto/DittoManager.js';

/**
 * Per-collection CBOR payload estimate. Matches SwiftUI's
 * `CollectionStats` — bytes is the sum of `cborData().byteLength`
 * across every row in the collection, which approximates the
 * over-the-wire sync payload for that collection (NOT raw disk
 * usage; the SQLite store + WAL adds overhead on top).
 */
interface CollectionStats {
  name: string;
  documentCount: number;
  cborPayloadBytes: number;
}

/** Categorised disk usage breakdown — pure result of running the file
 *  list through `categorizeFiles`. Mirrors SwiftUI's DiskBreakdown. */
export interface DiskBreakdown {
  storeBytes: number;
  replicationBytes: number;
  attachmentsBytes: number;
  authBytes: number;
  walShmBytes: number;
  logsBytes: number;
  otherBytes: number;
}

export interface StorageSnapshot extends DiskBreakdown {
  /** Per-collection CBOR payload sizes, sorted largest-first. */
  collectionBreakdown: CollectionStats[];
  /** Sum of all collection CBOR payload bytes — a subset of the disk
   *  numbers above (this represents what's queryable; disk includes
   *  WAL, replication metadata, etc.). */
  collectionPayloadBytes: number;
  /** Sum of all disk bytes across every category. */
  totalDiskBytes: number;
}

const EMPTY_BREAKDOWN: DiskBreakdown = {
  storeBytes: 0,
  replicationBytes: 0,
  attachmentsBytes: 0,
  authBytes: 0,
  walShmBytes: 0,
  logsBytes: 0,
  otherBytes: 0,
};

/**
 * Recursively walk `root` and return every file as a (path, size) tuple.
 * Symlinks are not followed (Ditto's data dir is a flat tree of real
 * files; following symlinks would risk runaway recursion via a
 * developer's symlinked test fixture). Read errors on a single file
 * are swallowed so a transient lock or permission glitch on one row
 * doesn't sink the whole snapshot.
 */
export async function walkDataDir(
  root: string,
): Promise<{ path: string; sizeInBytes: number }[]> {
  const out: { path: string; sizeInBytes: number }[] = [];
  await walk(root, out);
  return out;
}

async function walk(
  dir: string,
  out: { path: string; sizeInBytes: number }[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Missing dir, no permission, etc. — treat as empty for this branch.
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(full);
        out.push({ path: full, sizeInBytes: st.size });
      } catch {
        // Transient stat failure — skip this file.
      }
    }
    // Symlinks / sockets / pipes ignored on purpose.
  }
}

/**
 * Bucket each file into Ditto's documented data directory layout.
 *
 * Order matters and mirrors SwiftUI's `StorageRepository.categorizeFiles`:
 * WAL/SHM suffix is checked FIRST so a `*-wal` file living inside
 * `/ditto_store/` lands in the WAL bucket rather than double-counting
 * into the store bucket. Same for logs (`/ditto_logs/` OR a bare
 * `.log` / `.log.gz` suffix anywhere). Path matching is case-insensitive
 * because we don't control how the SDK capitalises directories on
 * different platforms.
 */
export function categorizeFiles(
  files: readonly { path: string; sizeInBytes: number }[],
): DiskBreakdown {
  const b: DiskBreakdown = { ...EMPTY_BREAKDOWN };
  for (const f of files) {
    const p = f.path.toLowerCase();
    const bytes = f.sizeInBytes;
    if (p.endsWith('-wal') || p.endsWith('-shm')) {
      b.walShmBytes += bytes;
    } else if (p.includes('/ditto_logs/') || p.endsWith('.log') || p.endsWith('.log.gz')) {
      b.logsBytes += bytes;
    } else if (p.includes('/ditto_store/')) {
      b.storeBytes += bytes;
    } else if (p.includes('/ditto_attachments/')) {
      b.attachmentsBytes += bytes;
    } else if (p.includes('/ditto_auth')) {
      // matches both /ditto_auth/ and /ditto_auth_tmp/
      b.authBytes += bytes;
    } else if (p.includes('/ditto_replication/')) {
      b.replicationBytes += bytes;
    } else {
      // ditto_metrics/, ditto_system_info/, lock files, anything else
      b.otherBytes += bytes;
    }
  }
  return b;
}

/**
 * Run `SELECT * FROM system:collections` then a per-collection
 * `SELECT *` and sum each row's CBOR byte count. Sorted largest-first
 * so the panel can render "biggest collections first" without further
 * client-side sorting.
 *
 * Uses CBOR instead of JSON for two reasons that matter at scale:
 *   1. CBOR is the on-wire format the SDK syncs, so the byte count
 *      approximates real network cost rather than the inflated JSON
 *      view.
 *   2. Reading `.cborData()` is cheaper than materializing `.value`
 *      into a JS object — at million-row collections that's a real
 *      memory savings.
 */
async function computeCollectionBreakdown(
  manager: DittoManager,
  isExpectedActive?: () => boolean,
): Promise<CollectionStats[]> {
  const collections = await manager.executeRaw('SELECT * FROM system:collections');
  const names = collections
    .map(r => (typeof r.name === 'string' ? r.name : null))
    .filter((n): n is string => n !== null);

  const stats: CollectionStats[] = [];
  for (const name of names) {
    // Mid-switch guard: every executeRaw resolves against the CURRENT
    // session, so a refresh that outlives a database switch would run a
    // per-collection CBOR scan (the most expensive operation the
    // extension can issue) against the freshly-connected database — for
    // results the switch already discarded with the panel. Bail between
    // collections instead. Same invariant ImportService.checkActive and
    // SystemMetricsService.isExpectedActive uphold.
    if (isExpectedActive && !isExpectedActive()) { break; }
    try {
      const cborRes = await manager.cborBytesForCollection(quoteIdentifier(name, 'collection'));
      stats.push({
        name,
        documentCount: cborRes.documentCount,
        cborPayloadBytes: cborRes.totalBytes,
      });
    } catch {
      // One bad collection (locked, malformed name, etc.) shouldn't
      // sink the whole snapshot. Skip silently — the breakdown still
      // shows every other collection.
    }
  }
  return stats.sort((a, b) => b.cborPayloadBytes - a.cborPayloadBytes);
}

/**
 * Top-level orchestrator — walks disk, categorises, computes
 * per-collection CBOR sizes, returns the combined snapshot.
 *
 * `dataDir` is the per-DB `<globalStorageUri>/dittoData/<configId>`
 * path; the panel is responsible for handing the right one in.
 */
export async function snapshot(
  manager: DittoManager,
  dataDir: string,
  isExpectedActive?: () => boolean,
): Promise<StorageSnapshot> {
  const flatFiles = await walkDataDir(dataDir);
  const breakdown = categorizeFiles(flatFiles);
  const collections = await computeCollectionBreakdown(manager, isExpectedActive);

  const collectionPayloadBytes = collections.reduce(
    (acc, c) => acc + c.cborPayloadBytes,
    0,
  );
  const totalDiskBytes =
    breakdown.storeBytes +
    breakdown.replicationBytes +
    breakdown.attachmentsBytes +
    breakdown.authBytes +
    breakdown.walShmBytes +
    breakdown.logsBytes +
    breakdown.otherBytes;

  return {
    ...breakdown,
    collectionBreakdown: collections,
    collectionPayloadBytes,
    totalDiskBytes,
  };
}
