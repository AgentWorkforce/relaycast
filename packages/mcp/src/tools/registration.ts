import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Relay } from '@agent-relay/sdk';
import type { SessionState } from '../types.js';

export function registerRegistrationTools(
  server: McpServer,
  getRelay: () => Relay,
  getSession: () => SessionState,
  setSession: (state: Partial<SessionState>) => void,
): void {
  // Tool 1: register
  server.registerTool(
    'register',
    {
      description:
        'Register this agent in the workspace and obtain an agent token for subsequent operations.',
      inputSchema: {
        name: z.string().describe('Unique agent name'),
        type: z.enum(['agent', 'human']).optional().describe('Agent type'),
        persona: z.string().optional().describe('Agent persona description'),
      },
    },
    async ({ name, type, persona }) => {
      const relay = getRelay();
      const result = await relay.agents.register({ name, type, persona });
      // Store the agent token in session state
      setSession({ agentToken: result.token, agentName: name });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // Tool 2: list_agents
  server.registerTool(
    'list_agents',
    {
      description: 'List all agents registered in the workspace.',
      inputSchema: {
        status: z
          .enum(['online', 'offline'])
          .optional()
          .describe('Filter by agent status'),
      },
    },
    async ({ status }) => {
      const relay = getRelay();
      const agents = await relay.agents.list(status ? { status } : undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
      };
    },
  );
}

