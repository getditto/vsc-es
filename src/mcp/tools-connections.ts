import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { StoredDittoConfig } from '../models/DittoConfig.js';
import { ok, errFrom } from './tool-result.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';

/**
 * Credential hygiene (SwiftUI parity): list_databases / get_active_database
 * NEVER return token, secretKey, or httpApiKey — only an `httpApiConfigured`
 * boolean leaks that a key exists at all.
 */

function publicListEntry(ctx: McpToolContext, cfg: StoredDittoConfig): Record<string, unknown> {
  return {
    id: cfg.id,
    name: cfg.name,
    databaseId: cfg.databaseId,
    mode: cfg.mode,
    status: ctx.manager.getStatus(cfg.id),
  };
}

async function listDatabases(ctx: McpToolContext): Promise<CallToolResult> {
  const configs = ctx.configStore.list().map(c => publicListEntry(ctx, c));
  return ok(configs);
}

async function getActiveDatabase(ctx: McpToolContext): Promise<CallToolResult> {
  const id = ctx.manager.getActiveConfigId();
  const cfg = id ? ctx.configStore.get(id) : undefined;
  if (!id || !cfg) {
    // The SwiftUI server answers this case with its noActiveDatabase error;
    // same remediation text, delivered on the isError channel.
    return errFrom(new Error(
      'No active database. Connect to a database first (the connect_database tool, or the Ditto sidebar in VS Code).',
    ));
  }
  const secrets = await ctx.secretStore.read(id);
  const snapshot = ctx.manager.getLatestSnapshot();
  const cloudPeer = snapshot.remote.find(p => p.isDittoServer);
  return ok({
    id: cfg.id,
    name: cfg.name,
    databaseId: cfg.databaseId,
    mode: cfg.mode,
    authUrl: cfg.authUrl,
    httpApiUrl: cfg.httpApiUrl || undefined,
    httpApiConfigured: typeof secrets.httpApiKey === 'string' && secrets.httpApiKey.length > 0,
    allowUntrustedCerts: cfg.allowUntrustedCerts,
    logLevel: cfg.logLevel,
    isStrictModeEnabled: cfg.isStrictModeEnabled,
    transport: {
      lan: cfg.isLanEnabled ?? true,
      bluetoothLE: cfg.isBluetoothLeEnabled ?? false,
      awdl: cfg.isAwdlEnabled ?? false,
    },
    sync: ctx.manager.getSyncState(),
    lifecycle: ctx.manager.getCurrentLifecycleState().kind,
    connectedPeers: snapshot.remote.filter(p => !p.isDittoServer).length,
    cloudSyncConnected: cloudPeer?.syncSessionStatus === 'Connected',
  });
}

export const connectionTools: ToolDef[] = [
  tool({
    name: 'list_databases',
    description:
      'List all Ditto database connections registered in this VS Code extension. ' +
      'Returns id, name, databaseId, mode, and live status for each — never credentials.',
    schema: {},
    handler: (ctx) => listDatabases(ctx),
  }),
  tool({
    name: 'get_active_database',
    description:
      'Describe the currently connected database: identity, mode, URLs, transport toggles, ' +
      'sync state, and peer counts. Credential values are never returned (httpApiConfigured ' +
      'is reported as a boolean only).',
    schema: {},
    handler: (ctx) => getActiveDatabase(ctx),
  }),
  // NOTE: connect_database / disconnect_database are added by the
  // headless-automation slice in a later commit; they exercise
  // ctx.automation (switch orchestrator minus the modal UX).
];
