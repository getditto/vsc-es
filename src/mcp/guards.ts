import type { McpToolContext } from './context.js';
import type { StoredDittoConfig } from '../models/DittoConfig.js';

/** Uniform "nothing is connected" failure — the SwiftUI server throws
 *  `noActiveDatabase` for the same case, with the same remediation shape. */
export const NO_ACTIVE_CONNECTION_MESSAGE =
  'No active connection. Connect to a database first (the connect_database tool, or the Ditto sidebar in VS Code).';

/** The active config, or throw. Tools that touch the store call this
 *  first so the error message is uniform and the session race (disconnect
 *  mid-request) collapses to the same error. */
export function requireActiveConfig(ctx: McpToolContext): StoredDittoConfig {
  const id = ctx.manager.getActiveConfigId();
  const cfg = id ? ctx.configStore.get(id) : undefined;
  if (!id || !cfg) { throw new Error(NO_ACTIVE_CONNECTION_MESSAGE); }
  return cfg;
}
