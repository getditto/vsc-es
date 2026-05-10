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
import type { ImportableSubscription } from '../ditto/import-subscription-parser.js';

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

// ─── Import Subscriptions from Server panel ────────────────────
export type ImportSubsIn =
  | { type: 'importSubs.importSelected'; queries: string[] }
  | { type: 'importSubs.cancel' };

export type ImportSubsOut =
  | { type: 'importSubs.loading' }
  | { type: 'importSubs.loaded'; subscriptions: ImportableSubscription[] }
  | { type: 'importSubs.error'; message: string }
  | { type: 'importSubs.importing'; status: string }
  | { type: 'importSubs.imported'; count: number };

// ─── Add Index panel ───────────────────────────────────────────
export type AddIndexIn =
  | { type: 'addIndex.create'; collection: string; field: string }
  | { type: 'addIndex.cancel' };

export type AddIndexOut =
  | { type: 'addIndex.init'; collections: string[]; preselected?: string }
  | { type: 'addIndex.error'; message: string }
  | { type: 'addIndex.created' };

// ─── Peer listing panel ────────────────────────────────────────
export type PeerIn =
  | { type: 'peer.toggleSync' }
  | {
      type: 'peer.applyTransportConfig';
      isLanEnabled: boolean;
      isBluetoothLeEnabled: boolean;
      isAwdlEnabled: boolean;
    };

export type PeerOut =
  | { type: 'peer.state'; snapshot: PeerListSnapshot; sync: 'active' | 'idle' }
  | {
      type: 'peer.platformInit';
      platform: 'macos' | 'windows' | 'linux' | 'other';
      support: { lan: boolean; bluetoothLE: boolean; awdl: boolean };
      current: { isLanEnabled: boolean; isBluetoothLeEnabled: boolean; isAwdlEnabled: boolean };
    }
  | {
      type: 'peer.transportApplyStatus';
      step: 'idle' | 'stoppingSync' | 'applyingConfig' | 'restartingSync' | 'complete';
      message?: string;
    }
  | { type: 'peer.transportApplyError'; message: string };

// ─── Query editor panel ────────────────────────────────────────
/** Where the query runs. `local` = active SDK store; `http` = REST API
 *  via `/api/v5/store/execute` against the connection's httpApiUrl. */
export type QueryMode = 'local' | 'http';

export type QueryIn =
  | { type: 'query.run'; query: string; mode: QueryMode }
  | { type: 'query.rowSelected'; rowJson: string | null }
  // User activated a row (double-click) — reveal it in the Inspector.
  // Distinct from rowSelected (single-click) so passive selection
  // doesn't yank the Inspector into the JSON tab on every click.
  | { type: 'query.rowActivated'; rowJson: string }
  | { type: 'query.starCurrent'; query: string }
  | { type: 'query.textChanged'; text: string }
  // Right-click menu items on a results row. The webview emits the
  // raw row JSON; the host derives the collection from the last-run
  // DQL and walks the user through the attachment dialog.
  | { type: 'query.addAttachment'; rowJson: string }
  | { type: 'query.deleteAttachment'; rowJson: string };

export type QueryOut =
  | { type: 'query.result'; rows: Record<string, unknown>[]; columns: string[]; durationMs: number; metadata?: QueryResultMetadata }
  | { type: 'query.error'; message: string }
  // Available run-locations for this connection. `['local']` when the
  // connection has no HTTP creds; `['local','http']` when both
  // httpApiUrl and httpApiKey are configured. The webview hides the
  // dropdown entirely when only one mode is available.
  | { type: 'query.modeInit'; availableModes: QueryMode[] }
  | { type: 'query.setText'; text: string };

// ─── Query Metrics panel ───────────────────────────────────────
/** A single record in the Query Metrics history. The shape is the
 *  same as QueryResultMetadata with a stable id minted by the store. */
export interface QueryMetricsRecord extends QueryResultMetadata {
  id: string;
}

export type MetricsIn =
  | { type: 'metrics.clear' };

export type MetricsOut =
  | { type: 'metrics.state'; records: QueryMetricsRecord[] };

// ─── Inspector view (auxiliary bar) ────────────────────────────
export type InspectorIn =
  | { type: 'inspector.tabSelected'; tab: QueryInspectorTab }
  | { type: 'inspector.loadQueryInEditor'; query: string }
  | { type: 'inspector.deleteHistoryEntry'; id: string }
  | { type: 'inspector.addFavorite'; query: string }
  | { type: 'inspector.removeFavorite'; id: string }
  | { type: 'inspector.fetchAttachment'; token: unknown; tokenId: string }
  | { type: 'inspector.saveAttachment'; token: unknown; tokenId: string }
  // User clicked the dismiss × on the LIMIT-suggestion tip. The host
  // persists the preference (per-installation) and re-pushes
  // inspector.preferences so any other open Inspector view updates.
  | { type: 'inspector.dismissLimitHint' };

export type InspectorOut =
  | { type: 'inspector.contentChanged'; content: InspectorContent }
  | { type: 'inspector.historyChanged'; databaseId: string; entries: QueryHistoryEntry[] }
  | { type: 'inspector.favoritesChanged'; databaseId: string; entries: QueryFavoriteEntry[] }
  | { type: 'inspector.helpHtml'; kind: 'subscription' | 'query' | 'presence' | 'metrics'; uri: string }
  | { type: 'inspector.attachmentProgress'; tokenId: string; pct: number }
  | { type: 'inspector.attachmentLoaded'; tokenId: string; mimeType: string; webviewUri: string }
  | { type: 'inspector.attachmentSaved'; tokenId: string; path: string }
  | { type: 'inspector.attachmentError'; tokenId: string; message: string }
  // Per-installation Inspector preferences (currently just the
  // dismiss flag for the LIMIT hint). Pushed once on resolve and
  // again whenever the user toggles a preference.
  | { type: 'inspector.preferences'; hideLimitHint: boolean };

// ─── Logging (any panel webview → host, host → any webview) ──────
/** Webview → host: emit a log line. */
export type LogIn = { type: 'log'; level: LogLevel; message: string; ctx?: Record<string, unknown> };

/** Host → webview: notify of a channel-level change so the webview can short-circuit. */
export type LogOut = { type: 'log.levelChanged'; level: LogLevel };
