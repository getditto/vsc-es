import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err } from './tool-result.js';
import { resolveConnection } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import { isSelectStatement } from '../ditto/QueryProfileParser.js';
import { randomId } from '../util/id.js';

/**
 * Observer DEFINITIONS (ObserverStore). Live observers in this extension
 * are panel-scoped by design (SwiftUI parity: activation is a user action
 * in the Observer panel) — agents that need live change data should use
 * watch_query for a bounded capture instead.
 */

interface ListArgs { database?: string }
interface AddArgs { name: string; query: string; database?: string }
interface RemoveArgs { id: string; database?: string }

function listObservers(ctx: McpToolContext, args: ListArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  return Promise.resolve(ok({
    database: { id: cfg.id, name: cfg.name },
    activeHere: ctx.manager.getActiveConfigId() === cfg.id,
    observers: ctx.observerStore.list(cfg.id),
  }));
}

async function addObserver(ctx: McpToolContext, args: AddArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  if (!isSelectStatement(args.query)) {
    return err('Observers must be SELECT statements (registerObserver returns a result set).');
  }
  const observer = { id: randomId(12), name: args.name.trim() || args.query.slice(0, 60), query: args.query };
  await ctx.observerStore.save(cfg.id, observer);
  return ok({
    observer,
    message: 'Definition saved. Live observation happens in the Observer panel (VS Code) or via watch_query.',
  });
}

async function removeObserver(ctx: McpToolContext, args: RemoveArgs): Promise<CallToolResult> {
  const cfg = resolveConnection(ctx, args.database);
  const existing = ctx.observerStore.list(cfg.id).find(o => o.id === args.id);
  if (!existing) { return err(`No observer with id "${args.id}" on "${cfg.name}".`); }
  await ctx.observerStore.delete(cfg.id, args.id);
  return ok({ removed: true, observer: existing });
}

export const observerTools: ToolDef[] = [
  tool({
    name: 'list_observers',
    description:
      'List observer definitions for a database (default: active). These are saved SELECT ' +
      'watches; activation is a panel action (or use watch_query for bounded agent capture).',
    schema: { database: z.string().min(1).optional().describe('Connection id or name; default: active.') },
    handler: (ctx, args: ListArgs) => listObservers(ctx, args),
  }),
  tool({
    name: 'add_observer',
    description:
      'Save an observer definition (SELECT query) for a database (default: active). Does not ' +
      'start live observation.',
    schema: {
      name: z.string().min(1),
      query: z.string().min(1).describe('DQL SELECT statement.'),
      database: z.string().min(1).optional().describe('Connection id or name; default: active.'),
    },
    handler: (ctx, args: AddArgs) => addObserver(ctx, args),
  }),
  tool({
    name: 'remove_observer',
    description: 'Delete an observer definition by id.',
    schema: {
      id: z.string().min(1),
      database: z.string().min(1).optional().describe('Connection id or name; default: active.'),
    },
    handler: (ctx, args: RemoveArgs) => removeObserver(ctx, args),
  }),
];
