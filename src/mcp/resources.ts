import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from './context.js';
import { resolveConnection } from './guards.js';

/**
 * Read-only MCP resources — point-in-time JSON snapshots agents can fetch
 * without learning tool-call shapes. Everything that needs arguments stays
 * a tool; these are the argument-free live views.
 *
 * No-connection reads return an error-shaped JSON BODY (never a protocol
 * error) so a client enumerating resources early still sees valid JSON.
 */

const JSON_MIME = 'application/json';

function jsonContents(uri: string, payload: unknown) {
  return {
    contents: [{
      uri,
      mimeType: JSON_MIME,
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function noConnection(uri: string, resource: string) {
  return jsonContents(uri, {
    error: 'no_active_connection',
    message: `Nothing is connected. ${resource} needs an active database — connect via the connect_database tool or the Ditto sidebar, then re-read.`,
    hint: 'get_active_database reports the live connection state.',
  });
}

export function registerAllResources(server: McpServer, ctx: McpToolContext): void {
  server.registerResource(
    'schema',
    'ditto://schema',
    { description: 'Collections with live document counts and indexes for the active database.', mimeType: JSON_MIME },
    async (uri) => {
      if (!ctx.manager.getActiveConfigId()) { return noConnection(uri.href, 'ditto://schema'); }
      // Live re-hydrate — same discipline as list_collections: the cache
      // can lag creation that happened before the observer attached.
      try {
        await ctx.collectionsRepo.refresh();
      } catch (e) {
        return jsonContents(uri.href, { error: 'refresh_failed', message: e instanceof Error ? e.message : String(e) });
      }
      return jsonContents(uri.href, {
        collections: ctx.collectionsRepo.current().map(c => ({
          name: c.name,
          documentCount: c.documentCount,
          indexes: c.indexes.map(i => ({
            name: i.displayName,
            collection: i.collection,
            fields: i.fields.map(f => `${f.name} ${f.ascending ? 'ASC' : 'DESC'}`),
          })),
        })),
      });
    },
  );

  server.registerResource(
    'peers',
    'ditto://peers',
    { description: 'Latest presence snapshot: local device + direct peers + raw multi-hop graph.', mimeType: JSON_MIME },
    async (uri) => {
      if (!ctx.manager.getActiveConfigId()) { return noConnection(uri.href, 'ditto://peers'); }
      const snap = ctx.manager.getLatestSnapshot();
      return jsonContents(uri.href, snap);
    },
  );

  server.registerResource(
    'sync-status',
    'ditto://sync-status',
    { description: 'Sync on/off + peer counts for the active connection.', mimeType: JSON_MIME },
    async (uri) => {
      const id = ctx.manager.getActiveConfigId();
      const cfg = id ? ctx.configStore.get(id) : undefined;
      if (!id || !cfg) { return noConnection(uri.href, 'ditto://sync-status'); }
      const snap = ctx.manager.getLatestSnapshot();
      const cloud = snap.remote.find(p => p.isDittoServer);
      return jsonContents(uri.href, {
        database: { id: cfg.id, name: cfg.name, databaseId: cfg.databaseId },
        sync: ctx.manager.getSyncState(),
        connectedPeers: snap.remote.filter(p => !p.isDittoServer).length,
        cloudSyncConnected: cloud?.syncSessionStatus === 'Connected',
      });
    },
  );

  server.registerResource(
    'system-metrics',
    'ditto://system-metrics',
    { description: 'Latest ACCUMULATED system:metrics snapshot (no fresh read — reads flush the exporter registry).', mimeType: JSON_MIME },
    async (uri) => {
      const id = ctx.manager.getActiveConfigId();
      if (!id) { return noConnection(uri.href, 'ditto://system-metrics'); }
      const service = ctx.systemMetricsHub.serviceFor(id);
      const snapshot = service?.currentSnapshot();
      if (!snapshot) {
        return jsonContents(uri.href, {
          status: 'no-data-yet',
          message: 'No system-metrics read has happened yet for this connection. Call the get_system_metrics tool once to force a read, or open the System Metrics panel.',
        });
      }
      return jsonContents(uri.href, { status: 'ok', snapshot });
    },
  );

  server.registerResource(
    'subscriptions',
    'ditto://subscriptions',
    { description: 'Persisted sync subscription definitions for the active database.', mimeType: JSON_MIME },
    async (uri) => {
      try {
        const cfg = resolveConnection(ctx);
        return jsonContents(uri.href, { database: { id: cfg.id, name: cfg.name }, subscriptions: ctx.subscriptionStore.list(cfg.id) });
      } catch {
        return noConnection(uri.href, 'ditto://subscriptions');
      }
    },
  );

  server.registerResource(
    'observers',
    'ditto://observers',
    { description: 'Persisted observer definitions for the active database.', mimeType: JSON_MIME },
    async (uri) => {
      try {
        const cfg = resolveConnection(ctx);
        return jsonContents(uri.href, { database: { id: cfg.id, name: cfg.name }, observers: ctx.observerStore.list(cfg.id) });
      } catch {
        return noConnection(uri.href, 'ditto://observers');
      }
    },
  );
}
