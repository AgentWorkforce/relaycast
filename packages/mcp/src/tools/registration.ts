import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Relay } from '@relaycast/sdk';
import type { SessionState } from '../types.js';

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error?: { message?: string } };

interface CreateWorkspaceResponse {
  workspace_id?: string;
  workspaceId?: string;
  api_key?: string;
  apiKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function createWorkspace(
  name: string,
  baseUrl?: string,
): Promise<CreateWorkspaceResponse> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  const payload = (await response.json()) as ApiOk<CreateWorkspaceResponse> | ApiErr;
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    throw new Error('Invalid response while creating workspace');
  }
  if (!payload.ok) {
    throw new Error(payload.error?.message ?? 'Failed to create workspace');
  }
  return payload.data;
}

function requireWorkspaceKey(session: SessionState): void {
  if (session.workspaceKey) return;
  throw new Error(
    'Workspace key not configured. Call "create_workspace" or "set_workspace_key" first.',
  );
}

export function registerRegistrationTools(
  server: McpServer,
  getRelay: () => Relay,
  getSession: () => SessionState,
  setSession: (state: Partial<SessionState>) => void,
  baseUrl?: string,
): void {
  // Tool 1: create_workspace
  server.registerTool(
    'create_workspace',
    {
      description:
        'Create a new workspace and store its workspace key in this MCP session for subsequent registration calls.',
      inputSchema: {
        name: z.string().describe('Workspace name'),
      },
    },
    async ({ name }) => {
      const workspace = await createWorkspace(name, baseUrl);
      const workspaceKey = workspace.api_key ?? workspace.apiKey;
      if (!workspaceKey || typeof workspaceKey !== 'string') {
        throw new Error('Workspace created, but the response did not include api_key');
      }

      // Switching workspace context invalidates prior agent identity.
      setSession({ workspaceKey, agentToken: null, agentName: null });

      return {
        content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }],
      };
    },
  );

  // Tool 2: set_workspace_key
  server.registerTool(
    'set_workspace_key',
    {
      description:
        'Set the workspace key (rk_live_...) for this MCP session. This enables register and workspace-level tools.',
      inputSchema: {
        api_key: z.string().describe('Workspace API key (rk_live_...)'),
      },
    },
    async ({ api_key }) => {
      if (!api_key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const switchingWorkspace = session.workspaceKey !== api_key;
      if (switchingWorkspace) {
        // Switching workspace context invalidates prior agent identity.
        setSession({ workspaceKey: api_key, agentToken: null, agentName: null });
      } else {
        setSession({ workspaceKey: api_key });
      }

      return {
        content: [
          {
            type: 'text',
            text: switchingWorkspace
              ? 'Workspace key set. Previous agent session was cleared; call "register" again.'
              : 'Workspace key set.',
          },
        ],
      };
    },
  );

  // Tool 3: register
  server.registerTool(
    'register',
    {
      description:
        'Register this agent in the current workspace and obtain an agent token for subsequent operations.',
      inputSchema: {
        name: z.string().describe('Unique agent name'),
        type: z.enum(['agent', 'human']).optional().describe('Agent type'),
        persona: z.string().optional().describe('Agent persona description'),
      },
    },
    async ({ name, type, persona }) => {
      requireWorkspaceKey(getSession());
      const relay = getRelay();
      const result = await relay.agents.register({ name, type, persona });
      // Store the agent token in session state
      setSession({ agentToken: result.token, agentName: name });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // Tool 4: list_agents
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
      requireWorkspaceKey(getSession());
      const relay = getRelay();
      const agents = await relay.agents.list(status ? { status } : undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
      };
    },
  );
}
