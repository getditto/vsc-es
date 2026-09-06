// Pure switch orchestrator. All VS Code touchpoints are injected via the
// `ui` and `panels` shims so this module is unit-testable. Only types may
// be imported from `vscode`; there must be no runtime dependency on it.

import type { OpenPanelsTracker } from './OpenPanelsTracker.js';
import type { Logger } from '../logging/types.js';
import type { StoredDittoConfig, SecretSet, StoredSubscription } from '../models/DittoConfig.js';
import type { LifecycleState } from './lifecycle-state.js';

export interface FromActive {
  id: string;
  name: string;
}

interface SwitchManager {
  connect(config: StoredDittoConfig, secrets: SecretSet, initialSubs?: StoredSubscription[]): Promise<void>;
  disconnect(): Promise<void>;
  isSwitchInProgress(): boolean;
  getCurrentLifecycleState(): LifecycleState;
}

interface SwitchConfigStore {
  get(id: string): StoredDittoConfig | undefined;
}

interface SwitchSecretStore {
  read(id: string): Promise<SecretSet>;
}

interface SwitchSubStore {
  list(id: string): StoredSubscription[];
}

interface ProgressNotifier {
  report(o: { message: string }): void;
}

interface StatusBarHandle {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

interface SwitchUi {
  showModalWarn(opts: { message: string; buttons: string[] }): Promise<string | undefined>;
  showError(message: string): void;
  withProgress<T>(title: string, work: (notif: ProgressNotifier) => Promise<T>): Promise<T>;
  statusBarItem(): StatusBarHandle;
}

interface SwitchPanels {
  closeQuery(): void;
  closePeers(): void;
  closeSubscription(): void;
  /** Dispose the Query Metrics panel if it's open. Per-DB history, so
   *  it must close on DB switch — otherwise the user would see the
   *  previous connection's history through a panel labelled with its
   *  old DB name. */
  closeQueryMetrics(): void;
  /** Dispose the Database Metrics panel if it's open. Same per-DB
   *  reasoning as the Query Metrics close. */
  closeDatabaseMetrics(): void;
  /** Dispose the System Metrics panel if it's open. Its accumulated
   *  since-connect totals belong to the previous connection — leaving it
   *  open across a switch would keep folding the NEW database's deltas
   *  into numbers labelled with the old one. Same per-DB reasoning as
   *  the Query Metrics close. */
  closeSystemMetrics(): void;
  /** Dispose the Import Data panel if it's open. Carries a buffered
   *  document array tied to the current connection — switching DBs
   *  while that buffer is alive would let the user import into the
   *  wrong store. Same per-DB reasoning as the metrics closes. */
  closeImportData(): void;
  /** Dispose all Observer panels. Each panel holds a live SDK observer
   *  registered against the previous DB — leaving them open across a
   *  switch would keep those observers running against a torn-down
   *  store and surface stale data under the wrong DB name. */
  closeObserver(): void;
  /** Close any open ObserverEditorPanel. Same DB-switch teardown
   *  reasoning as closeSubscription. */
  closeObserverEditor(): void;
  /** Dispose the Add Index panel if it's open. Its collection list is a
   *  snapshot of the previous DB, and Create would run DDL against the
   *  newly-active store. */
  closeAddIndex(): void;
  /** Dispose the Import Subscriptions panel if it's open. Its server-side
   *  subscription list and target databaseId belong to the previous
   *  connection — importing through it would write into the wrong store. */
  closeImportSubscriptions(): void;
  /** Open a Query Editor on `databaseId`. The optional `queryText`
   *  preloads the editor — used during restore to bring back the
   *  user's saved query body. */
  showQuery(databaseId: string, queryText?: string): void;
  showPeers(databaseId: string): void;
}

export interface SwitchDeps {
  manager: SwitchManager;
  configStore: SwitchConfigStore;
  secretStore: SwitchSecretStore;
  subStore: SwitchSubStore;
  tracker: OpenPanelsTracker;
  logger: Logger;
  ui: SwitchUi;
  panels: SwitchPanels;
}

/** Pre-switch confirmation modal. MUST be called BEFORE acquiring the
 *  connection-persistence lock: a modal can stay open indefinitely, and
 *  `deactivate()` waits on the lock tail — a modal shown inside the lock
 *  can deadlock VS Code shutdown/window-reload behind a dialog the user
 *  may never see. Returns true if the switch should proceed.
 *
 *  The panel set is re-derived at teardown time, so a panel opened or
 *  closed while the modal is up only makes the message slightly stale —
 *  never blocks or corrupts the switch. */
export async function confirmSwitch(
  deps: SwitchDeps,
  fromActive: FromActive | null,
  to: StoredDittoConfig,
): Promise<boolean> {
  if (!fromActive) { return true; }
  const { tracker, logger, ui } = deps;
  const log = logger.withTag('ext:switch');
  const state = tracker.get(fromActive.id);
  const labels: string[] = [];
  if (state.query.length === 1) labels.push(`Query Editor — ${fromActive.name}`);
  else if (state.query.length > 1) labels.push(`${state.query.length} Query Editors — ${fromActive.name}`);
  if (state.peers) labels.push(`Presence — ${fromActive.name}`);
  if (labels.length === 0) { return true; }
  const totalCount = state.query.length + (state.peers ? 1 : 0);
  const ok = await ui.showModalWarn({
    message:
      `Switching to "${to.name}" will close ${totalCount} open panel${totalCount === 1 ? '' : 's'} for "${fromActive.name}":\n` +
      `   • ${labels.join('\n   • ')}\n\n` +
      `These will reopen automatically the next time you connect to "${fromActive.name}".`,
    buttons: ['Switch'],
  });
  if (ok !== 'Switch') {
    log.debug('Switch cancelled by user', { fromId: fromActive.id, toId: to.id });
    return false;
  }
  return true;
}

/** Outcome of performSwitch. The switch work itself always runs to
 *  completion (panels closed, connect attempted, target panels restored on
 *  success); a failed connect is REPORTED here rather than handled with an
 *  in-lock modal — see confirmRollback. */
export type SwitchOutcome =
  | { kind: 'connected' }
  | {
      kind: 'connect-failed';
      /** Human-readable failure description (includes the target's name
       *  when a rollback target exists). */
      message: string;
      /** The previously-active connection that was torn down before the
       *  failed connect, or null when this was an initial connect. When
       *  non-null the caller should offer rollback via confirmRollback +
       *  rollbackSwitch AFTER the connection-persistence lock is released. */
      rollback: FromActive | null;
    };

/** Performs the teardown + target connect + panel restore. Runs under the
 *  caller's connection-persistence lock, so it must NEVER show a modal (see
 *  confirmSwitch for why). `fromActive` must be freshly recomputed inside
 *  that lock — a value captured before a pre-switch modal can name a
 *  connection the user has already left. */
export async function performSwitch(
  deps: SwitchDeps,
  fromActive: FromActive | null,
  to: StoredDittoConfig,
): Promise<SwitchOutcome> {
  const { secretStore, subStore, manager, logger, ui, panels } = deps;
  const log = logger.withTag('ext:switch');

  // 2. Combined progress UI.
  const title = fromActive ? `Switching to "${to.name}"` : `Connecting to "${to.name}"`;
  return ui.withProgress(title, async (notif) => {
    const statusItem = ui.statusBarItem();
    statusItem.setText(`$(sync~spin) Ditto: ${fromActive ? 'switching to' : 'connecting'} ${to.name}`);
    statusItem.show();
    try {
      // 3. Tear down (dispose panels + disconnect).
      if (fromActive) {
        notif.report({ message: `Disconnecting from ${fromActive.name}…` });
        statusItem.setText(`$(sync~spin) Ditto: disconnecting ${fromActive.name}`);
        notif.report({ message: 'Closing panels…' });
        panels.closeQuery();
        panels.closePeers();
        panels.closeSubscription();
        panels.closeQueryMetrics();
        panels.closeDatabaseMetrics();
        panels.closeSystemMetrics();
        panels.closeImportData();
        panels.closeObserver();
        panels.closeObserverEditor();
        panels.closeAddIndex();
        panels.closeImportSubscriptions();
        await manager.disconnect();
      }

      // 4. Activate target.
      notif.report({ message: `Connecting to ${to.name}…` });
      statusItem.setText(`$(sync~spin) Ditto: connecting ${to.name}`);
      const secrets = await secretStore.read(to.id);
      const initialSubs = subStore.list(to.id);
      try {
        await manager.connect(to, secrets, initialSubs);
      } catch (err) {
        // 5. Failure is REPORTED, not handled: the rollback decision needs a
        // modal, and this function runs inside the connection-persistence
        // lock — a modal held there can deadlock VS Code shutdown. The
        // caller re-prompts with confirmRollback() after releasing the lock.
        const detail = err instanceof Error ? err.message : String(err);
        log.error('Connect to target failed', { toId: to.id, err: detail });
        if (!fromActive) {
          // Initial connect failure: just toast, no rollback possible.
          ui.showError(`Connect failed: ${detail}`);
          return { kind: 'connect-failed', message: `Connect failed: ${detail}`, rollback: null };
        }
        return {
          kind: 'connect-failed',
          message: `Connect to "${to.name}" failed: ${detail}`,
          rollback: fromActive,
        };
      }

      // 6. Restore target's panels.
      notif.report({ message: 'Restoring panels…' });
      statusItem.setText(`$(sync~spin) Ditto: restoring panels`);
      await restorePanels(deps, to.id);
      return { kind: 'connected' };
    } finally {
      statusItem.dispose();
    }
  });
}

/** Post-failure rollback decision modal. MUST be called AFTER the
 *  connection-persistence lock is released: like confirmSwitch, the modal
 *  can stay open indefinitely and `deactivate()` waits on the lock tail, so
 *  a modal inside the lock can deadlock VS Code shutdown behind a dialog
 *  the user may never see. Returns true if the user chose to reconnect to
 *  the previous database. */
export async function confirmRollback(
  deps: SwitchDeps,
  fromActive: FromActive,
  failureMessage: string,
): Promise<boolean> {
  const { ui } = deps;
  const reconnectLabel = `Reconnect to ${fromActive.name}`;
  const choice = await ui.showModalWarn({
    message: `${failureMessage}.\nReconnect to "${fromActive.name}"?`,
    buttons: [reconnectLabel, 'Stay disconnected'],
  });
  return choice === reconnectLabel;
}

/** Rollback execution: reconnect to the previously-active config and
 *  restore its panels. Contains NO modals, so it is safe to run inside a
 *  fresh connection-persistence lock. Mirrors the semantics the in-lock
 *  rollback used to have: missing config or a failed reconnect both
 *  surface an error toast and leave the extension disconnected. */
export async function rollbackSwitch(
  deps: SwitchDeps,
  fromActive: FromActive,
): Promise<void> {
  const { configStore, secretStore, subStore, manager, logger, ui } = deps;
  const log = logger.withTag('ext:switch');
  await ui.withProgress(`Reconnecting to "${fromActive.name}"`, async (notif) => {
    const statusItem = ui.statusBarItem();
    statusItem.setText(`$(sync~spin) Ditto: reconnecting ${fromActive.name}`);
    statusItem.show();
    try {
      notif.report({ message: `Reconnecting to ${fromActive.name}…` });
      const fromCfg = configStore.get(fromActive.id);
      if (!fromCfg) {
        ui.showError('Original DB config no longer available.');
        return;
      }
      const fromSecrets = await secretStore.read(fromCfg.id);
      const fromSubs = subStore.list(fromCfg.id);
      try {
        await manager.connect(fromCfg, fromSecrets, fromSubs);
      } catch (err2) {
        log.error('Rollback connect failed', { fromId: fromActive.id, err: String(err2) });
        ui.showError(
          `Reconnect to "${fromActive.name}" also failed: ${err2 instanceof Error ? err2.message : String(err2)}.\nBoth connections offline.`,
        );
        return;
      }
      // Restore fromActive's panels.
      await restorePanels(deps, fromActive.id);
    } finally {
      statusItem.dispose();
    }
  });
}

async function restorePanels(deps: SwitchDeps, databaseId: string): Promise<void> {
  const { tracker, panels } = deps;
  // Snapshot the saved state, then wipe the query slate before
  // recreating panels — each restored panel re-registers itself with
  // a fresh tabId, and without the wipe the array would grow on
  // every reconnect (saved entries + newly added entries).
  const snapshot = tracker.get(databaseId);
  await tracker.clearQueryTabs(databaseId);
  for (const tab of snapshot.query) {
    panels.showQuery(databaseId, tab.text);
  }
  if (snapshot.peers) {
    panels.showPeers(databaseId);
  }
}
