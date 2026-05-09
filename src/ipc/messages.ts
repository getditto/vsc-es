import type {
  StoredDittoConfig,
  SecretSet,
  PeerListSnapshot,
} from '../models/DittoConfig.js';
import type { LogLevel } from '../logging/types.js';
import type {
  InspectorContent,
  QueryInspectorTab,
  QueryResultMetadata,
} from '../inspector/inspector-state.js';
import type { QueryHistoryEntry } from '../storage/QueryHistoryStore.js';
import type { QueryFavoriteEntry } from '../storage/QueryFavoritesStore.js';

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
  | { type: 'query.run'; query: string }
  | { type: 'query.rowSelected'; rowJson: string | null }
  | { type: 'query.starCurrent'; query: string };

export type QueryOut =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number; metadata?: QueryResultMetadata }
  | { type: 'query.error'; message: string };

// ─── Inspector view (auxiliary bar) ────────────────────────────
export type InspectorIn =
  | { type: 'inspector.tabSelected'; tab: QueryInspectorTab }
  | { type: 'inspector.loadQueryInEditor'; query: string }
  | { type: 'inspector.deleteHistoryEntry'; id: string }
  | { type: 'inspector.addFavorite'; query: string }
  | { type: 'inspector.removeFavorite'; id: string }
  | { type: 'inspector.fetchAttachment'; token: unknown; tokenId: string }
  | { type: 'inspector.saveAttachment'; token: unknown; tokenId: string };

export type InspectorOut =
  | { type: 'inspector.contentChanged'; content: InspectorContent }
  | { type: 'inspector.historyChanged'; databaseId: string; entries: QueryHistoryEntry[] }
  | { type: 'inspector.favoritesChanged'; databaseId: string; entries: QueryFavoriteEntry[] }
  | { type: 'inspector.helpHtml'; kind: 'subscription' | 'query'; uri: string }
  | { type: 'inspector.attachmentProgress'; tokenId: string; pct: number }
  | { type: 'inspector.attachmentLoaded'; tokenId: string; mimeType: string; webviewUri: string }
  | { type: 'inspector.attachmentSaved'; tokenId: string; path: string }
  | { type: 'inspector.attachmentError'; tokenId: string; message: string };

// ─── Logging (any panel webview → host, host → any webview) ──────
/** Webview → host: emit a log line. */
export type LogIn = { type: 'log'; level: LogLevel; message: string; ctx?: Record<string, unknown> };

/** Host → webview: notify of a channel-level change so the webview can short-circuit. */
export type LogOut = { type: 'log.levelChanged'; level: LogLevel };
