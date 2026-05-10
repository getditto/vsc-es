import type { StoredDittoConfig, StoredSubscription } from '../models/DittoConfig.js';
import type { DittoCollection, DittoIndex } from '../models/DittoCollection.js';

/** Visual section header inside an active database — non-clickable, dimmed.
 *  `id` makes the section unique per DB so VS Code's per-id tree state doesn't
 *  collide between rows ("data" header for db-A vs db-B, etc.). */
export type SectionHeaderId = 'data' | 'features';

export type DatabaseTreeNode =
  | { kind: 'database'; config: StoredDittoConfig; status: 'idle' | 'activating' | 'active' | 'error' }
  | { kind: 'databaseDetails'; config: StoredDittoConfig }
  | { kind: 'sectionHeader'; databaseId: string; id: SectionHeaderId; label: string }
  | { kind: 'subscriptionsParent'; databaseId: string }
  | { kind: 'subscription'; databaseId: string; sub: StoredSubscription }
  | { kind: 'collectionsParent'; databaseId: string }
  | { kind: 'collection'; databaseId: string; collection: DittoCollection }
  | { kind: 'index'; databaseId: string; collectionName: string; index: DittoIndex }
  | { kind: 'indexField'; databaseId: string; collectionName: string; indexId: string; field: string }
  | { kind: 'peerListing'; databaseId: string }
  | { kind: 'queryEditor'; databaseId: string };
