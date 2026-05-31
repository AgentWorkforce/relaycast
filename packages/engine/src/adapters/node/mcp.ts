import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRelayMcpServer } from '@relaycast/mcp/server';
import type { McpSessionHost } from '../../ports/mcp.js';

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export interface InProcessMcpOptions {
  /** Base URL the MCP server's tools call back into (this server's own origin). */
  baseUrl?: string;
}

/**
 * In-process MCP Streamable-HTTP session host, replacing McpSessionDO. Sessions
 * are held in a `Map` keyed by a generated UUID; an unknown/closed session id
 * returns the same 404 a hosted (evicted-DO) session would, so clients
 * re-initialize identically.
 */
export class InProcessMcpSessionHost implements McpSessionHost {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: InProcessMcpOptions = {}) {}

  async handle(request: Request, sessionId: string | undefined): Promise<Response> {
    if (request.method === 'DELETE') {
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          await session.transport.close();
          this.sessions.delete(sessionId);
        }
      }
      return new Response(null, { status: 204 });
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or expired session' }, id: null },
          { status: 404 },
        );
      }
      return session.transport.handleRequest(request);
    }

    // New session (initialize).
    const newSessionId = randomUUID();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });
    const apiKey = request.headers.get('x-relay-api-key') ?? undefined;
    const server = createRelayMcpServer({
      apiKey,
      baseUrl: this.options.baseUrl,
      telemetryTransport: 'http',
    });

    transport.onclose = () => {
      this.sessions.delete(newSessionId);
    };

    await server.connect(transport);
    this.sessions.set(newSessionId, { transport, server });

    return transport.handleRequest(request);
  }
}
