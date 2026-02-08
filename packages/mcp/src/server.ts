import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Relay, AgentClient, WsClient } from '@agent-relay/sdk';
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

export interface McpServerOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const relay = new Relay({ apiKey: options.apiKey, baseUrl: options.baseUrl });
  const session: SessionState = createInitialSession();

  const mcpServer = new McpServer(
    { name: 'agent-relay', version: '0.1.0' },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: {},
        prompts: {},
      },
    },
  );

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
  enablePiggyback(mcpServer, getSession, getAgentClient);

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

