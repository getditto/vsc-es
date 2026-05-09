import type {
  StoredDittoConfig,
  SecretSet,
  PeerListSnapshot,
} from '../models/DittoConfig.js';

// ─── Database editor panel ─────────────────────────────────────
export type EditorIn =
  | { type: 'editor.save'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.cancel' };

export type EditorOut =
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet }
  | { type: 'editor.validationError'; message: string };

// ─── Subscription editor panel ─────────────────────────────────
export type SubIn =
  | { type: 'sub.save'; id?: string; name: string; query: string }
  | { type: 'sub.cancel' };

export type SubOut =
  | { type: 'sub.init'; id?: string; name: string; query: string };

// ─── Peer listing panel ────────────────────────────────────────
export type PeerIn =
  | { type: 'peer.toggleSync' };

export type PeerOut =
  | { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' };

// ─── Query editor panel ────────────────────────────────────────
export type QueryIn =
  | { type: 'query.run'; query: string };

export type QueryOut =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number }
  | { type: 'query.error'; message: string };
