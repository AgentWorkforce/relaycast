import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRelayMcpServer, type McpServerOptions } from './server.js';
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
 * Session map for HTTP transport (multi-agent).
 * Each session gets its own MCP server + transport instance.
 */
const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

/**
 * Create Express middleware for HTTP+SSE transport (multi-agent).
 * Each connecting client gets its own session with isolated state.
 */
export function createHttpHandler(baseOptions: McpServerOptions) {
  const telemetry = createMcpTelemetry('0.1.0');

  return {
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

      // New session — create fresh MCP server + transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const mcpServer = createRelayMcpServer({
        ...baseOptions,
        telemetryTransport: 'http',
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await mcpServer.connect(transport);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport });
        telemetry.capture('relaycast_mcp_http_session_started', {
          source_surface: 'mcp',
          transport: 'http',
          session_id: transport.sessionId,
        });
      }

      await transport.handleRequest(req, res);
    },
  };
}
