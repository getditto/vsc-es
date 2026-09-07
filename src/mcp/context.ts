import type { DittoManager } from '../ditto/DittoManager.js';
import type { CollectionsRepository } from '../ditto/CollectionsRepository.js';
import type { ConfigStore } from '../storage/ConfigStore.js';
import type { SecretStore } from '../storage/SecretStore.js';
import type { SubscriptionStore } from '../storage/SubscriptionStore.js';
import type { ObserverStore } from '../storage/ObserverStore.js';
import type { QueryMetricsStore } from '../storage/QueryMetricsStore.js';
import type { Logger } from '../logging/types.js';

/**
 * The service graph every MCP tool handler receives. Assembled once in
 * extension.ts and shared by all per-session McpServer instances — tools
 * are stateless adapters over these seams, exactly like the extension's
 * webview panels are.
 *
 * Every tool operates on the SINGLE active SDK session (DittoManager is a
 * one-instance-at-a-time owner); tools that need a session fail with the
 * `no_active_connection` message below until one exists.
 */
export interface McpToolContext {
  manager: DittoManager;
  configStore: ConfigStore;
  secretStore: SecretStore;
  collectionsRepo: CollectionsRepository;
  queryMetrics: QueryMetricsStore;
  subscriptionStore: SubscriptionStore;
  observerStore: ObserverStore;
  /** Untagged root logger — its readRecentLogLines powers the log tools. */
  logger: Logger;
  /** Extension globalStorage fsPath — the per-DB working directory lives
   *  at `<globalStorageFsPath>/dittoData/<configId>` (database metrics). */
  globalStorageFsPath: string;
  /** Drives headless connect/switch/disconnect through the same
   *  switch-orchestrator + persistence-lock semantics the Connect/Disconnect
   *  commands use (panel teardown included), minus the modal UX: the AI
   *  caller has already been told the switch closes panels. */
  automation: McpAutomation;
  /** Tagged 'mcp' — tool-level audit logging (NEVER include args that may
   *  carry secrets or document payloads; log tool name + coarse facts only). */
  log: Logger;
}

export type SwitchAttemptResult =
  | { kind: 'connected'; configId: string; name: string }
  | { kind: 'connect-failed'; message: string };

export interface McpAutomation {
  /** Connect to the given registered connection (id or name), switching
   *  away from whatever is active now. Throws when the id/name is unknown
   *  or a switch/transport apply is already in flight. */
  connect(configIdOrName: string): Promise<SwitchAttemptResult>;
  /** Disconnect the active session; no-op returning false when idle. */
  disconnect(): Promise<boolean>;
}
