import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err } from './tool-result.js';
import { resolveConnection } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import { isSelectStatement } from '../ditto/QueryProfileParser.js';
import { randomId } from '../util/id.js';

/**
 * Sync subscription definitions (SubscriptionStore) + live registration on
 * the active connection (mirrors the Subscription Editor's save semantics:
 * persisted definitions survive; live handles exist only while their
 * connection is active). No SwiftUI MCP counterpart exists — the SwiftUI
 * server never exposed the subscription store.
 */

interface ListArgs { database?: string }
interface AddArgs { name: string; query: string; database?: string }
interface RemoveArgs { id: string; database?: string }

function listSubscriptions(ctx: McpToolContext, args: ListArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  const activeId = ctx.manager.getActiveConfigId();
  const subs = ctx.subscriptionStore.list(cfg.id);
  return Promise.resolve(ok({
    database: { id: cfg.id, name: cfg.name },
    activeHere: activeId === cfg.id,
    subscriptions: subs,
  }));
}

async function addSubscription(ctx: McpToolContext, args: AddArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  if (!isSelectStatement(args.query)) {
    return err('Subscriptions must be SELECT statements (DQL subscription constraint).');
  }
  const sub = { id: randomId(12), name: args.name.trim() || args.query.slice(0, 60), query: args.query };
  await ctx.subscriptionStore.save(cfg.id, sub);
  const activeId = ctx.manager.getActiveConfigId();
  if (activeId === cfg.id) {
    try {
      ctx.manager.registerSubscription(sub.id, sub.query);
    } catch (e) {
      return err(`Persisted, but live registration failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok({
    subscription: sub,
    registered: activeId === cfg.id,
    message: activeId === cfg.id
      ? 'Subscription saved and registered live.'
      : 'Subscription saved; it registers automatically when this connection is next active.',
  });
}

async function removeSubscription(ctx: McpToolContext, args: RemoveArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  const existing = ctx.subscriptionStore.list(cfg.id).find(s => s.id === args.id);
  if (!existing) { return err(`No subscription with id "${args.id}" on "${cfg.name}".`); }
  await ctx.subscriptionStore.delete(cfg.id, args.id);
  if (ctx.manager.getActiveConfigId() === cfg.id) {
    ctx.manager.cancelSubscription(args.id);
  }
  return ok({ removed: true, subscription: existing });
}

export const subscriptionTools: ToolDef[] = [
  tool({
    name: 'list_subscriptions',
    description:
      'List sync subscription definitions for a database (default: the active connection). ' +
      'Definitions persist; the live registration exists only while that connection is active.',
    schema: { database: z.string().min(1).optional().describe('Connection id or name; default: active.') },
    handler: (ctx, args: ListArgs) => listSubscriptions(ctx, args),
  }),
  tool({
    name: 'add_subscription',
    description:
      'Create a sync subscription (SELECT query) for a database (default: active). Registers ' +
      'live immediately when the target connection is active; otherwise it registers on next ' +
      'connect.',
    schema: {
      name: z.string().min(1).describe('Human-readable label.'),
      query: z.string().min(1).describe('DQL SELECT statement.'),
      database: z.string().min(1).optional().describe('Connection id or name; default: active.'),
    },
    handler: (ctx, args: AddArgs) => addSubscription(ctx, args),
  }),
  tool({
    name: 'remove_subscription',
    description: 'Delete a subscription by id; cancels the live registration when active.',
    schema: {
      id: z.string().min(1),
      database: z.string().min(1).optional().describe('Connection id or name; default: active.'),
    },
    handler: (ctx, args: RemoveArgs) => removeSubscription(ctx, args),
  }),
];
