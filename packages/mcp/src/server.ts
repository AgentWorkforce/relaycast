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
  apiKey: string;
  baseUrl?: string;
  telemetryTransport?: 'stdio' | 'http';
  telemetry?: McpTelemetry;
}

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const relay = new Relay({ apiKey: options.apiKey, baseUrl: options.baseUrl });
  const session: SessionState = createInitialSession();
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

  const getRelay = () => relay;
  const getSession = () => session;
  const setSession = (partial: Partial<SessionState>) => {
    // When an agent token is set, initialize the WebSocket bridge
    if (partial.agentToken && !session.wsBridge) {
      const subscriptions = new SubscriptionManager();
      const wsClient = new WsClient({
        token: partial.agentToken,
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
        agent_name: partial.agentName ?? session.agentName ?? null,
      });
    } else {
      Object.assign(session, partial);
    }
  };

  const getAgentClient = (): AgentClient => {
    if (!session.agentToken) {
      throw new Error('Not registered. Call the "register" tool first.');
    }
    return relay.as(session.agentToken);
  };

  // Enable piggybacking of unread messages on all tool responses
  enablePiggyback(mcpServer, getSession, getAgentClient, telemetry);

  // Register resource definitions (inbox, agents, channels, etc.)
  registerResourceDefinitions(mcpServer, getAgentClient, getRelay);

  // Register all tools
  registerRegistrationTools(mcpServer, getRelay, getSession, setSession);
  registerChannelTools(mcpServer, getAgentClient);
  registerMessagingTools(mcpServer, getAgentClient);
  registerFeatureTools(mcpServer, getAgentClient);
  registerProgrammabilityTools(mcpServer, getRelay, getAgentClient);

  // Register system prompt
  registerSystemPrompt(mcpServer);

  return mcpServer;
}
