import type {
  StoredDittoConfig,
  SecretSet,
  PeerListSnapshot,
  SystemSettingOption,
} from '../models/DittoConfig.js';
import type {
  InspectorContent,
  QueryInspectorTab,
  QueryResultMetadata,
} from '../inspector/inspector-state.js';
import type { QueryHistoryEntry } from '../storage/QueryHistoryStore.js';
import type { QueryFavoriteEntry } from '../storage/QueryFavoritesStore.js';
import type { ImportableSubscription } from '../ditto/import-subscription-parser.js';
import type { ObserverEvent } from '../ditto/ObserverEventStore.js';

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
  | { type: 'editor.init'; config: StoredDittoConfig; secrets: SecretSet; isActiveConnection: boolean }
  | { type: 'editor.initError'; message: string }
  | { type: 'editor.activeConnectionChanged'; isActiveConnection: boolean }
  | { type: 'editor.systemSettingsLoaded'; options: SystemSettingOption[] }
  | { type: 'editor.systemSettingsLoadError'; message: string }
  | { type: 'editor.validationError'; message: string; field?: 'advancedConfig' | undefined };

// ─── Subscription editor panel ─────────────────────────────────
export type SubIn =
  | { type: 'sub.save'; id?: string; name: string; query: string }
  | { type: 'sub.cancel' };

export type SubOut =
  | { type: 'sub.init'; id?: string | undefined; name: string; query: string };

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
type ImportDataInsertType = 'regular' | 'initial';

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
      preselectedCollection?: string | undefined;
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
      currentDocumentId?: string | undefined;
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
  | {
      type: 'addIndex.create';
      collection: string;
      /** Ordered keys. More than one creates a composite index; the order is
       *  significant to the query optimizer, so it is preserved verbatim. */
      fields: import('../models/DittoCollection.js').IndexField[];
    }
  | { type: 'addIndex.cancel' };

export type AddIndexOut =
  | { type: 'addIndex.init'; collections: string[]; preselected?: string | undefined }
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
  mac?: string | undefined;
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

// ─── ADVISE (SDK 5.1) — Query Editor index advice ─────────────
/** One entry of ADVISE's `suggestedIndexes[]`. `statement` is the
 *  ready-to-run `CREATE INDEX IF NOT EXISTS …` Ditto emits; running it
 *  is always user-confirmed (modal in the host) — the extension never
 *  runs `ADVISE AND PROVISION` silently, and never surfaces one. */
export interface QueryIndexSuggestion {
  collection: string;
  reason: string;
  statement: string;
}

/** Extracted `advice` payload from an `ADVISE <SELECT …>` result row.
 *  Ditto emits a single row of the form
 *  `{ advice: { statement, suggestedIndexes?, outcome? } }`:
 *  `suggestedIndexes` is absent when there's nothing to advise on
 *  (`outcome` then says why, e.g. "no keys to advise on"). */
export interface QueryAdvice {
  statement: string;
  outcome?: string;
  suggestions: QueryIndexSuggestion[];
}

export type QueryIn =
  | { type: 'query.run'; query: string; mode: QueryMode }
  | { type: 'query.rowSelected'; rowJson: string | null }
  // User activated a row (double-click) — reveal it in the Inspector.
  // Distinct from rowSelected (single-click) so passive selection
  // doesn't yank the Inspector into the JSON tab on every click.
  | { type: 'query.rowActivated'; rowJson: string }
  | { type: 'query.starCurrent'; query: string }
  | { type: 'query.textChanged'; text: string }
  // Cog menu in the Query Editor — toggles the two workspace settings
  // (`dittoVsce.collectProfiling`, `dittoVsce.collectMetrics`). The host
  // writes the value to the user's global config and broadcasts the new
  // settings back to every open Query Editor + the Inspector.
  | { type: 'query.setSetting'; key: 'collectProfiling' | 'collectMetrics'; value: boolean }
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
  | { type: 'query.exportRows'; json: string; rowCount: number }
  // User clicked "Create index" on an ADVISE suggestion. `statement` is
  // the exact CREATE INDEX text Ditto proposed; the host confirms via a
  // modal, re-checks the active connection (mid-switch guard), runs it
  // through executeRaw, then refreshes the index tree.
  | { type: 'query.createSuggestedIndex'; statement: string; collection: string };

