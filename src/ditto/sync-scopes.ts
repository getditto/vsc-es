import type {
  CollectionSyncScope,
  CollectionSyncScopeEntry,
} from '../models/DittoConfig.js';

const COLLECTION_SYNC_SCOPES = [
  'AllPeers',
  'BigPeerOnly',
  'SmallPeersOnly',
  'LocalPeerOnly',
] as const satisfies readonly CollectionSyncScope[];

const VALID_SCOPES = new Set<string>(COLLECTION_SYNC_SCOPES);

export function validateCollectionSyncScopes(
  entries: unknown,
): string | null {
  if (entries === undefined) { return null; }
  if (!Array.isArray(entries)) { return 'Collection sync scopes must be a list.'; }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'Every collection sync scope must be an object.';
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.collection !== 'string') {
      return 'Collection name must be text for every sync scope.';
    }
    if (typeof candidate.scope !== 'string' || !VALID_SCOPES.has(candidate.scope)) {
      return `Collection "${candidate.collection.trim()}" has an unsupported sync scope.`;
    }
    // `candidate.collection` is a validated string at this point — no cast needed.
    const collection = candidate.collection.trim();
    if (!collection) { return 'Collection name is required for every sync scope.'; }
    if (collection.startsWith('__')) {
      return `System collection "${collection}" cannot have a user collection sync scope.`;
    }
    if (seen.has(collection)) {
      return `Collection "${collection}" has more than one sync scope.`;
    }
    seen.add(collection);
  }
  return null;
}

export function normalizeCollectionSyncScopes(
  entries: readonly CollectionSyncScopeEntry[] | undefined,
): CollectionSyncScopeEntry[] {
  return (entries ?? []).map(entry => ({
    collection: entry.collection.trim(),
    scope: entry.scope,
  }));
}

export interface SyncScopeStore {
  execute(query: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** Apply persisted scopes to a newly opened Ditto before sync starts. */
export async function applyCollectionSyncScopes(
  store: SyncScopeStore,
  entries: unknown,
): Promise<void> {
  const validationError = validateCollectionSyncScopes(entries);
  if (validationError) { throw new Error(validationError); }
  const normalized = normalizeCollectionSyncScopes(
    entries as readonly CollectionSyncScopeEntry[] | undefined,
  );
  if (normalized.length === 0) { return; }

  const syncScopes: Record<string, CollectionSyncScope> = {};
  for (const entry of normalized) {
    syncScopes[entry.collection] = entry.scope;
  }
  await store.execute(
    'ALTER SYSTEM SET USER_COLLECTION_SYNC_SCOPES = :syncScopes',
    { syncScopes },
  );
}

export interface SyncStartTarget {
  store: SyncScopeStore;
  sync: { start(): void };
}

/** Keep scope application and any other pre-start configuration ahead of the
 *  irreversible sync start boundary. */
export async function startSyncWithCollectionScopes(
  target: SyncStartTarget,
  entries: unknown,
  configureBeforeStart: () => Promise<void>,
): Promise<void> {
  await applyCollectionSyncScopes(target.store, entries);
  await configureBeforeStart();
  target.sync.start();
}
