import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRelayMcpServer, MCP_VERSION, type McpServerOptions } from './server.js';
import { randomUUID } from 'node:crypto';
import { createMcpTelemetry } from './telemetry.js';

/**
 * Start MCP server with stdio transport (single agent).
 * Reads from stdin, writes to stdout.
 */
export async function startStdio(options: McpServerOptions): Promise<void> {
  const mcpServer = createRelayMcpServer({ ...options, telemetryTransport: 'stdio' });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

/**
 * Lifecycle callbacks for session events, used for external session
 * registries (e.g. Redis) to support multi-machine deployments.
 */
export interface SessionLifecycle {
  onCreated?: (sessionId: string) => void;
  onClosed?: (sessionId: string) => void;
}

/**
 * Session map for HTTP transport (multi-agent).
 * Each session gets its own MCP server + transport + telemetry instance.
 */
const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

/**
 * Create Express middleware for HTTP+SSE transport (multi-agent).
 * Each connecting client gets its own session with isolated state and telemetry.
 */
export function createHttpHandler(baseOptions: McpServerOptions, lifecycle?: SessionLifecycle) {
  return {
    /** Check whether a session ID is owned by this process. */
    hasSession: (sessionId: string) => sessions.has(sessionId),

    handleRequest: async (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session — create fresh MCP server + transport + telemetry
      const telemetry = createMcpTelemetry(MCP_VERSION, {
        originSurface: 'mcp',
        originClient: '@relaycast/mcp',
        originVersion: MCP_VERSION,
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const mcpServer = createRelayMcpServer({
        ...baseOptions,
        telemetryTransport: 'http',
        telemetry,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          lifecycle?.onClosed?.(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);

      // handleRequest must run first — the session ID is generated during
      // the initialize handshake, not during connect().
      await transport.handleRequest(req, res);

      if (transport.sessionId && !sessions.has(transport.sessionId)) {
        sessions.set(transport.sessionId, { transport });
        lifecycle?.onCreated?.(transport.sessionId);
        telemetry.capture('relaycast_mcp_http_session_started', {
          source_surface: 'mcp',
          transport: 'http',
          mcp_transport_session_id: transport.sessionId,
        });
      }
    },
  };
}