export type QueryOut =
  | {
      type: 'query.result';
      rows: Record<string, unknown>[];
      columns: string[];
      durationMs: number;
      /** Result metadata. Always populated by the host (never
       *  undefined on the wire). Includes `profile` when a profile
       *  was captured — webview consumers read `metadata.profile`
       *  rather than a hoisted field to keep one source of truth. */
      metadata: QueryResultMetadata;
      /** ADVISE advice extracted from the rows host-side (the Advice block
       *  in the webview). Absent/null for non-ADVISE queries and for ADVISE
       *  results whose rows carried no advice object. */
      advice?: QueryAdvice | null;
    }
  | { type: 'query.error'; message: string }
  // Per-suggestion feedback for `query.createSuggestedIndex`, keyed by the
  // advice statement so the webview can track buttons independently.
  // 'declined' = the user dismissed the confirmation modal (button re-arms).
  | {
      type: 'query.adviseFeedback';
      statement: string;
      outcome: 'created' | 'declined' | 'failed';
      message?: string;
    }
  // Available run-locations for this connection. `['local']` when the
  // connection has no HTTP creds; `['local','http']` when both
  // httpApiUrl and httpApiKey are configured. The webview hides the
  // dropdown entirely when only one mode is available.
  | { type: 'query.modeInit'; availableModes: QueryMode[] }
  | { type: 'query.setText'; text: string }
  // Current workspace settings the Query Editor cog menu surfaces.
  // Pushed on panel resolve and whenever the config changes (regardless
  // of source: the cog menu itself, VS Code's settings UI, or a
  // settings.json edit). The webview uses these to hide the Profile
  // toggle button when `collectProfiling === false`.
  | { type: 'query.settings'; collectProfiling: boolean; collectMetrics: boolean }
  // Acknowledgements for `query.exportRows`. The webview uses these to
  // clear its "Exporting…" indicator and (on error) surface the
  // message inline rather than via a modal.
  | { type: 'query.exportDone'; rowCount: number; path: string }
  | { type: 'query.exportCancelled' }
  | { type: 'query.exportError'; message: string };

// ─── Observer panel ────────────────────────────────────────────
/** Webview → host. */
export type ObserverIn =
  // User clicked Activate in the panel toolbar.
  | { type: 'observer.activate' }
  // User clicked Stop in the panel toolbar.
  | { type: 'observer.stop' }
  // User selected an event in the events table; surface the
  // currently-selected event's row JSON to the Inspector.
  | { type: 'observer.eventSelected'; eventId: string | null }
  // User selected a single row inside the bottom-pane detail view.
  // The Inspector's JSON tab shows this row.
  | { type: 'observer.rowSelected'; rowJson: string | null };

/** Host → webview. */
export type ObserverOut =
  // Pushed on resolve and after every save — name + query for the
  // panel title/toolbar.
  | { type: 'observer.init'; observer: { id: string; name: string; query: string } }
  // Pushed when the observer is activated or stopped.
  | { type: 'observer.statusChanged'; active: boolean }
  // Coalesced batch of events from the host's 100ms flush window.
  // The webview appends them to its ring buffer. Each event's `data` is
  // capped on the host (OBSERVER_ROW_CAP rows); `totalRows` carries the
  // uncapped count so the webview can show a "first N of M" indicator.
  | { type: 'observer.events'; events: ObserverEvent[] }
  // Pushed when the user clicks Stop or when the observer is
  // cancelled programmatically — clears the webview's event store.
  | { type: 'observer.cleared' };

// ─── Query Metrics panel ───────────────────────────────────────
/** A single record in the Query Metrics history. The shape is the
 *  same as QueryResultMetadata with a stable id minted by the store. */
interface QueryMetricsRecord extends QueryResultMetadata {
  id: string;
}

export type MetricsIn =
  | { type: 'metrics.clear' };

export type MetricsOut =
  | { type: 'metrics.state'; records: QueryMetricsRecord[] };

// ─── system:metrics (SDK 5.1) — System Metrics panel.
//     Host side: src/ditto/SystemMetricsService.ts.
//
// `system:metrics` is a DQL virtual collection whose reads FLUSH the
// underlying registry: every SELECT returns deltas since the previous
// read (row shape: `{ key, labels, level, unit, description, …kind fields }`,
// counters carry `current`/`updates`/`delta`, histograms carry
// `count`/`sum`/`abs_max` + `dcount`/`dsum`/`dabs_max`). The host service
// therefore accumulates per-read deltas into since-connect running totals,
// and the wire shape below carries the accumulated picture rather than a
// last-read dump.
export interface SystemMetricSample {
  /** Bare metric name, e.g. `ditto.network.dsoq.connection.opened`. */
  key: string;
  /** Label map — sqlite metrics label by `db` role, recovery by `cause`, etc. */
  labels: Record<string, string>;
  description: string;
  unit: string;
  /** `histogram` when the row carries `count`/`dcount`; otherwise `counter`.
   *  (Counters and gauges share one row shape — `current`/`updates`/`delta`
   *  — and no gauge-key metric is surfaced on the dashboard today.) */
  kind: 'counter' | 'histogram';
  /** Running total since this extension host connected: counters accumulate
   *  `delta`, histograms accumulate `dcount`. */
  sinceConnect: number;
  /** The most recent read's delta alone (counters: `delta`; histograms:
   *  `dcount`) — "what happened in the last poll interval". */
  periodDelta: number;
  /** Histograms only: accumulated `dsum` since connect (unit per metric:
   *  seconds for durations, pages for wal_size_pages). */
  sumSinceConnect?: number;
  /** Histograms only: latest cumulative absolute max reported by the store. */
  absMax?: number;
}

