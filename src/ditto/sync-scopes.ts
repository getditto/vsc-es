import type {
  CollectionSyncScope,
  CollectionSyncScopeEntry,
} from '../models/DittoConfig.js';

export const COLLECTION_SYNC_SCOPES = [
  'AllPeers',
  'BigPeerOnly',
  'SmallPeersOnly',
  'LocalPeerOnly',
] as const satisfies readonly CollectionSyncScope[];

const VALID_SCOPES = new Set<string>(COLLECTION_SYNC_SCOPES);

export function validateCollectionSyncScopes(
  entries: readonly CollectionSyncScopeEntry[] | undefined,
): string | null {
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    const collection = entry.collection.trim();
    if (!collection) { return 'Collection name is required for every sync scope.'; }
    if (collection.startsWith('__')) {
      return `System collection "${collection}" cannot have a user collection sync scope.`;
    }
    if (seen.has(collection)) {
      return `Collection "${collection}" has more than one sync scope.`;
    }
    if (!VALID_SCOPES.has(entry.scope)) {
      return `Collection "${collection}" has an unsupported sync scope.`;
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
  entries: readonly CollectionSyncScopeEntry[] | undefined,
): Promise<void> {
  const normalized = normalizeCollectionSyncScopes(entries);
  const validationError = validateCollectionSyncScopes(normalized);
  if (validationError) { throw new Error(validationError); }
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
