// Embedded MCP server: Streamable HTTP (current spec) at /mcp plus the
// legacy HTTP+SSE transport (/sse + /messages) for older clients, over a
// loopback-only Node http server.
//
// Deliberate parallels with the SwiftUI Edge Studio server
// (ditto-edge-studio …/Data/MCPServer):
//   - loopback-only bind, opt-in, no auth/CORS (documented threat model:
//     any local process can connect — the listener is developer tooling)
//   - GET /health → 200 "OK"
//   - 4 MiB request cap
//   - unknown/expired sessionId → 404 BEFORE the message reaches a tool,
//     so a retrying client cannot double-apply a mutation
//   - all sessions drained on stop
//
// Deliberate deviations: we use the official @modelcontextprotocol/sdk
// instead of a hand-rolled HTTP parser, expose the modern transport at
// /mcp (SwiftUI put legacy SSE there), and add a stateful session map so
// the double-execution guard works on both transports.

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { Logger } from '../logging/types.js';

/** The SDK's transport classes declare `onclose` getters whose type isn't
 *  assignable to the `Transport` interface under exactOptionalPropertyTypes
 *  (the SDK isn't compiled with that flag). Contain the one-way cast. */
type McpTransport = Parameters<McpServer['connect']>[0];

/** SwiftUI parity: 4 MiB per request. */
export const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;

interface SessionEntry {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  server: McpServer;
}

export interface McpServerServiceOptions {
  /** serverInfo.name advertised during initialize. */
  name: string;
  /** serverInfo.version — the extension's package version. */
  version: string;
  /** Registers tools/resources on each per-session McpServer. */
  register: (server: McpServer) => void;
  log: Logger;
}

/** EADDRINUSE with actionable text (the port setting exists precisely
 *  so a user can free a stuck port claim without editing JSON). Not
 *  exported — callers pattern-match on the message, which is the whole
 *  blueprint the user needs. */
class McpPortInUseError extends Error {
  constructor(port: number) {
    super(
      `Port ${port} is already in use. Change the dittoVsce.mcpServer.port setting ` +
      `and try again (the SwiftUI Edge Studio app defaults to 65269 — this extension to 65270, ` +
      `so check whether another VS Code window is already running the server).`,
    );
    this.name = 'McpPortInUseError';
  }
}

type JsonRpcId = string | number | null;

function jsonRpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

export class McpServerService {
  /** IPv4 loopback first (universal), IPv6 loopback alongside when the
   *  platform supports it. Both sockets share this instance's router,
   *  session map, and socket set. */
  private httpServers: http.Server[] = [];
  private readonly sessions = new Map<string, SessionEntry>();
  /** Every accepted socket, so stop() can kill SSE streams (which otherwise
   *  keep the listener port held open past server.close()). */
  private readonly sockets = new Set<import('node:net').Socket>();
  private boundPort: number | undefined;
  /** Set while stop() is draining: a late session-initialized callback must
   *  close immediately instead of re-populating the (cleared) session map. */
  private stopping = false;
  private readonly log: Logger;

  constructor(private readonly opts: McpServerServiceOptions) {
    this.log = opts.log.withTag('mcp');
  }

  get isRunning(): boolean { return this.httpServers.length > 0; }

  /** The URL agents should connect to, or undefined when stopped. */
  get url(): string | undefined {
    return this.boundPort === undefined ? undefined : `http://127.0.0.1:${this.boundPort}/mcp`;
  }

  get port(): number | undefined { return this.boundPort; }
  get sessionCount(): number { return this.sessions.size; }

