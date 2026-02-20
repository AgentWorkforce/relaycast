import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

export const MCP_VERSION = '0.1.2';

export interface McpServerOptions {
  apiKey?: string;
  baseUrl?: string;
  telemetryTransport?: 'stdio' | 'http';
  telemetry?: McpTelemetry;
}

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const session: SessionState = createInitialSession(options.apiKey ?? null);
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
        'Workspace key not configured. Set RELAY_API_KEY at startup, or call "create_workspace" or "set_workspace_key" first.',
      );
    }
    return createInternalRelayCast({
      apiKey: workspaceKey,
      baseUrl: options.baseUrl,
    }, mcpOrigin);
  };
  const setSession = (partial: Partial<SessionState>) => {
    const nextAgentToken =
      partial.agentToken === undefined ? session.agentToken : partial.agentToken;
    const nextAgentName = partial.agentName ?? session.agentName ?? null;
    const shouldResetBridge =
      partial.agentToken !== undefined && partial.agentToken !== session.agentToken;

    if (shouldResetBridge && session.wsBridge) {
      session.wsBridge.stop();
      session.subscriptions?.clear();
      session.wsBridge = null;
      session.subscriptions = null;
    }
    if (shouldResetBridge) {
      session.wsInitAttempted = false;
    }

    // When an agent token is set, initialize the WebSocket bridge.
    if (nextAgentToken && !session.wsBridge && !session.wsInitAttempted) {
      try {
        const subscriptions = new SubscriptionManager();
        const wsClient = createInternalWsClient({
          token: nextAgentToken,
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
        Object.assign(session, partial, {
          wsBridge,
          subscriptions,
          wsInitAttempted: true,
        });
      } catch {
        // In non-WS runtimes (e.g. some test environments), keep session usable
        // without real-time resource updates.
        Object.assign(session, partial, {
          wsBridge: null,
          subscriptions: null,
          wsInitAttempted: true,
        });
      }
      telemetry.capture('relaycast_mcp_session_authenticated', {
        source_surface: 'mcp',
        agent_name: nextAgentName,
      });
    } else {
      Object.assign(session, partial);
    }
  };

  const getAgentClient = (): AgentClient => {
    if (!session.agentToken) {
      throw new Error('Not registered. Call the "register" tool first.');
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
  );
  registerChannelTools(mcpServer, getAgentClient);
  registerMessagingTools(mcpServer, getAgentClient);
  registerFeatureTools(mcpServer, getAgentClient);
  registerProgrammabilityTools(mcpServer, getRelay, getAgentClient);

  // Register system prompt
  registerSystemPrompt(mcpServer);

  // Override tools/list to strip fields that break Smithery's scanner:
  // - `execution` (SDK v1.26+ experimental tasks feature)
  // - `outputSchema` (adds ~8KB, pushes response past scanner size/time limits)
  // - `_meta` (internal SDK field)
  // These fields are only stripped from the LIST response; tool call validation
  // still uses the full schemas for structuredContent.
  type RequestHandlerMap = Map<string, (...args: unknown[]) => unknown>;
  const handlers = (mcpServer.server as unknown as { _requestHandlers: RequestHandlerMap })._requestHandlers;
  const origToolsListHandler = handlers.get('tools/list');
  if (origToolsListHandler) {
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = (await origToolsListHandler(req, extra)) as { tools?: Record<string, unknown>[] };
      if (result?.tools) {
        result.tools = result.tools.map(t => {
          const { execution, outputSchema, _meta, ...clean } = t;
          return clean;
        });
      }
      return result;
    });
  }

  return mcpServer;
}
