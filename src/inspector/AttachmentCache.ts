// src/inspector/AttachmentCache.ts
//
// In-memory cache for attachment bytes fetched via the Inspector. Lives
// for the duration of an active database session — clear-on-disconnect
// is wired in extension.ts via DittoManager's lifecycle event.
//
// Why in-memory:
//   - The Inspector already sends attachments to the webview as base64
//     `data:` URIs (see InspectorViewProvider.fetchAttachment), so the
//     bytes are already in process memory at delivery time. Caching
//     them is just "don't drop the reference yet."
//   - In-memory cleanup is automatic on extension shutdown, so there's
//     no orphaned-disk-file class of bug to defend against. The user
//     specifically flagged "we shouldn't be losing disk space" as a
//     concern; the cleanest answer is "we don't use disk."
//   - The trade-off is memory pressure for big attachments — capped
//     with a simple LRU bound (default 64 MB across all entries).
//
// Why scoped by databaseId:
//   - Attachment IDs are unique within a database but not necessarily
//     across databases. The (dbId, attId) tuple is the safe key even
//     though today the manager only holds one active session at a time.
//   - Lets clearDatabase() shoot down exactly the entries belonging to
//     the disconnecting DB without touching anything else (defensive —
//     if a future change keeps the cache alive across switches).

export interface CachedAttachment {
  bytes: Buffer;
  mimeType: string;
  filename?: string;
  /** `bytes.length` snapshotted at insert time so eviction accounting
   *  stays cheap (no `.length` calls during LRU walks). */
  sizeBytes: number;
  /** Monotonic counter assigned on every get/set; smallest value = LRU. */
  lastAccess: number;
}

export interface AttachmentCacheOptions {
  /** Maximum total bytes (sum of cached `bytes.length`) before eviction
   *  kicks in. Defaults to 64 MB — large enough for a typical batch of
   *  preview images, small enough that a runaway query doesn't blow up
   *  the extension host. */
  maxBytes?: number;
}

export class AttachmentCache {
  private readonly entries = new Map<string, CachedAttachment>();
  private readonly maxBytes: number;
  private accessCounter = 0;
  private totalBytes = 0;

  constructor(opts: AttachmentCacheOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
  }

  private key(databaseId: string, attachmentId: string): string {
    return `${databaseId}:${attachmentId}`;
  }

  /** Cache hit: returns the entry and refreshes its LRU stamp.
   *  Miss: returns undefined. */
  get(databaseId: string, attachmentId: string): CachedAttachment | undefined {
    const e = this.entries.get(this.key(databaseId, attachmentId));
    if (!e) { return undefined; }
    this.accessCounter += 1;
    e.lastAccess = this.accessCounter;
    return e;
  }

  /** Store an entry. Replaces any existing entry for the same key.
   *  Triggers LRU eviction afterwards if the total exceeds `maxBytes`.
   *  An entry that's individually larger than `maxBytes` is rejected —
   *  evicting everything just to make room for one giant blob would
   *  defeat the cache's purpose. */
  set(
    databaseId: string,
    attachmentId: string,
    value: Omit<CachedAttachment, 'lastAccess'>,
  ): void {
    if (value.sizeBytes > this.maxBytes) {
      return;
    }
    const k = this.key(databaseId, attachmentId);
    const existing = this.entries.get(k);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
    }
    this.accessCounter += 1;
    this.entries.set(k, { ...value, lastAccess: this.accessCounter });
    this.totalBytes += value.sizeBytes;
    this.evictIfNeeded();
  }

  /** Drop every entry whose key starts with `${databaseId}:`. Called by
   *  the lifecycle listener when a session disconnects. */
  clearDatabase(databaseId: string): void {
    const prefix = `${databaseId}:`;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) {
        const e = this.entries.get(k);
        if (e) { this.totalBytes -= e.sizeBytes; }
        this.entries.delete(k);
      }
    }
  }

  /** Drop every cached entry. Used on extension dispose and as a belt-
   *  and-suspenders cleanup when the lifecycle reaches 'idle'. */
  clearAll(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Test/diagnostic helpers — not part of the production API surface
   *  but harmless to expose. */
  getTotalBytes(): number { return this.totalBytes; }
  size(): number { return this.entries.size; }

  /** Evict least-recently-used entries until totalBytes ≤ maxBytes.
   *  Sort cost is O(n log n) on the entry count; cache stays small in
   *  practice (a few dozen entries max), so this is fine. */
  private evictIfNeeded(): void {
    if (this.totalBytes <= this.maxBytes) { return; }
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [k, e] of sorted) {
      if (this.totalBytes <= this.maxBytes) { break; }
      this.totalBytes -= e.sizeBytes;
      this.entries.delete(k);
    }
  }
}