  async start(port: number): Promise<void> {
    if (this.httpServers.length > 0) { return; }
    this.stopping = false;
    const primary = await this.listen(port, '127.0.0.1');
    this.httpServers.push(primary);
    // Honour OS-assigned ports (tests pass 0 for an ephemeral listener —
    // the secondary bind is skipped there by design).
    const addr = primary.address();
    this.boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
    // Best-effort IPv6 loopback so clients resolving localhost to ::1 also
    // work. A secondary bind failure never fails startup: 127.0.0.1 is up.
    if (port !== 0) {
      try {
        this.httpServers.push(await this.listen(port, '::1'));
      } catch (e) {
        this.log.warn('IPv6 loopback bind failed; serving 127.0.0.1 only', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    this.log.info('MCP server listening', { url: this.url });
  }

  private listen(port: number, host: string): Promise<http.Server> {
    const server = http.createServer((req, res) => { void this.route(req, res); });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => { this.sockets.delete(socket); });
    });
    server.on('error', (err) => {
      this.log.error('MCP http server error', { host, err: err.message });
    });
    return new Promise<http.Server>((resolve, reject) => {
      const onListenError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') { reject(new McpPortInUseError(port)); return; }
        reject(err);
      };
      server.once('error', onListenError);
      server.listen({ port, host }, () => {
        server.off('error', onListenError);
        resolve(server);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const servers = this.httpServers;
    this.httpServers = [];
    this.boundPort = undefined;
    // Drain sessions first so no sessionId survives the restart and a
    // client retry can't land on a half-torn-down server (SwiftUI parity).
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (s) => {
      try { await s.transport.close(); } catch { /* best effort */ }
      try { await s.server.close(); } catch { /* best effort */ }
    }));
    for (const socket of this.sockets) { socket.destroy(); }
    this.sockets.clear();
    await Promise.allSettled(servers.map(server => Promise.race([
      new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])));
    this.log.info('MCP server stopped');
  }

  // ─── request routing ────────────────────────────────────────

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';

      if (path === '/health' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
      }

      // Loopback bind stops hostile networks, but a browser page on a
      // DNS-rebinding domain arrives with a non-loopback Host as SAME-origin
      // (bypassing CORS). Reject any Host we did not bind, before dispatch.
      // (Per-session transports carry the SDK's own protection too.)
      if (!this.hostAllowed(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(`Invalid Host header: ${req.headers.host ?? '(none)'}`);
        return;
      }

      if (path === '/mcp') {
        await this.handleStreamable(req, res, method);
        return;
      }
      if (path === '/sse' && method === 'GET') {
        await this.handleLegacySseConnect(res);
        return;
      }
      if (path === '/messages' && method === 'POST') {
        await this.handleLegacySseMessage(req, res, url.searchParams.get('sessionId'));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. MCP endpoints: POST|GET|DELETE /mcp (streamable HTTP), GET /sse + POST /messages (legacy SSE), GET /health.');
    } catch (e) {
      this.log.error('MCP request failed', { err: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); }
      res.end('Internal MCP server error');
    }
  }

  // ─── Streamable HTTP (modern transport) ─────────────────────

  private async handleStreamable(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
  ): Promise<void> {
    const sessionId = readSessionHeader(req);

    if (method === 'GET' || method === 'DELETE') {
      // Long-lived SSE / session teardown both require a known session.
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (!session || !(session.transport instanceof StreamableHTTPServerTransport)) {
        this.rejectUnknownSession(res);
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, DELETE' });
      res.end('Method not allowed');
      return;
    }

    const body = await this.readJsonBody(req, res);
    if (body === undefined) { return; } // 413/400 already written

    // Existing session → straight to its transport.
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || !(session.transport instanceof StreamableHTTPServerTransport)) {
        this.rejectUnknownSession(res);
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No session header: only an initialize request may start a session.
    // (Notifications and any other method get a clean 400 instead of
    // spinning up a doomed transport.)
    const initCandidate: Partial<{ method: unknown; id: JsonRpcId }> | null =
      Array.isArray(body) ? null : (body);
    if (initCandidate?.method !== 'initialize') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonRpcError(
        initCandidate?.id ?? null,
        -32600,
        'Bad Request: first request to /mcp must be an initialize request (subsequent requests send the Mcp-Session-Id header).',
      ));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Plain JSON responses to POSTs (the default is an SSE-wrapped
      // response). SwiftUI parity: curl and other simple clients read the
      // JSON-RPC response straight out of the body.
      enableJsonResponse: true,
      // Belt-and-suspenders next to the router-level hostAllowed guard.
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts(),
      onsessioninitialized: (sid) => {
        // An initialize already in flight when stop() began must not
        // re-populate the drained session map.
        if (this.stopping) {
          void transport.close().catch(() => { /* best effort */ });
          return;
        }
        this.sessions.set(sid, entry);
        // info (not debug): "did any agent ever reach us?" is the first
        // triage question when the server is up but a client is silent.
        this.log.info('MCP client session initialized', { sessionId: sid, transport: 'streamable', sessions: this.sessions.size });
      },
      onsessionclosed: (sid) => {
        if (this.sessions.delete(sid)) {
          this.log.debug('MCP session closed', { sessionId: sid, transport: 'streamable' });
        }
      },
    });
    const server = this.newSessionServer();
    const entry: SessionEntry = { transport, server };
    transport.onclose = () => {
      // StreamableHTTP transport.close() is _closed-guarded in the SDK, but
      // keep this idempotent so no SDK change can re-open a close() ->
      // onclose -> close() loop (the legacy SSE path needs exactly this —
      // see handleLegacySseConnect).
      const sid = transport.sessionId;
      const removed = sid !== undefined && this.sessions.delete(sid);
      if (removed) {
        void server.close().catch(() => { /* best effort */ });
      }
    };
    await server.connect(transport as unknown as McpTransport);
    await transport.handleRequest(req, res, body);
  }

