import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RelayCast } from '@relaycast/sdk';
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

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

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
  getRelay: () => RelayCast,
  getSession: () => SessionState,
  setSession: (state: Partial<SessionState>) => void,
  baseUrl?: string,
  strictAgentName?: boolean,
  preferredAgentName?: string,
  forcedAgentType?: 'agent' | 'human',
): void {
  // Tool 1: create_workspace
  server.registerTool(
    'create_workspace',
    {
      title: 'Create Workspace',
      description:
        'Create a new Relaycast workspace and automatically store its API key in this MCP session. The workspace serves as an isolated environment where agents can communicate via channels, DMs, and threads. After creation, the workspace key is ready for immediate use with register and other workspace-level tools.',
      inputSchema: {
        name: z.string().describe('Human-readable workspace name, used to identify the workspace in dashboards and logs'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        structuredContent: workspace as unknown as Record<string, unknown>,
      };
    },
  );

  // Tool 2: set_workspace_key
  server.registerTool(
    'set_workspace_key',
    {
      title: 'Set Workspace Key',
      description:
        'Authenticate this MCP session by providing an existing workspace API key (rk_live_...). This enables all workspace-level tools including agent registration, channel management, and messaging. If the key belongs to a different workspace than the current session, the previous agent identity is cleared and you must re-register.',
      inputSchema: {
        api_key: z.string().describe('Workspace API key starting with "rk_live_", obtained from workspace creation or the Relaycast dashboard'),
      },
      outputSchema: {
        message: z.string().describe('Confirmation message indicating whether the workspace key was set successfully'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

      const message = switchingWorkspace
        ? 'Workspace key set. Previous agent session was cleared; call "register" again.'
        : 'Workspace key set.';

      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );

  // Tool 3: register
  server.registerTool(
    'register',
    {
      title: 'Register Agent',
      description:
        'Register an agent identity in the current workspace and obtain an agent token for all subsequent operations. The agent name must be unique within the workspace. Once registered, the agent can send messages, join channels, react to messages, and perform all other agent-level actions. Re-registering with the same name returns the existing token.',
      inputSchema: {
        name: z.string().describe('Unique agent name within the workspace, used as the display name in messages and mentions'),
        type: z.enum(['agent', 'human']).optional().describe('Whether this identity represents an AI agent or a human user'),
        persona: z.string().optional().describe('Free-text persona description that other agents can read to understand this agent\'s role and capabilities'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, type, persona }) => {
      const session = getSession();
      requireWorkspaceKey(session);

      const configuredName = session.agentName
        ?? preferredAgentName?.trim()
        ?? null;
      const warnings: string[] = [];

      // In strict mode, enforce the pre-registered name from the broker.
      // This prevents spawned agents from re-registering under a different name.
      const effectiveName =
        strictAgentName && configuredName ? configuredName : name;
      if (strictAgentName && configuredName && name.trim() !== configuredName) {
        warnings.push(
          `Strict worker identity is enabled; ignoring requested name "${name}" and using "${configuredName}".`,
        );
      }

      const effectiveType = forcedAgentType ?? type;
      if (forcedAgentType && type && type !== forcedAgentType) {
        warnings.push(
          `Forced worker type is enabled; ignoring requested type "${type}" and using "${forcedAgentType}".`,
        );
      }

      // If already pre-registered with a token, skip the API call and return
      // the existing registration to avoid overwriting the pre-registered identity.
      if (session.agentToken && effectiveName && strictAgentName) {
        const existing = {
          name: effectiveName,
          token: session.agentToken,
          registered_name: effectiveName,
          warnings,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(existing, null, 2) }],
          structuredContent: existing as unknown as Record<string, unknown>,
        };
      }

      const relay = getRelay();
      const result = await relay.agents.register({
        name: effectiveName,
        type: effectiveType,
        persona,
      });
      // Store the agent token in session state
      setSession({ agentToken: result.token, agentName: effectiveName });
      const payload = {
        ...result,
        registered_name: effectiveName,
        warnings,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  // Tool 4: list_agents
  server.registerTool(
    'list_agents',
    {
      title: 'List Agents',
      description:
        'Retrieve all agents registered in the current workspace. Returns each agent\'s name, type, persona, and online/offline status. Use the optional status filter to find only agents that are currently connected or disconnected.',
      inputSchema: {
        status: z
          .enum(['online', 'offline'])
          .optional()
          .describe('Filter agents by connection status: "online" for currently connected agents, "offline" for disconnected ones'),
      },
      outputSchema: {
        agents: z.array(z.object({}).passthrough()).describe('Array of registered agent objects with name, type, persona, and status'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ status }) => {
      requireWorkspaceKey(getSession());
      const relay = getRelay();
      const agents = await relay.agents.list(status ? { status } : undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
        structuredContent: { agents: agents as unknown as Record<string, unknown>[] },
      };
    },
  );
}
