// Pure switch orchestrator. All VS Code touchpoints are injected via the
// `ui` and `panels` shims so this module is unit-testable. Only types may
// be imported from `vscode`; there must be no runtime dependency on it.

import type { OpenPanelsTracker, OpenPanelKind } from './OpenPanelsTracker.js';
import type { Logger } from '../logging/types.js';
import type { StoredDittoConfig, SecretSet, StoredSubscription } from '../models/DittoConfig.js';
import type { LifecycleState } from './lifecycle-state.js';

export interface FromActive {
  id: string;
  name: string;
}

export interface SwitchManager {
  connect(config: StoredDittoConfig, secrets: SecretSet, initialSubs?: StoredSubscription[]): Promise<void>;
  disconnect(): Promise<void>;
  isSwitchInProgress(): boolean;
  getCurrentLifecycleState(): LifecycleState;
}

export interface SwitchConfigStore {
  get(id: string): StoredDittoConfig | undefined;
}

export interface SwitchSecretStore {
  read(id: string): Promise<SecretSet>;
}

export interface SwitchSubStore {
  list(id: string): StoredSubscription[];
}

export interface ProgressNotifier {
  report(o: { message: string }): void;
}

export interface StatusBarHandle {
  setText(text: string): void;
  show(): void;
  dispose(): void;
}

export interface SwitchUi {
  showModalWarn(opts: { message: string; buttons: string[] }): Promise<string | undefined>;
  showError(message: string): void;
  showInfo(message: string): void;
  withProgress(title: string, work: (notif: ProgressNotifier) => Promise<void>): Promise<void>;
  statusBarItem(): StatusBarHandle;
}

export interface SwitchPanels {
  closeQuery(): void;
  closePeers(): void;
  closeSubscription(): void;
  showQuery(databaseId: string): void;
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

export async function performSwitch(
  deps: SwitchDeps,
  fromActive: FromActive | null,
  to: StoredDittoConfig,
): Promise<void> {
  const { configStore, secretStore, subStore, tracker, manager, logger, ui, panels } = deps;
  const log = logger.withTag('ext:switch');

  // 1. Pre-switch warning if fromActive has open panels.
  if (fromActive) {
    const open: OpenPanelKind[] = tracker.list(fromActive.id);
    if (open.length > 0) {
      const labels = open.map(k => k === 'query' ? `Query — ${fromActive.name}` : `Peers — ${fromActive.name}`);
      const ok = await ui.showModalWarn({
        message:
          `Switching to "${to.name}" will close ${open.length} open panels for "${fromActive.name}":\n` +
          `   • ${labels.join('\n   • ')}\n\n` +
          `These will reopen automatically the next time you connect to "${fromActive.name}".`,
        buttons: ['Switch'],
      });
      if (ok !== 'Switch') {
        log.debug('Switch cancelled by user', { fromId: fromActive.id, toId: to.id });
        return;
      }
    }
  }

  // 2. Combined progress UI.
  const title = fromActive ? `Switching to "${to.name}"` : `Connecting to "${to.name}"`;
  await ui.withProgress(title, async (notif) => {
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
        // 5. Rollback prompt.
        log.error('Connect to target failed', { toId: to.id, err: String(err) });
        if (!fromActive) {
          // Initial connect failure: just toast.
          ui.showError(`Connect failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const reconnectLabel = `Reconnect to ${fromActive.name}`;
        const choice = await ui.showModalWarn({
          message:
            `Connect to "${to.name}" failed: ${err instanceof Error ? err.message : String(err)}.\n` +
            `Reconnect to "${fromActive.name}"?`,
          buttons: [reconnectLabel, 'Stay disconnected'],
        });
        if (choice === reconnectLabel) {
          notif.report({ message: `Reconnecting to ${fromActive.name}…` });
          statusItem.setText(`$(sync~spin) Ditto: reconnecting ${fromActive.name}`);
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
          return;
        }
        return; // stay disconnected
      }

      // 6. Restore target's panels.
      notif.report({ message: 'Restoring panels…' });
      statusItem.setText(`$(sync~spin) Ditto: restoring panels`);
      await restorePanels(deps, to.id);
    } finally {
      statusItem.dispose();
    }
  });
}

export async function restorePanels(deps: SwitchDeps, databaseId: string): Promise<void> {
  const { tracker, panels } = deps;
  for (const kind of tracker.list(databaseId)) {
    if (kind === 'query') panels.showQuery(databaseId);
    if (kind === 'peers') panels.showPeers(databaseId);
  }
}