  // ─── Legacy HTTP+SSE (SwiftUI-spec transport) ───────────────

  private async handleLegacySseConnect(res: http.ServerResponse): Promise<void> {
    const transport = new SSEServerTransport('/messages', res, {
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts(),
    });
    const server = this.newSessionServer();
    const entry: SessionEntry = { transport, server };
    transport.onclose = () => {
      // Idempotent: SSEServerTransport.close() re-fires onclose with no
      // re-entrancy guard, and Protocol.close() -> transport.close() ->
      // onclose -> server.close() recurses until RangeError otherwise.
      if (this.sessions.delete(transport.sessionId)) {
        void server.close().catch(() => { /* best effort */ });
      }
    };
    this.sessions.set(transport.sessionId, entry);
    this.log.info('MCP client session initialized', { sessionId: transport.sessionId, transport: 'sse', sessions: this.sessions.size });
    // server.connect() calls transport.start(), which takes over the
    // response (event-stream + endpoint event). Do not touch res after.
    await server.connect(transport);
  }

  private async handleLegacySseMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string | null,
  ): Promise<void> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !(session.transport instanceof SSEServerTransport)) {
      this.rejectUnknownSession(res);
      return;
    }
    const body = await this.readJsonBody(req, res);
    if (body === undefined) { return; }
    await session.transport.handlePostMessage(req, res, body);
  }

  // ─── helpers ────────────────────────────────────────────────

  /** Host-header allowlist for the SDK's DNS-rebinding protection: exactly
   *  the loopback names this service binds, with the bound port. */
  private allowedHosts(): string[] {
    const port = this.boundPort;
    if (port === undefined) { return []; }
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  }

  /** Router-level DNS-rebinding guard: only Host names this service bound
   *  may reach the MCP endpoints (health stays open for liveness probes). */
  private hostAllowed(req: http.IncomingMessage): boolean {
    const hosts = this.allowedHosts();
    const host = req.headers.host;
    return hosts.length === 0 || (host !== undefined && hosts.includes(host));
  }

  private newSessionServer(): McpServer {
    // Capabilities are declared by registration: McpServer.registerTool /
    // registerResource call registerCapabilities themselves, so a session
    // server exactly advertises whatever the current build registered.
    const server = new McpServer({ name: this.opts.name, version: this.opts.version });
    this.opts.register(server);
    return server;
  }

  /** 404 BEFORE any tool executes — see the header comment for why this
   *  ordering matters (a double-applied EVICT is not recoverable). */
  private rejectUnknownSession(res: http.ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'unknown sessionId — reconnect via GET /sse (legacy) or POST an initialize request to /mcp',
    }));
  }

  /** Read + JSON-parse a request body with the 4 MiB cap. Returns
   *  undefined (having already written the response) on cap/parse
   *  failure. */
  private async readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > MCP_MAX_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(`Request body exceeds the ${MCP_MAX_BODY_BYTES / (1024 * 1024)} MB limit`);
      return undefined;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MCP_MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end(`Request body exceeds the ${MCP_MAX_BODY_BYTES / (1024 * 1024)} MB limit`);
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonRpcError(null, -32700, 'Parse error: body is not valid JSON'));
      return undefined;
    }
  }
}

/** The mcp-session-id header may arrive as a string or (shouldn't happen,
 *  single-value header) a list. */
function readSessionHeader(req: http.IncomingMessage): string | undefined {
  const raw = req.headers['mcp-session-id'];
  if (Array.isArray(raw)) { return raw[0]; }
  return raw === '' ? undefined : raw;
}