export interface SystemMetricsSnapshot {
  samples: SystemMetricSample[];
  /** epoch ms of the first successful accumulation — the "since connect"
   *  zero point, surfaced so the user knows what the totals cover. */
  sinceMs: number;
  /** epoch ms of the read that produced this snapshot. */
  polledAtMs: number;
  pollIntervalMs: number;
}

/** Explicit state machine for the System Metrics panel — the webview
 *  renders guidance per kind instead of a dead table. */
export type SystemMetricsStatus =
  /** Polling and accumulating. */
  | { kind: 'working'; snapshot: SystemMetricsSnapshot }
  /** `dittoVsce.collectSystemMetrics` is off; nothing was enabled at
   *  startup and polling isn't running. */
  | { kind: 'settingDisabled' }
  /** `system:metrics` answered with its disabled placeholder row — the
   *  exporter parameter is startup-only, so the setting must be on BEFORE
   *  the connection opens; the fix is reconnecting with the setting on. */
  | { kind: 'exporterDisabled' }
  /** No active SDK session for this panel's connection. */
  | { kind: 'noConnection' }
  /** The query itself failed (e.g. an SDK without the virtual collection). */
  | { kind: 'unavailable'; message: string };

// ─── Database Metrics panel ────────────────────────────────────
interface DbMetricsCollectionStats {
  name: string;
  documentCount: number;
  cborPayloadBytes: number;
}

