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

// ─── Welcome / first-run onboarding panel ──────────────────────
/** Webview → host. The welcome panel has two action buttons: a primary
 *  "Register Database" that fans out to dittoVsce.registerDatabase, and
 *  a soft "Close" that disposes the panel. */
export type WelcomeIn =
  | { type: 'welcome.registerDatabase' }
  | { type: 'welcome.getQuickstarts' }
  | { type: 'welcome.close' };

/** Host → webview. The init payload tells the panel whether at least
 *  one database is already configured — when it is, the panel hides
 *  its "this is a guided first-run" framing and reads as a reference
 *  card the user re-opened on purpose. */
export type WelcomeOut =
  | { type: 'welcome.init'; hasExistingDatabases: boolean };

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

// ─── Import Data panel ─────────────────────────────────────────
/** Insert mode mirrors SwiftUI's InsertType — `'regular'` does an
 *  upsert (ON ID CONFLICT DO UPDATE), `'initial'` uses Ditto's
 *  INITIAL DOCUMENTS bulk-import optimisation (first-load only). */
export type ImportDataInsertType = 'regular' | 'initial';

export type ImportDataIn =
  // User clicked "Choose File…" — host opens an OS file picker, reads
  // and validates the file, then echoes back `importData.fileSelected`
  // (or `importData.error` when validation fails).
  | { type: 'importData.chooseFile' }
  // Refresh the existing-collections list (called when the user toggles
  // back to the "existing collection" mode and the panel was opened
  // before the collections sync completed).
  | { type: 'importData.refreshCollections' }
  | {
      type: 'importData.start';
      collection: string;
      insertType: ImportDataInsertType;
    }
  | { type: 'importData.cancel' };

export type ImportDataOut =
  // Initial payload — pushes the connection name + existing-collections
  // list + the preselected collection (when the user right-clicked a
  // collection in the tree).
  | {
      type: 'importData.init';
      databaseName: string;
      existingCollections: string[];
      preselectedCollection?: string;
    }
  | { type: 'importData.collectionsRefreshed'; existingCollections: string[] }
  | {
      type: 'importData.fileSelected';
      fileName: string;
      /** Document count after validation — surfaced in the UI so the
       *  user can sanity-check before they click Import. */
      documentCount: number;
    }
  | {
      type: 'importData.progress';
      current: number;
      total: number;
      currentDocumentId?: string;
    }
  | {
      type: 'importData.done';
      successCount: number;
      failureCount: number;
      /** Limited to the first ~5 errors to keep the payload bounded. */
      errors: string[];
      collection: string;
    }
  | { type: 'importData.error'; message: string };

// ─── Add Index panel ───────────────────────────────────────────
export type AddIndexIn =
  | { type: 'addIndex.create'; collection: string; field: string }
  | { type: 'addIndex.cancel' };

export type AddIndexOut =
  | { type: 'addIndex.init'; collections: string[]; preselected?: string }
  | { type: 'addIndex.error'; message: string }
  | { type: 'addIndex.created' };

// ─── Peer listing panel ────────────────────────────────────────
/** Minimal local-network interface descriptor — what `os.networkInterfaces()`
 *  gives us on the host side. We deliberately stop here rather than
 *  shelling out to `airport`, `iwconfig`, etc. for SSID/RSSI/etc. (see
 *  the docs in PeerListingPanel for the rationale). */
export interface LocalNetworkInterface {
  /** Interface name as the OS reports it: en0, eth0, wlan0, … */
  name: string;
  /** Best-effort kind from the name pattern. We collapse Wi-Fi and
   *  Ethernet into a single `'lan'` kind because `os.networkInterfaces()`
   *  can't reliably tell them apart (e.g. `en0` is Wi-Fi on a MacBook
   *  but Ethernet via a Thunderbolt dock). This also matches the
   *  umbrella "LAN" label our network graph already uses for the
   *  AccessPoint transport. */
  kind: 'lan' | 'loopback' | 'other';
  /** First non-internal MAC we see for this interface. */
  mac?: string;
  /** All IPv4 addresses; usually one but VPNs/aliases produce multiples. */
  ipv4: { address: string; cidr: string }[];
  /** All IPv6 addresses (link-local + global). */
  ipv6: { address: string; cidr: string; scopeid?: number }[];
}

