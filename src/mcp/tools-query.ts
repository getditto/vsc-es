import { z } from 'zod';
import * as fs from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, err, errFrom } from './tool-result.js';
import { requireActiveConfig } from './guards.js';
import { tool, type ToolDef } from './define-tool.js';
import type { McpToolContext } from './context.js';
import { executeRemoteQuery, HttpQueryError } from '../ditto/HttpQueryService.js';
import {
  validateJsonDocuments, importDocuments, ImportValidationError,
} from '../ditto/ImportService.js';
import { isProfilableSelect } from '../ditto/QueryProfileParser.js';

/** Row cap applied to SELECT results before they enter an LLM context.
 *  Matches MAX_QUERY_ROWS in src/ditto/query-projection.ts — the Query
 *  Editor's own ceiling — so agent and human paths report truncation the
 *  same way. */
const MCP_QUERY_ROW_CAP = 10_000;

/** Files larger than this are refused before we even read them — the whole
 *  buffer passes through JSON.parse and a DQL batch insert, and the
 *  extension host is shared. Generous relative to real datasets. */
const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

interface ExecuteDqlArgs {
  query: string;
  transport: 'local' | 'http';
}

async function executeDql(ctx: McpToolContext, args: ExecuteDqlArgs): Promise<CallToolResult> {
  const cfg = requireActiveConfig(ctx);
  try {
    if (args.transport === 'http') {
      const secrets = await ctx.secretStore.read(cfg.id);
      if (!cfg.httpApiUrl || !secrets.httpApiKey) {
        // SwiftUI parity: a structured payload, not a thrown error, so the
        // agent can see the remediation and offer to configure the fields.
        return ok({
          error: 'http_not_configured',
          message: 'This database has no HTTP API configuration.',
          hint: 'Set the HTTP API URL and HTTP API key on the connection (Edit Configuration), then retry.',
        });
      }
      const res = await executeRemoteQuery({
        httpApiUrl: cfg.httpApiUrl,
        httpApiKey: secrets.httpApiKey,
        allowUntrustedCerts: cfg.allowUntrustedCerts,
        serverUrl: cfg.authUrl,
        query: args.query,
      }, ctx.logger);
      return ok({ mode: 'http', rows: res.items, rowCount: res.items.length });
    }

    const { rows, mutatedDocumentIds, commitId } = await ctx.manager.executeRawDetailed(args.query);
    const truncated = rows.length > MCP_QUERY_ROW_CAP;
    const payload: Record<string, unknown> = {
      mode: 'local',
      rows: truncated ? rows.slice(0, MCP_QUERY_ROW_CAP) : rows,
      rowCount: truncated ? MCP_QUERY_ROW_CAP : rows.length,
      ...(truncated ? { truncated: true, totalRowCount: rows.length } : {}),
      ...(mutatedDocumentIds.length > 0 ? { mutatedDocumentIds } : {}),
      ...(commitId !== null ? { commitId } : {}),
    };
    return ok(payload);
  } catch (e) {
    if (e instanceof HttpQueryError) { return err(e.message); }
    return errFrom(e);
  }
}

interface InsertFromFileArgs {
  file_path: string;
  collection: string;
  mode: 'insert' | 'insert_initial';
}

