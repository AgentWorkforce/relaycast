import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ListToolsResult,
  type ServerNotification,
  type ServerRequest,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { AgentClient } from '@relaycast/sdk';
import { createInternalRelayCast, createInternalWsClient } from '@relaycast/sdk/internal';
import { registerRegistrationTools } from './tools/registration.js';
import { registerChannelTools } from './tools/channels.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerFeatureTools } from './tools/features.js';
import { registerProgrammabilityTools } from './tools/programmability.js';
import { registerSystemPrompt } from './prompts.js';
import { createInitialSession, type SessionState } from './types.js';
import { enablePiggyback } from './piggyback.js';
import { registerResourceDefinitions } from './resources/definitions.js';
import { SubscriptionManager } from './resources/subscriptions.js';
import { WsBridge } from './resources/ws-bridge.js';
import { createMcpTelemetry, type McpTelemetry } from './telemetry.js';
import { resolveToolName } from './tool-aliases.js';

export const MCP_VERSION = '0.1.2';

export interface McpServerOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Pre-registered agent token for auto-bootstrap (skips explicit `register` call). */
  agentToken?: string;
  /** Agent name associated with the pre-registered token. */
  agentName?: string;
  /** Agent type associated with the pre-registered identity. */
  agentType?: 'agent' | 'human';
  /** When true, the `register` tool enforces the pre-registered agentName. */
  strictAgentName?: boolean;
  telemetryTransport?: 'stdio' | 'http';
  telemetry?: McpTelemetry;
}

type ServerRequestHandler<TRequest, TResult extends ServerResult = ServerResult> = (
  request: TRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => TResult | Promise<TResult>;

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const session: SessionState = createInitialSession({
    workspaceKey: options.apiKey ?? null,
    agentToken: options.agentToken ?? null,
    agentName: options.agentName ?? null,
  });
  const mcpOrigin = {
    surface: 'mcp' as const,
    client: '@relaycast/mcp',
    version: MCP_VERSION,
  };
  const telemetry = options.telemetry ?? createMcpTelemetry(MCP_VERSION, {
    originSurface: mcpOrigin.surface,
    originClient: mcpOrigin.client,
    originVersion: mcpOrigin.version,
  });

  const mcpServer = new McpServer(
    { name: 'agent-relay', version: MCP_VERSION },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: {},
        prompts: {},
      },
    },
  );

  telemetry.capture('relaycast_mcp_server_started', {
    source_surface: 'mcp',
    transport: options.telemetryTransport ?? 'unknown',
  });

  const getSession = () => session;
  const getRelay = () => {
    const workspaceKey = session.workspaceKey;
    if (!workspaceKey) {
      throw new Error(
        'Workspace key not configured. Set RELAY_API_KEY at startup, or call "workspace.create" or "workspace.set_key" first.',
      );
    }
    return createInternalRelayCast({
      apiKey: workspaceKey,
      baseUrl: options.baseUrl,
    }, mcpOrigin);
  };
  const setSession = (partial: Partial<SessionState>) => {
    const switchingToken = partial.agentToken !== undefined && partial.agentToken !== session.agentToken;

    if (switchingToken && session.wsBridge) {
      session.wsBridge.stop();
      session.subscriptions?.clear();
      session.wsBridge = null;
      session.subscriptions = null;
    }

    if (switchingToken) {
      session.wsInitAttempted = false;
    }

    // Apply the partial state update
    Object.assign(session, partial);

    // If we have a token but no bridge yet, and we haven't failed initialization, try to start it.
    if (session.agentToken && !session.wsBridge && !session.wsInitAttempted) {
      try {
        const subscriptions = new SubscriptionManager();
        const wsClient = createInternalWsClient({
          token: session.agentToken,
          baseUrl: options.baseUrl,
        }, mcpOrigin);
        const wsBridge = new WsBridge(
          wsClient,
          subscriptions,
          (uri: string) => {
            mcpServer.server.sendResourceUpdated({ uri }).catch(() => {
              // Silently ignore notification failures
            });
          },
        );
        wsBridge.start();
        session.wsBridge = wsBridge;
        session.subscriptions = subscriptions;
        session.wsInitAttempted = true;
      } catch {
        // In non-WS runtimes (e.g. some test environments), keep session usable
        // without real-time resource updates.
        session.wsBridge = null;
        session.subscriptions = null;
        session.wsInitAttempted = true;
      }
      telemetry.capture('relaycast_mcp_session_authenticated', {
        source_surface: 'mcp',
        agent_name: session.agentName,
      });
    }
  };

  const getAgentClient = (): AgentClient => {
    if (!session.agentToken) {
      throw new Error('Not registered. Call the "agent.register" tool first.');
    }
    return createInternalRelayCast({
      apiKey: session.agentToken,
      baseUrl: options.baseUrl,
    }, mcpOrigin).as(
      session.agentToken,
    );
  };

  // Enable piggybacking of unread messages on all tool responses
  enablePiggyback(mcpServer, getSession, getAgentClient, telemetry);

  // Register resource definitions (inbox, agents, channels, etc.)
  registerResourceDefinitions(mcpServer, getAgentClient, getRelay);

  // Register all tools
  registerRegistrationTools(
    mcpServer,
    getRelay,
    getSession,
    setSession,
    options.baseUrl,
    options.strictAgentName,
    options.agentName,
    options.agentType,
  );
  registerChannelTools(mcpServer, getAgentClient);
  registerMessagingTools(mcpServer, getAgentClient);
  registerFeatureTools(mcpServer, getAgentClient);
  registerProgrammabilityTools(mcpServer, getRelay, getAgentClient);

  // Register system prompt
  registerSystemPrompt(mcpServer);

  // If pre-bootstrapped with an agent token, initialize the WS bridge now.
  // This runs setSession to trigger the same WS bridge setup that happens
  // when an agent calls the `register` tool explicitly.
  if (session.agentToken && !session.wsBridge) {
    setSession({ agentToken: session.agentToken, agentName: session.agentName });
  }

  // Override tools/list to strip fields that break Smithery's scanner:
  // - `execution` (SDK v1.26+ experimental tasks feature)
  // - `outputSchema` (adds ~8KB, pushes response past scanner size/time limits)
  // - `_meta` (internal SDK field)
  // These fields are only stripped from the LIST response; tool call validation
  // still uses the full schemas for structuredContent.
  type RequestHandlerMap = Map<string, ServerRequestHandler<unknown>>;
  const handlers = (mcpServer.server as unknown as { _requestHandlers: RequestHandlerMap })._requestHandlers;
  const origToolsListHandler = handlers.get('tools/list') as ServerRequestHandler<
    ListToolsRequest,
    ListToolsResult
  > | undefined;
  if (origToolsListHandler) {
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = await origToolsListHandler(req, extra);
      if (result?.tools) {
        result.tools = result.tools.map(t => {
          const { execution: _execution, outputSchema: _outputSchema, _meta, ...clean } = t;
          return clean;
        });
      }
      return result;
    });
  }

  const origCallToolHandler = handlers.get('tools/call') as ServerRequestHandler<CallToolRequest> | undefined;
  if (origCallToolHandler) {
    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const resolvedName = resolveToolName(req.params.name);
      const request = resolvedName === req.params.name
        ? req
        : {
            ...req,
            params: {
              ...req.params,
              name: resolvedName,
            },
          };
      return await origCallToolHandler(request, extra);
    });
  }

  return mcpServer;
}
