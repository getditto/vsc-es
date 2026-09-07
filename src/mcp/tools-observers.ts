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
  // randomId(16) = 32 hex chars, matching ids the Observer Editor panel mints.
  const observer = { id: randomId(16), name: args.name.trim() || args.query.slice(0, 60), query: args.query };
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
  tool({
    name: 'watch_query',
    description:
      'Bounded live watch of a SELECT: registers a store observer and collects change events ' +
      '(insertions/updates/deletions/moves + rows) until the duration elapses or max_events ' +
      'fire, then unregisters. The FIRST event is always the full initial result set ' +
      '(everything counts as inserted). Use for "wait for a row to change" automation loops.',
    schema: {
      query: z.string().min(1).describe('DQL SELECT statement.'),
      duration_ms: z.number().int().min(250).max(30_000).default(5_000)
        .describe('How long to watch (max 30 s per call — re-call to keep watching).'),
      max_events: z.number().int().min(1).max(100).default(20)
        .describe('Stop early after this many change events.'),
      max_rows_per_event: z.number().int().min(1).max(200).default(25)
        .describe('Rows shipped per event (events beyond this keep diff counts but drop rows).'),
    },
    handler: async (ctx, args: { query: string; duration_ms: number; max_events: number; max_rows_per_event: number }) => {
      resolveConnection(ctx);
      if (!isSelectStatement(args.query)) {
        return err('watch_query needs a SELECT statement.');
      }
      interface WatchEvent {
        atMs: number;
        totalRows: number;
        insertions: number[];
        updates: number[];
        deletions: number[];
        moves: { from: number; to: number }[];
        rows: Record<string, unknown>[];
        rowsTruncated: boolean;
      }
      const events: WatchEvent[] = [];
      let stoppedBy: string = 'duration';
      const handle = ctx.manager.registerObserver(args.query, (ev) => {
        events.push({
          atMs: Date.now(),
          totalRows: ev.totalRows,
          insertions: ev.insertions,
          updates: ev.updates,
          deletions: ev.deletions,
          moves: ev.moves,
          rows: ev.rows.slice(0, args.max_rows_per_event),
          rowsTruncated: ev.rows.length > args.max_rows_per_event,
        });
      });
      if (!handle) { return err('No active session.'); }
      try {
        await new Promise<void>((resolve) => {
          let finished = false;
          let timer: NodeJS.Timeout;
          let tick: NodeJS.Timeout;
          const finish = (why: string): void => {
            if (finished) { return; }
            finished = true;
            stoppedBy = why;
            clearTimeout(timer);
            clearInterval(tick);
            resolve();
          };
          timer = setTimeout(() => finish('duration'), args.duration_ms);
          tick = setInterval(() => {
            if (events.length >= args.max_events) { finish('max_events'); }
          }, 50);
          // NOTE: deliberately REF'd. The awaiter is the MCP caller, both
          // timers are always cleared by finish(), and the observer is
          // cancelled in the finally — that is the leak guard. unref'd timers
          // let a hosting event loop drain mid-watch (and node:test cancels
          // the whole file's pending tests when that happens).
        });
      } finally {
        try { handle.cancel(); } catch { /* already torn down */ }
      }
      return ok({
        events,
        eventCount: events.length,
        stoppedBy,
        note: 'The first event is the initial result set (all rows count as inserted) — not a change.',
      });
    },
  }),
];
