import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRelayMcpServer, MCP_VERSION, type McpServerOptions } from './server.js';
import { randomUUID } from 'node:crypto';
import { createMcpTelemetry } from './telemetry.js';
import { createInternalRelayCast } from '@relaycast/sdk/internal';
import type { McpWorkspaceConfig } from './workspaces.js';
import { resolveDefaultWorkspaceId } from './workspaces.js';

const mcpOrigin = {
  surface: 'mcp' as const,
  client: '@relaycast/mcp',
  version: MCP_VERSION,
};

/**
 * Bootstrap workspaces by verifying/refreshing tokens and joining each
 * workspace into the MCP server's session via setSession + saveWorkspaceContext.
 *
 * This is called during startStdio when `workspaces` are provided.
 */
async function bootstrapWorkspaces(
  workspaces: McpWorkspaceConfig[],
  baseUrl?: string,
): Promise<McpWorkspaceConfig[]> {
  const bootstrapped: McpWorkspaceConfig[] = [];

  for (const ws of workspaces) {
    try {
      const relay = createInternalRelayCast({
        apiKey: ws.api_key,
        baseUrl,
      }, mcpOrigin);

      let token = ws.agent_token;
      const agentName = ws.agent_name ?? ws.workspace_alias ?? ws.workspace_id;

      // If we have a token, verify it's still valid via an inbox call
      if (token) {
        try {
          const client = relay.as(token);
          await client.inbox();
        } catch {
          // Token is invalid, need to re-register
          token = undefined;
        }
      }

      // If no valid token, register or rotate
      if (!token) {
        const result = await relay.agents.registerOrRotate({
          name: agentName,
          type: 'agent',
        });
        token = result.token;
      }

      bootstrapped.push({
        ...ws,
        agent_token: token,
        agent_name: agentName,
      });
    } catch (err) {
      console.error(
        `[bootstrap] Failed to bootstrap workspace ${ws.workspace_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Still include the workspace config even if bootstrap failed,
      // so it can be retried later
      bootstrapped.push(ws);
    }
  }

  return bootstrapped;
}

/**
 * Start MCP server with stdio transport (single agent).
 * Reads from stdin, writes to stdout.
 */
export async function startStdio(options: McpServerOptions): Promise<void> {
  let effectiveOptions = { ...options, telemetryTransport: 'stdio' as const };

  // If workspaces are provided, bootstrap them before creating the server
  if (options.workspaces?.length) {
    const bootstrapped = await bootstrapWorkspaces(options.workspaces, options.baseUrl);
    effectiveOptions = { ...effectiveOptions, workspaces: bootstrapped };

    // Set the default workspace's api key/token/name as the primary session
    const defaultWsId = resolveDefaultWorkspaceId(bootstrapped, options.defaultWorkspace);
    const defaultWs = bootstrapped.find(
      w => w.workspace_id === defaultWsId && w.agent_token,
    );
    if (defaultWs) {
      effectiveOptions.apiKey = effectiveOptions.apiKey ?? defaultWs.api_key;
      effectiveOptions.agentToken = effectiveOptions.agentToken ?? defaultWs.agent_token;
      effectiveOptions.agentName = effectiveOptions.agentName ?? defaultWs.agent_name;
    }
  }

  // createRelayMcpServer now populates session.workspaces from
  // effectiveOptions.workspaces internally — no need to reach into internals.
  const mcpServer = createRelayMcpServer(effectiveOptions);

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
