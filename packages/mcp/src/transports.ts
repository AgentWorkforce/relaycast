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
 * Bootstrap a single workspace by verifying/refreshing its token.
 * Wrapped with a per-workspace timeout enforced via Promise.race so
 * one slow workspace doesn't block all others.
 */
async function bootstrapOneWorkspace(
  ws: McpWorkspaceConfig,
  baseUrl?: string,
  timeoutMs = 5_000,
): Promise<McpWorkspaceConfig> {
  const doBootstrap = async (): Promise<McpWorkspaceConfig> => {
    const relay = createInternalRelayCast({
      apiKey: ws.api_key,
      baseUrl,
    }, mcpOrigin);

    let token = ws.agent_token;
    const agentName = ws.agent_name ?? ws.workspace_alias ?? ws.workspace_id;
    let workspaceName = ws.workspace_name;

    try {
      const workspace = await relay.workspace.info();
      workspaceName = workspace.name;
    } catch {
      // Keep any pre-supplied name or leave undefined if workspace info is unavailable.
    }

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

    return {
      ...ws,
      agent_token: token,
      agent_name: agentName,
      workspace_name: workspaceName,
    };
  };

  try {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Bootstrap timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([doBootstrap(), timeout]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    console.error(
      `[bootstrap] Failed to bootstrap workspace ${ws.workspace_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Still return the workspace config even if bootstrap failed,
    // so it can be retried later
    return ws;
  }
}

/**
 * Bootstrap workspaces by verifying/refreshing tokens and joining each
 * workspace into the MCP server's session via setSession + saveWorkspaceContext.
 *
 * All workspaces are bootstrapped concurrently with individual timeouts.
 */
async function bootstrapWorkspaces(
  workspaces: McpWorkspaceConfig[],
  baseUrl?: string,
): Promise<McpWorkspaceConfig[]> {
  const results = await Promise.allSettled(
    workspaces.map(ws => bootstrapOneWorkspace(ws, baseUrl)),
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    console.error(
      `[bootstrap] Workspace ${workspaces[i].workspace_id} rejected: ${result.reason}`,
    );
    return workspaces[i];
  });
}

/**
 * Start MCP server with stdio transport (single agent).
 * Reads from stdin, writes to stdout.
 */
export async function startStdio(options: McpServerOptions): Promise<void> {
  let effectiveOptions = { ...options, telemetryTransport: 'stdio' as const };

  const hasAgentToken = Boolean(options.agentToken);
  const hasWorkspaces = Boolean(options.workspaces?.length);

  if (hasWorkspaces) {
    if (hasAgentToken) {
      // When agentToken is pre-provided (broker-spawned), skip bootstrap entirely —
      // the token is already valid. Use workspace configs as-is for routing context.
      const withNames = options.workspaces!.map(ws => ({
        ...ws,
        agent_name: ws.agent_name ?? ws.workspace_alias ?? ws.workspace_id,
      }));
      effectiveOptions = { ...effectiveOptions, workspaces: withNames };

      // Promote default workspace credentials so routing resolves correctly
      const defaultWsId = resolveDefaultWorkspaceId(withNames, options.defaultWorkspace);
      const defaultWs = withNames.find(w => w.workspace_id === defaultWsId);
      if (defaultWs) {
        effectiveOptions.apiKey = effectiveOptions.apiKey ?? defaultWs.api_key;
        effectiveOptions.agentName = effectiveOptions.agentName ?? defaultWs.agent_name;
      }
    } else {
      // CLI user with RELAY_WORKSPACES_JSON — bootstrap is needed but now
      // runs all workspaces concurrently (with per-workspace timeouts).
      const bootstrapped = await bootstrapWorkspaces(options.workspaces!, options.baseUrl);
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
  }

  // createRelayMcpServer populates session.workspaces from
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