export type PeerIn =
  | { type: 'peer.toggleSync' }
  | {
      type: 'peer.applyTransportConfig';
      isLanEnabled: boolean;
      isBluetoothLeEnabled: boolean;
      isAwdlEnabled: boolean;
    }
  | { type: 'peer.refreshLocalNetwork' };

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
  | { type: 'peer.transportApplyError'; message: string }
  | { type: 'peer.localNetwork'; interfaces: LocalNetworkInterface[] };

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
  | { type: 'query.deleteAttachment'; rowJson: string }
  // User clicked Export — the webview has already JSON.stringify'd the
  // FULL result set (not just the current page) into `json`. Host
  // shows a save dialog and writes the file. `rowCount` is surfaced
  // for the success message; deriving it from the string by re-parsing
  // would defeat the point of the webview serialising once.
  | { type: 'query.exportRows'; json: string; rowCount: number };

export type QueryOut =
  | {
      type: 'query.result';
      rows: Record<string, unknown>[];
      columns: string[];
      durationMs: number;
      metadata?: QueryResultMetadata;
      /** Same value as `metadata.profile`, hoisted for convenience so
       *  the webview can render it without unpacking the metadata bag.
       *  Undefined for HTTP-mode runs (PROFILE is local-only for v1)
       *  and non-SELECT statements. */
      profile?: import('../ditto/QueryProfile.js').QueryProfile;
    }
  | { type: 'query.error'; message: string }
  // Available run-locations for this connection. `['local']` when the
  // connection has no HTTP creds; `['local','http']` when both
  // httpApiUrl and httpApiKey are configured. The webview hides the
  // dropdown entirely when only one mode is available.
  | { type: 'query.modeInit'; availableModes: QueryMode[] }
  | { type: 'query.setText'; text: string }
  // Acknowledgements for `query.exportRows`. The webview uses these to
  // clear its "Exporting…" indicator and (on error) surface the
  // message inline rather than via a modal.
  | { type: 'query.exportDone'; rowCount: number; path: string }
  | { type: 'query.exportCancelled' }
  | { type: 'query.exportError'; message: string };

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

// ─── Database Metrics panel ────────────────────────────────────
export interface DbMetricsCollectionStats {
  name: string;
  documentCount: number;
  cborPayloadBytes: number;
}

export interface DbMetricsSnapshot {
  storeBytes: number;
  replicationBytes: number;
  attachmentsBytes: number;
  authBytes: number;
  walShmBytes: number;
  logsBytes: number;
  otherBytes: number;
  collectionBreakdown: DbMetricsCollectionStats[];
  collectionPayloadBytes: number;
  totalDiskBytes: number;
  /** epoch ms — when this snapshot finished computing. Surfaced on
   *  the panel as "last refreshed" so users know if they're looking
   *  at stale numbers. */
  computedAt: number;
}

export type DbMetricsIn =
  | { type: 'dbMetrics.refresh' };

export type DbMetricsOut =
  | { type: 'dbMetrics.loading' }
  | { type: 'dbMetrics.snapshot'; snapshot: DbMetricsSnapshot }
  | { type: 'dbMetrics.error'; message: string };

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
  | { type: 'inspector.helpHtml'; kind: 'subscription' | 'query' | 'presence' | 'metrics' | 'databaseMetrics'; uri: string }
  | { type: 'inspector.attachmentProgress'; tokenId: string; pct: number }
  | { type: 'inspector.attachmentLoaded'; tokenId: string; mimeType: string; webviewUri: string }
  | { type: 'inspector.attachmentSaved'; tokenId: string; path: string }
  | { type: 'inspector.attachmentError'; tokenId: string; message: string }
  // Per-installation Inspector preferences (currently just the
  // dismiss flag for the LIMIT hint). Pushed once on resolve and
  // again whenever the user toggles a preference.
  | { type: 'inspector.preferences'; hideLimitHint: boolean }
  // Workspace settings the Inspector cares about. Today: whether
  // metrics collection is enabled (controls visibility of the Metrics
  // tab). Pushed on resolve and whenever the user toggles the setting.
  | { type: 'inspector.settings'; collectMetrics: boolean };

// ─── Logging (any panel webview → host, host → any webview) ──────
/** Webview → host: emit a log line. */
export type LogIn = { type: 'log'; level: LogLevel; message: string; ctx?: Record<string, unknown> };

/** Host → webview: notify of a channel-level change so the webview can short-circuit. */
export type LogOut = { type: 'log.levelChanged'; level: LogLevel };
