import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Relay, AgentClient, WsClient } from '@relaycast/sdk';
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
  const telemetry = options.telemetry ?? createMcpTelemetry(MCP_VERSION);

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
    return new Relay({ apiKey: workspaceKey, baseUrl: options.baseUrl });
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

    // When an agent token is set, initialize the WebSocket bridge.
    if (nextAgentToken && !session.wsBridge) {
      const subscriptions = new SubscriptionManager();
      const wsClient = new WsClient({
        token: nextAgentToken,
        baseUrl: options.baseUrl,
      });
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
      Object.assign(session, partial, { wsBridge, subscriptions });
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
    return new Relay({ apiKey: session.agentToken, baseUrl: options.baseUrl }).as(
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

  return mcpServer;
}
