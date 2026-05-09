import type { StoredDittoConfig, StoredSubscription } from '../models/DittoConfig.js';

export type DatabaseTreeNode =
  | { kind: 'database'; config: StoredDittoConfig; status: 'idle' | 'activating' | 'active' | 'error' }
  | { kind: 'subscriptionsParent'; databaseId: string }
  | { kind: 'subscription'; databaseId: string; sub: StoredSubscription }
  | { kind: 'peerListing'; databaseId: string }
  | { kind: 'queryEditor'; databaseId: string };