interface DbMetricsSnapshot {
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

// ─── System Metrics panel ──────────────────────────────────────
/** Identity of one metric series (metric key + label set) — enough to
 *  match a sample in a later snapshot. Used for per-DB pinned metrics,
 *  persisted in globalState so they survive panel/connection restarts. */
export interface SystemMetricSeriesRef {
  key: string;
  labels: Record<string, string>;
}

export type SysMetricsIn =
  /** The Refresh button: force an immediate poll, ahead of the cadence. */
  | { type: 'sysMetrics.refresh' }
  /** Replace the pinned-series list wholesale. Pin, unpin, and
   *  "Clear pins" all send the complete resulting list (pin order), so
   *  every edit is one idempotent write. */
  | { type: 'sysMetrics.setPins'; pins: SystemMetricSeriesRef[] };

export type SysMetricsOut =
  /** System metrics (SDK 5.1 `system:metrics`) status + accumulated snapshot.
   *  Pushed on every poll while the panel is visible, and on Refresh. */
  | { type: 'sysMetrics.status'; status: SystemMetricsStatus }
  /** The pinned series for this connection, in pin order. Pushed once
   *  when the panel opens (the host owns the persisted truth). */
  | { type: 'sysMetrics.pins'; pins: SystemMetricSeriesRef[] };

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
  | { type: 'inspector.helpHtml'; kind: 'subscription' | 'query' | 'presence' | 'metrics' | 'databaseMetrics' | 'systemMetrics' | 'observers' | 'logAnalyzer' | 'patternEditor'; uri: string }
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

// ─── Log Analyzer panel ────────────────────────────────────────
/** Host → webview: state diffs from LogAnalyzerService. */
export type AnalyzerOut =
  | { type: 'analyzer.reset' }
  | {
      type: 'analyzer.summary';
      counts: import('../logAnalyzer/types.js').SummaryCounts;
      /** Distinct log tags seen so far, sorted. */
      tags: string[];
      /** Parsed from the SDK's init line; null until one is seen. */
      sdkVersion: string | null;
      /** Epoch ms of the first/last timestamped line, for the Range field. */
      startTimeMs: number | null;
      endTimeMs: number | null;
    }
  | { type: 'analyzer.problemsAdded'; items: import('../logAnalyzer/types.js').ProblemInstance[] }
  | { type: 'analyzer.sessionsUpdated'; sessions: import('../logAnalyzer/types.js').Session[] }
  | { type: 'analyzer.histogramsUpdated'; histograms: import('../logAnalyzer/types.js').AnalyzerState['histograms'] }
  | { type: 'analyzer.error'; stage: 'backfill' | 'live'; message: string }
  | {
      type: 'analyzer.linesResult';
      requestId: string;
      items: import('../logAnalyzer/types.js').LogLine[];
      /** Absolute index of `items[0]` within the filtered result set. The table
       *  positions rows by absolute index, so it cannot place a windowed
       *  response without knowing where the window starts. */
      offset: number;
      /** Rows matching the filter, before windowing. */
      total: number;
    }
  | {
      type: 'analyzer.lineDetail';
      requestId: string;
      line: import('../logAnalyzer/types.js').LogLine | null;
      before: import('../logAnalyzer/types.js').LogLine[];
      after: import('../logAnalyzer/types.js').LogLine[];
    };

/** Webview → host: user controls + reveal requests. */
export type AnalyzerIn =
  | { type: 'analyzer.clear' }
  | { type: 'analyzer.pause' }
  | { type: 'analyzer.resume' }
  | { type: 'analyzer.openPatternEditor' }
  | {
      type: 'analyzer.queryLines';
      filter: 'all' | 'critical' | 'error' | 'warn' | 'problem';
      search?: string;
      limit?: number;
      offset?: number;
      requestId: string;
    }
  | { type: 'analyzer.requestLineDetail'; lineId: number; requestId: string };

// ─── Debug console (SDK 5.1 `debug_socket`) ─────────────────
// The Debug Console is the CLIENT side of the SDK's debug socket
// (crates/ditto-peer/src/subsystems/debug_socket.rs): when a running app has
// `ALTER SYSTEM SET debug_socket = '/path/to.sock'` applied, the SDK listens
// on that Unix socket and serves newline-delimited DQL — one statement per
// line, one reply line per statement (a JSON array of result items, or a
// line starting with `ERROR:`). Host side: src/ditto/DebugSocketClient.ts +
// src/panels/DebugConsolePanel.ts. It is deliberately INDEPENDENT of the
// extension's own Ditto connection — no connection needs to be open, and the
// socket serves full DQL (mutations, ALTER SYSTEM) by default, which is why
// the webview carries a persistent live-mutation warning.

type DebugConsoleConnectionState = 'disconnected' | 'connecting' | 'connected';

/** One executed statement + its outcome, appended to the webview's
 *  bounded in-session history (never persisted). */
interface DebugConsoleRun {
  statement: string;
  ok: boolean;
  /** Server-side error (`ERROR:` line) or client-side failure (timeout,
   *  disconnect, malformed reply, queue full). Set iff `ok === false`. */
  error?: string;
  /** Result items, capped host-side at MAX_QUERY_ROWS (mirrors the Query
   *  Editor convention — the debug socket bypasses the service-layer
   *  10 MiB remote-query cap, so the client must cap for display). */
  rows?: unknown[];
  /** Uncapped item count actually returned by the socket. */
  totalRowCount: number;
  /** True when `totalRowCount > rows.length`. */
  truncated: boolean;
  durationMs: number;
}

export type DebugConsoleIn =
  | { type: 'debugConsole.connect'; path: string }
  | { type: 'debugConsole.disconnect' }
  | { type: 'debugConsole.run'; statement: string };

export type DebugConsoleOut =
  /** Pushed in response to debugConsole.connect/disconnect and whenever the
   *  socket drops on its own (remote close, timeout teardown).
   *  `path` is echoed on connected; `error` carries the failure message on
   *  disconnected; `pathWarning` is the non-blocking darwin 104-byte Unix
   *  socket path limit notice, computed at connect time. */
  | {
      type: 'debugConsole.state';
      state: DebugConsoleConnectionState;
      path?: string;
      error?: string;
      pathWarning?: string;
    }
  | { type: 'debugConsole.runResult'; run: DebugConsoleRun };

// ─── Pattern Editor panel ──────────────────────────────────────
/** Host → webview: pattern catalog snapshot + save results.
 *  (Distinct from EditorIn/EditorOut which belong to the database editor.) */
export type PatternEditorOut =
  | { type: 'patternEditor.snapshot'; bundled: import('../logAnalyzer/PatternEngine.js').KeyedRawPattern[]; user: import('../logAnalyzer/PatternEngine.js').KeyedRawPattern[] }
  | { type: 'patternEditor.saveOk'; key: string }
  | { type: 'patternEditor.saveFailed'; key: string; message: string };

/** Webview → host: CRUD requests over user patterns. */
export type PatternEditorIn =
  | { type: 'patternEditor.save'; pattern: import('../logAnalyzer/PatternEngine.js').KeyedRawPattern; replaceKey?: string }
  | { type: 'patternEditor.delete'; key: string };
