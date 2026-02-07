import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Relay, AgentClient } from '@agent-relay/sdk';
import { registerRegistrationTools } from './tools/registration.js';
import { registerChannelTools } from './tools/channels.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerFeatureTools } from './tools/features.js';
import { registerSystemPrompt } from './prompts.js';
import { createInitialSession, type SessionState } from './types.js';

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
        tools: {},
        prompts: {},
      },
    },
  );

  const getRelay = () => relay;
  const getSession = () => session;
  const setSession = (partial: Partial<SessionState>) => {
    Object.assign(session, partial);
  };

  const getAgentClient = (): AgentClient => {
    if (!session.agentToken) {
      throw new Error('Not registered. Call the "register" tool first.');
    }
    return relay.as(session.agentToken);
  };

  // Register all tools
  registerRegistrationTools(mcpServer, getRelay, getSession, setSession);
  registerChannelTools(mcpServer, getAgentClient);
  registerMessagingTools(mcpServer, getAgentClient);
  registerFeatureTools(mcpServer, getAgentClient);

  // Register system prompt
  registerSystemPrompt(mcpServer);

  return mcpServer;
}

