import type { StoredDittoConfig, StoredSubscription } from '../models/DittoConfig.js';
import type { DittoCollection, DittoIndex, IndexField } from '../models/DittoCollection.js';
import type { StoredObserver } from '../models/StoredObserver.js';

/** Visual section header inside an active database — non-clickable, dimmed.
 *  `id` makes the section unique per DB so VS Code's per-id tree state doesn't
 *  collide between rows ("data" header for db-A vs db-B, etc.). */
/** `features` divides the data drill-ins (subscriptions/collections)
 *  from the feature shortcuts (Presence, Query Editor, Metrics).
 *  `importGroup` divides the metrics feature rows from the
 *  bulk-actions group below them (currently just Import Data). */
export type SectionHeaderId = 'features' | 'importGroup';

export type DatabaseTreeNode =
  | { kind: 'database'; config: StoredDittoConfig; status: 'idle' | 'activating' | 'active' | 'error' }
  | { kind: 'databaseDetails'; config: StoredDittoConfig }
  | { kind: 'sectionHeader'; databaseId: string; id: SectionHeaderId; label: string }
  | { kind: 'subscriptionsParent'; databaseId: string }
  | { kind: 'subscription'; databaseId: string; sub: StoredSubscription }
  | { kind: 'subscriptionQuery'; databaseId: string; sub: StoredSubscription }
  | { kind: 'observersParent'; databaseId: string }
  | { kind: 'observer'; databaseId: string; observer: StoredObserver }
  | { kind: 'observerQuery'; databaseId: string; observer: StoredObserver }
  | { kind: 'collection'; databaseId: string; collection: DittoCollection }
  | { kind: 'documentsLeaf'; databaseId: string; collection: DittoCollection }
  | { kind: 'indexesParent'; databaseId: string; collection: DittoCollection }
  | { kind: 'index'; databaseId: string; collectionName: string; index: DittoIndex }
  | { kind: 'indexField'; databaseId: string; collectionName: string; indexId: string; field: IndexField }
  | { kind: 'peerListing'; databaseId: string }
  | { kind: 'queryEditor'; databaseId: string }
  | { kind: 'queryMetrics'; databaseId: string }
  | { kind: 'databaseMetrics'; databaseId: string }
  | { kind: 'logAnalyzer'; databaseId: string }
  | { kind: 'importData'; databaseId: string };
