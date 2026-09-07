import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DittoCollection } from '../models/DittoCollection.js';
import { ok, err, errFrom } from './tool-result.js';
import { requireActiveConfig } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import type { IndexField } from '../models/DittoCollection.js';

function collectionToJson(c: DittoCollection): Record<string, unknown> {
  return {
    name: c.name,
    documentCount: c.documentCount,
    indexes: c.indexes.map(i => ({
      name: i.displayName,
      fullName: i.id,
      collection: i.collection,
      fields: i.fields.map(f => `${f.name} ${f.ascending ? 'ASC' : 'DESC'}`),
    })),
  };
}

async function listCollections(ctx: McpToolContext): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  // Prefer a live re-hydrate over the cache: the cache fills on
  // lifecycle-active, but an agent may call in the gap between connect
  // completing and load() resolving, or after out-of-band DDL that the
  // __collections observer hasn't flushed yet. refresh() is also what
  // surfaces a real error to the caller (load() swallows by design).
  try {
    await ctx.collectionsRepo.refresh();
  } catch (e) {
    return errFrom(e);
  }
  return ok(ctx.collectionsRepo.current().map(collectionToJson));
}

async function listIndexes(ctx: McpToolContext): Promise<CallToolResult> {
  // [] (not an error) with no connection — SwiftUI parity.
  if (!ctx.manager.getActiveConfigId()) { return ok([]); }
  try {
    await ctx.collectionsRepo.refresh();
  } catch (e) {
    return errFrom(e);
  }
  return ok(
    ctx.collectionsRepo.current().flatMap(c =>
      c.indexes.map(i => ({
        name: i.displayName,
        fullName: i.id,
        collection: i.collection,
        fields: i.fields.map(f => `${f.name} ${f.ascending ? 'ASC' : 'DESC'}`),
      })),
    ),
  );
}

interface CreateIndexArgs {
  collection: string;
  field?: string;
  fields?: { name: string; direction?: 'ASC' | 'DESC' }[];
}

async function createIndex(ctx: McpToolContext, args: CreateIndexArgs): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  const fields: IndexField[] = args.fields
    ? args.fields.map(f => ({ name: f.name, ascending: f.direction !== 'DESC' }))
    : args.field ? [{ name: args.field, ascending: true }] : [];
  if (fields.length === 0) {
    return err("Pass either 'field' (single field) or 'fields' (ordered composite).");
  }
  try {
    const outcome = await ctx.collectionsRepo.createIndex(args.collection, fields);
    return ok({
      collection: args.collection,
      fields: fields.map(f => `${f.name} ${f.ascending ? 'ASC' : 'DESC'}`),
      outcome,
      message: outcome === 'already-exists'
        ? 'An index with this name and definition already exists — no changes made.'
        : 'Index created successfully.',
    });
  } catch (e) {
    return errFrom(e);
  }
}

interface DropIndexArgs {
  index_name: string;
  collection?: string;
}

async function dropIndex(ctx: McpToolContext, args: DropIndexArgs): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  try {
    // SwiftUI parity: resolve by display name first so a bare name that
    // exists on MULTIPLE collections is rejected instead of silently
    // dropping in whichever collection the caller happened to mean. The
    // system:indexes `_id` prefix-strip lives inside
    // findIndexesByDisplayName (dotted collection names stay correct).
    const matches = await ctx.collectionsRepo.findIndexesByDisplayName(args.index_name, args.collection);
    if (matches.length === 0) {
      return err(args.collection
        ? `No index named "${args.index_name}" on collection "${args.collection}".`
        : `No index named "${args.index_name}" exists.`);
    }
    if (!args.collection) {
      const collections = [...new Set(matches.map(m => m.collection))];
      if (collections.length > 1) {
        return err(
          `Index "${args.index_name}" exists on multiple collections (${collections.join(', ')}). ` +
          `Pass the 'collection' argument to disambiguate.`,
        );
      }
    }
    const target = matches[0];
    if (!target) { return err(`No index named "${args.index_name}".`); }
    await ctx.collectionsRepo.dropIndex(target.displayName, target.collection);
    return ok({
      dropped: true,
      index: target.displayName,
      collection: target.collection,
      message: `Index "${target.displayName}" on "${target.collection}" dropped.`,
    });
  } catch (e) {
    return errFrom(e);
  }
}

export const collectionTools: ToolDef[] = [
  tool({
    name: 'list_collections',
    description:
      'List collections in the active database with live document counts and indexes. ' +
      'Requires an active connection.',
    schema: {},
    handler: (ctx) => listCollections(ctx),
  }),
  tool({
    name: 'list_indexes',
    description:
      'List every index across all collections of the active database. ' +
      'Returns an empty array when no database is connected.',
    schema: {},
    handler: (ctx) => listIndexes(ctx),
  }),
  tool({
    name: 'create_index',
    description:
      'Create an index on a collection. Pass "field" for a single ASC index (SwiftUI parity) ' +
      'or "fields" for an ordered composite index (SDK 5.1+; order is significant to the ' +
      'query optimizer). Same-name/same-definition is reported as already-exists; same-name/' +
      'different-definition is rejected — drop it first.',
    schema: {
      collection: z.string().min(1),
      field: z.string().min(1).optional()
        .describe('Single field path, created ASC. Shorthand for fields: [{name}].'),
      fields: z.array(z.object({
        name: z.string().min(1).describe('Field path, e.g. "address.city".'),
        direction: z.enum(['ASC', 'DESC']).optional().describe('Default ASC.'),
      })).nonempty().optional()
        .describe('Ordered composite index keys. Significant to the optimizer; never reordered.'),
    },
    handler: (ctx, args: CreateIndexArgs) => createIndex(ctx, args),
  }),
  tool({
    name: 'drop_index',
    description:
      'Drop an index by display name. When the name exists on more than one collection, ' +
      'pass "collection" to disambiguate — the call is refused otherwise.',
    schema: {
      index_name: z.string().min(1).describe('Display name (no collection prefix).'),
      collection: z.string().min(1).optional(),
    },
    handler: (ctx, args: DropIndexArgs) => dropIndex(ctx, args),
  }),
];