async function insertDocumentsFromFile(ctx: McpToolContext, args: InsertFromFileArgs): Promise<CallToolResult> {
  requireActiveConfig(ctx);
  let raw: string;
  try {
    // One descriptor for the size check AND the read: stat-then-readFile on
    // a path is a file-system race (CodeQL js/file-system-race) — the target
    // could be swapped to something larger or unreadable between the calls.
    const handle = await fs.open(args.file_path);
    try {
      const st = await handle.stat();
      if (!st.isFile()) { return err(`Not a file: ${args.file_path}`); }
      if (st.size > MAX_IMPORT_FILE_BYTES) {
        return err(`File is ${Math.round(st.size / (1024 * 1024))} MB — the import cap is ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB.`);
      }
      raw = await handle.readFile('utf8');
    } finally {
      void handle.close().catch(() => { /* read errors above already reported */ });
    }
  } catch (e) {
    return errFrom(e);
  }

  let documents: Record<string, unknown>[];
  try {
    documents = validateJsonDocuments(raw);
  } catch (e) {
    return err(e instanceof ImportValidationError ? e.message : String(e));
  }

  const activeAtStart = ctx.manager.getActiveConfigId();
  const result = await importDocuments({
    documents,
    collection: args.collection,
    insertType: args.mode === 'insert_initial' ? 'initial' : 'regular',
    execute: (q, a) => ctx.manager.executeRaw(q, a),
    checkActive: () => ctx.manager.getActiveConfigId() === activeAtStart ? activeAtStart : null,
  });
  // SwiftUI-compatible result envelope: inserted/failed/mode/collection/errors.
  return ok({
    inserted: result.successCount,
    failed: result.failureCount,
    mode: args.mode,
    collection: args.collection,
    ...(result.cancelled ? { cancelled: true } : {}),
    errors: result.errors,
  });
}

export const queryTools: ToolDef[] = [
  tool({
    name: 'execute_dql',
    description:
      'Execute a DQL query against the currently active Ditto database in Edge Studio. ' +
      "Supports SELECT, INSERT, UPDATE, EVICT, and other DQL statements. By default queries " +
      "run against the local embedded database. Set transport to 'http' to route through the " +
      "HTTP API (requires httpApiUrl and httpApiKey configured on the database). SELECT rows " +
      "are capped at 10000 with a truncated flag; mutations report mutatedDocumentIds and commitId.",
    schema: {
      query: z.string().min(1).describe('The DQL statement to execute.'),
      transport: z.enum(['local', 'http']).default('local')
        .describe("'local' runs against the embedded store; 'http' posts to the Ditto Server HTTP API."),
    },
    handler: (ctx, args: ExecuteDqlArgs) => executeDql(ctx, args),
  }),
  tool({
    name: 'insert_documents_from_file',
    description:
      'Bulk-insert documents from a JSON file into a collection of the active database. ' +
      'The file must contain a JSON array of objects, each with an _id field. ' +
      "mode 'insert' performs an upsert (ON ID CONFLICT DO UPDATE); 'insert_initial' uses " +
      'INITIAL DOCUMENTS and fails if the document already exists.',
    schema: {
      file_path: z.string().min(1).describe('Absolute path to the JSON file.'),
      collection: z.string().min(1).describe('Target collection name (any DQL identifier).'),
      mode: z.enum(['insert', 'insert_initial']).default('insert'),
    },
    handler: (ctx, args: InsertFromFileArgs) => insertDocumentsFromFile(ctx, args),
  }),
  tool({
    name: 'explain_query',
    description:
      'Return the DQL query plan (EXPLAIN) for a statement WITHOUT executing it against the ' +
      'store. Use before/after create_index to compare strategies.',
    schema: { query: z.string().min(1) },
    handler: async (ctx, args: { query: string }) => {
      requireActiveConfig(ctx);
      const plan = await ctx.manager.explainQuery(args.query);
      return ok({ query: args.query, plan });
    },
  }),
  tool({
    name: 'profile_query',
    description:
      'Execute a SELECT with PROFILE and return the per-operator timing tree (plus rows and ' +
      'row counts). NOTE: this RUNS the query — it is for tuning, not for reading data cheaply.',
    schema: { query: z.string().min(1).describe('SELECT statement to profile.') },
    handler: async (ctx, args: { query: string }) => {
      requireActiveConfig(ctx);
      if (!isProfilableSelect(args.query)) {
        return err('Only SELECT statements can be profiled.');
      }
      const { rows, durationMs, metadata } = await ctx.manager.executeQuery(
        args.query,
        { collectProfiling: true, collectMetrics: false },
      );
      return ok({
        durationMs,
        resultCount: metadata.resultCount,
        ...(metadata.truncated ? { truncated: true, totalResultCount: metadata.totalResultCount } : {}),
        profile: metadata.profile ?? null,
        rows,
      });
    },
  }),
];
