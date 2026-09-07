import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok } from './tool-result.js';
import { requireActiveConfig } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import type { PeerInfo, StoredDittoConfig } from '../models/DittoConfig.js';

/** Exported for the ditto://peers resource: the metadata-bodies-off-the-wire
 *  policy must hold on every MCP surface, not just the get_peers tool. */
export function peerToJson(p: PeerInfo): Record<string, unknown> {
  return {
    peerKey: p.id,
    deviceName: p.deviceName,
    os: p.os,
    sdkVersion: p.dittoSdkVersion,
    isDittoServer: p.isDittoServer,
    connectionStatus: p.syncSessionStatus,
    isConnectedToDittoServer: p.isConnectedToDittoServer,
    connections: p.connections.map(c => ({ type: c.connectionType })),
    // Metadata bodies ride the presence graph as unvalidated up-to-4 KB
    // blobs; over MCP we ship COUNTS only, same policy as the presence
    // graph webview (see RawPresenceGraphPeer in models/DittoConfig.ts).
    peerMetadataKeyCount: p.peerMetadata ? Object.keys(p.peerMetadata).length : 0,
    identityMetadataKeyCount: p.identityMetadata ? Object.keys(p.identityMetadata).length : 0,
    syncedUpToLocalCommitId: p.syncedUpToLocalCommitId,
    lastUpdateReceivedTime: p.lastUpdateReceivedTime,
  };
}

/**
 * THE peer-count contract — one definition for every surface (tools AND the
 * ditto://sync-status resource), because an agent that gets different peer
 * counts from two endpoints will contradict itself when reporting health:
 *
 *   merged Remote rows = direct peers + the SYNTHETIC Ditto Cloud Server row
 *   presenceGraph.remotePeers = what the SDK's raw presence graph reports
 *                               (no synthetic row)
 *   connectedPeers = direct small peers, cloud row EXCLUDED
 *
 * Cloud state rides its own boolean (cloudSyncConnected) everywhere instead
 * of inflating a count.
 */
export interface SyncStatusPayload {
  database: { id: string; name: string; databaseId: string };
  sync: 'active' | 'idle';
  connectedPeers: number;
  cloudSyncConnected: boolean;
  transport: { lan: boolean; bluetoothLE: boolean; awdl: boolean };
}

export function buildSyncStatusPayload(ctx: McpToolContext, cfg: StoredDittoConfig): SyncStatusPayload {
  const snapshot = ctx.manager.getLatestSnapshot();
  const cloudPeer = snapshot.remote.find(p => p.isDittoServer);
  return {
    database: { id: cfg.id, name: cfg.name, databaseId: cfg.databaseId },
    sync: ctx.manager.getSyncState(),
    connectedPeers: snapshot.remote.filter(p => !p.isDittoServer).length,
    cloudSyncConnected: cloudPeer?.syncSessionStatus === 'Connected',
    transport: {
      lan: cfg.isLanEnabled ?? true,
      bluetoothLE: cfg.isBluetoothLeEnabled ?? false,
      awdl: cfg.isAwdlEnabled ?? false,
    },
  };
}

async function getSyncStatus(ctx: McpToolContext): Promise<CallToolResult> {
  const cfg = requireActiveConfig(ctx);
  return ok(buildSyncStatusPayload(ctx, cfg));
}

async function setSync(ctx: McpToolContext, args: { enabled: boolean }): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  const before = ctx.manager.getSyncState();
  const want: 'active' | 'idle' = args.enabled ? 'active' : 'idle';
  const after = before === want ? before : await ctx.manager.toggleSync();
  return ok({ sync: after === 'active' ? 'started' : 'stopped', enabled: after === 'active' });
}

interface TransportArgs { lan?: boolean; ble?: boolean; awdl?: boolean }

async function configureTransport(ctx: McpToolContext, args: TransportArgs): Promise<CallToolResult> {
  const cfg = requireActiveConfig(ctx);
  if (ctx.manager.isApplyingTransports()) {
    throw new Error('A transport change is already in progress — retry after it completes.');
  }
  // Omitted = unchanged: merge over the persisted prefs (which the previous
  // apply wrote back to the config, and which connect() itself honoured).
  const merged = {
    isLanEnabled: args.lan ?? cfg.isLanEnabled ?? true,
    isBluetoothLeEnabled: args.ble ?? cfg.isBluetoothLeEnabled ?? false,
    isAwdlEnabled: args.awdl ?? cfg.isAwdlEnabled ?? false,
  };
  await ctx.manager.applyTransportConfig(merged);
  return ok({ transport: { lan: merged.isLanEnabled, bluetoothLE: merged.isBluetoothLeEnabled, awdl: merged.isAwdlEnabled } });
}

async function getPeers(ctx: McpToolContext): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  const snapshot = ctx.manager.getLatestSnapshot();
  const nonServerPeers = snapshot.remote.filter(p => !p.isDittoServer);
  const cloudPeer = snapshot.remote.find(p => p.isDittoServer);
  return ok({
    // Same convention as get_sync_status / ditto://sync-status: the cloud
    // server is NOT a peer count. `peers` still carries its row, flagged.
    count: nonServerPeers.length,
    connectedPeers: nonServerPeers.length,
    cloudSyncConnected: cloudPeer?.syncSessionStatus === 'Connected',
    totalRowsIncludingCloudRow: snapshot.remote.length,
    local: snapshot.local,
    peers: snapshot.remote.map(peerToJson),
    // Raw SDK graph (no synthetic cloud row, multi-hop edges included).
    presenceGraph: snapshot.presenceGraph,
  });
}

export const syncTools: ToolDef[] = [
  tool({
    name: 'get_sync_status',
    description:
      'Sync state of the active database: sync running/stopped, connected peer count, ' +
      'cloud connection, and the enabled transports.',
    schema: {},
    handler: (ctx) => getSyncStatus(ctx),
  }),
  tool({
    name: 'set_sync',
    description: 'Start or stop sync on the active database, like the toolbar sync toggle.',
    schema: { enabled: z.boolean() },
    handler: (ctx, args: { enabled: boolean }) => setSync(ctx, args),
  }),
  tool({
    name: 'configure_transport',
    description:
      'Enable/disable network transports on the active database (lan, ble, awdl; omit a key ' +
      'to leave it unchanged). Sync restarts around the apply and the change persists to the ' +
      'connection. Platform-incompatible requests are ignored by the OS gate.',
    schema: {
      lan: z.boolean().optional().describe('LAN transports (mDNS + multicast + TCP).'),
      ble: z.boolean().optional().describe('Bluetooth Low Energy.'),
      awdl: z.boolean().optional().describe('Apple Wireless Direct Link (macOS only).'),
    },
    handler: (ctx, args: TransportArgs) => configureTransport(ctx, args),
  }),
  tool({
    name: 'get_peers',
    description:
      'Snapshot of the presence graph: local device info, directly-connected peers with ' +
      'their connection types and sync progress, plus the raw multi-hop presenceGraph.',
    schema: {},
    handler: (ctx) => getPeers(ctx),
  }),
];
