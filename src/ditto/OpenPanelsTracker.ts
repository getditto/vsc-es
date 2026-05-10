import * as vscode from 'vscode';

/**
 * Per-database panel state — captures both *which* panels are open
 * AND the per-instance state needed to restore them faithfully on
 * reconnect (e.g. the text content of each Query Editor tab).
 *
 * Schema bumped from v1 (just a kind-set) to v2 to support multi-tab
 * Query Editor restoration. Old v1 keys are left as orphans; users
 * lose their saved panel state once on the upgrade, which is
 * acceptable for the feature gain.
 */
export interface QueryTabState {
  /** Unique-per-tab id. Generated on construction and used as the
   *  tracking key while the panel lives. Re-used as a stable handle
   *  for upsert semantics in the store. */
  id: string;
  /** Current query text in the editor — the thing we restore on
   *  reconnect so the user gets their tabs back with their work. */
  text: string;
}

export interface PerDbPanelState {
  /** Ordered list of open Query Editor tabs. Multiple tabs are
   *  supported; restore opens them all in the same order. */
  query: QueryTabState[];
  /** Whether the Presence panel is open. Restored as a single
   *  toggle. */
  peers: boolean;
}

const KEY_PREFIX = 'dittoOpenPanels.v2.';

const EMPTY: PerDbPanelState = { query: [], peers: false };

export class OpenPanelsTracker {
  constructor(private readonly state: vscode.Memento) {}

  /** Snapshot of the current panel state for `databaseId`. */
  get(databaseId: string): PerDbPanelState {
    return this.state.get<PerDbPanelState>(KEY_PREFIX + databaseId) ?? EMPTY;
  }

  /** True when at least one panel of any kind is open for this DB.
   *  Used by the switch orchestrator's "you have open panels" warning. */
  hasAny(databaseId: string): boolean {
    const s = this.get(databaseId);
    return s.query.length > 0 || s.peers;
  }

  /** Total panel count for the warning dialog. */
  count(databaseId: string): number {
    const s = this.get(databaseId);
    return s.query.length + (s.peers ? 1 : 0);
  }

  /** Insert or update a Query Editor tab. Idempotent on `id` —
   *  the same tabId reuses its slot, which lets the panel emit
   *  text-change updates without thrashing the array's order. */
  async upsertQueryTab(databaseId: string, tab: QueryTabState): Promise<void> {
    const cur = this.get(databaseId);
    const idx = cur.query.findIndex(t => t.id === tab.id);
    const nextQuery = idx >= 0
      ? cur.query.map(t => t.id === tab.id ? tab : t)
      : [...cur.query, tab];
    await this.state.update(KEY_PREFIX + databaseId, { ...cur, query: nextQuery });
  }

  /** Remove a Query Editor tab by id. No-op if not present. */
  async removeQueryTab(databaseId: string, tabId: string): Promise<void> {
    const cur = this.get(databaseId);
    if (!cur.query.some(t => t.id === tabId)) { return; }
    const next: PerDbPanelState = { ...cur, query: cur.query.filter(t => t.id !== tabId) };
    await this.state.update(KEY_PREFIX + databaseId, next);
  }

  /** Drop all stored Query Editor tabs for this DB. Used on connect
   *  before restoration: the snapshot is read first, the slate is
   *  cleared, and each restored panel re-adds itself via upsertQueryTab.
   *  Without this, restored panels would duplicate the snapshot's
   *  entries and the array would grow on every reconnect. */
  async clearQueryTabs(databaseId: string): Promise<void> {
    const cur = this.get(databaseId);
    if (cur.query.length === 0) { return; }
    await this.state.update(KEY_PREFIX + databaseId, { ...cur, query: [] });
  }

  /** Toggle the Presence panel flag. */
  async setPeers(databaseId: string, open: boolean): Promise<void> {
    const cur = this.get(databaseId);
    if (cur.peers === open) { return; }
    await this.state.update(KEY_PREFIX + databaseId, { ...cur, peers: open });
  }

  /** Drop all per-DB panel state. Used by the delete-connection flow. */
  async deleteAll(databaseId: string): Promise<void> {
    await this.state.update(KEY_PREFIX + databaseId, undefined);
  }
}
