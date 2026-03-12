import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RelayCast } from '@relaycast/sdk';
import type { SessionState, WorkspaceContext } from '../types.js';

type ApiOk<T> = { ok: true; data: T };
type ApiErr = { ok: false; error?: { message?: string } };
type WorkspaceMetadata = {
  workspaceName?: string;
  workspaceLabel?: string;
};

interface CreateWorkspaceResponse {
  workspace_id?: string;
  workspaceId?: string;
  api_key?: string;
  apiKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();
const workspaceEntrySchema = z.object({
  workspace_ref: z.string().describe('Stable workspace reference accepted by "workspace.switch"'),
  workspace_key: z.string().describe('Masked workspace API key for display'),
  workspace_name: z.string().nullable().describe('Canonical workspace name from the Relaycast API'),
  workspace_label: z.string().nullable().describe('Optional custom label saved during "workspace.join"'),
  agent_name: z.string().describe('Saved agent name for this workspace'),
  is_active: z.boolean().describe('True if this workspace is currently active in the session'),
});

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

async function fetchWorkspaceName(
  apiKey: string,
  baseUrl?: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/workspace`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) return undefined;

    const payload = (await response.json()) as ApiOk<{ name?: unknown }> | ApiErr;
    if (!payload || typeof payload !== 'object' || !('ok' in payload) || !payload.ok) {
      return undefined;
    }

    const name = payload.data?.name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function requireWorkspaceKey(session: SessionState): void {
  if (session.workspaceKey) return;
  throw new Error(
    'Workspace key not configured. Call "workspace.create" or "workspace.set_key" first.',
  );
}

function saveWorkspaceContext(
  session: SessionState,
  workspaceKey: string,
  agentToken: string,
  agentName: string,
  metadata: WorkspaceMetadata = {},
): void {
  const existing = session.workspaces.get(workspaceKey);
  session.workspaces.set(workspaceKey, {
    workspaceKey,
    agentToken,
    agentName,
    // Preserve existing workspace metadata if not explicitly provided.
    workspaceName: metadata.workspaceName ?? existing?.workspaceName,
    workspaceLabel: metadata.workspaceLabel ?? existing?.workspaceLabel,
    // Force bridge re-init when this workspace is restored.
    wsBridge: null,
    subscriptions: null,
    wsInitAttempted: false,
  });
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
    'workspace.create',
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

      // Save current workspace context before switching (if registered).
      const session = getSession();
      if (session.workspaceKey && session.agentToken && session.agentName) {
        saveWorkspaceContext(
          session,
          session.workspaceKey,
          session.agentToken,
          session.agentName,
        );
      }
      setSession({ workspaceKey, agentToken: null, agentName: null });

      return {
        content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }],
        structuredContent: workspace as unknown as Record<string, unknown>,
      };
    },
  );

  // Tool 2: set_workspace_key
  server.registerTool(
    'workspace.set_key',
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
        // Save current workspace context before switching (if registered).
        if (session.workspaceKey && session.agentToken && session.agentName) {
          saveWorkspaceContext(
            session,
            session.workspaceKey,
            session.agentToken,
            session.agentName,
          );
        }

        // Restore previously joined workspace context, or start fresh.
        const saved = session.workspaces.get(api_key);
        if (saved) {
          setSession({
            workspaceKey: api_key,
            agentToken: saved.agentToken,
            agentName: saved.agentName,
          });
        } else {
          setSession({ workspaceKey: api_key, agentToken: null, agentName: null });
        }
      } else {
        setSession({ workspaceKey: api_key });
      }

      const saved = session.workspaces.get(api_key);
      const message = !switchingWorkspace
        ? 'Workspace key set.'
        : saved
          ? `Switched to workspace. Restored agent identity "${saved.agentName}".`
          : 'Workspace key set. Call "agent.register" to join this workspace.';

      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    },
  );

  // Tool 3: agent.register
  server.registerTool(
    'agent.register',
    {
      title: 'Register Agent',
      description:
        'Register an agent identity in the current workspace and obtain an agent token for all subsequent operations. The agent name must be unique within the workspace. Once registered, the agent can send messages, join channels, react to messages, and perform all other agent-level actions. Re-registering with the same name returns the existing token.',
      inputSchema: {
        name: z.string().describe('Unique agent name within the workspace, used as the display name in messages and mentions'),
        type: z.enum(['agent', 'human']).optional().describe('Whether this identity represents an AI agent or a human user'),
        persona: z.string().optional().describe('Free-text persona description that other agents can read to understand this agent\'s role and capabilities'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Key-value metadata to attach to the agent (e.g. { "cli": "claude", "model": "claude-sonnet-4-6" }). Use "model" to indicate which AI model powers this agent.'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, type, persona, metadata }) => {
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
        const workspaceName = session.workspaceKey
          ? await fetchWorkspaceName(session.workspaceKey, baseUrl)
          : undefined;
        if (session.workspaceKey) {
          saveWorkspaceContext(
            session,
            session.workspaceKey,
            session.agentToken,
            effectiveName,
            { workspaceName },
          );
        }
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
      const result = await relay.agents.registerOrRotate({
        name: effectiveName,
        type: effectiveType,
        persona,
        metadata,
      });
      // Store the agent token in session state
      setSession({ agentToken: result.token, agentName: effectiveName });

      // Update multi-workspace context map.
      const updatedSession = getSession();
      if (updatedSession.workspaceKey) {
        const workspaceName = await fetchWorkspaceName(updatedSession.workspaceKey, baseUrl);
        saveWorkspaceContext(
          updatedSession,
          updatedSession.workspaceKey,
          result.token,
          effectiveName,
          { workspaceName },
        );
      }
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

  // Tool 4: agent.list
  server.registerTool(
    'agent.list',
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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

  // Tool 5: list_workspaces
  server.registerTool(
    'workspace.list',
    {
      title: 'List Joined Workspaces',
      description:
        'List all workspaces this agent has joined in the current MCP session. Returns a stable workspace_ref for switching, the masked workspace key for display, the canonical workspace name, any saved label, the saved agent name, and whether the workspace is currently active.',
      inputSchema: {
        status: z.enum(['active', 'all']).optional().describe('Filter workspaces by status: "active" for only the current workspace, "all" (default) for every joined workspace'),
      },
      outputSchema: {
        workspaces: z.array(workspaceEntrySchema).describe('Array of joined workspace entries'),
        active_workspace: z.string().nullable().describe('The masked workspace key that is currently active'),
        active_workspace_ref: z.string().nullable().describe('Stable reference for the currently active workspace'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status }) => {
      const session = getSession();
      const all = Array.from(session.workspaces.values()).map((ctx) => ({
        workspace_ref: createWorkspaceRef(ctx.workspaceKey),
        workspace_key: maskKey(ctx.workspaceKey),
        workspace_name: ctx.workspaceName ?? null,
        workspace_label: ctx.workspaceLabel ?? null,
        agent_name: ctx.agentName,
        is_active: ctx.workspaceKey === session.workspaceKey,
      }));
      const entries = status === 'active'
        ? all.filter((e) => e.is_active)
        : all;
      const result = {
        workspaces: entries,
        active_workspace: session.workspaceKey ? maskKey(session.workspaceKey) : null,
        active_workspace_ref: session.workspaceKey ? createWorkspaceRef(session.workspaceKey) : null,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  // Tool 6: join_workspace
  server.registerTool(
    'workspace.join',
    {
      title: 'Join Workspace',
      description:
        'Join an additional workspace by providing its API key and registering an agent identity. The agent will be registered in the target workspace and the session context will be saved, allowing you to switch between workspaces without re-registering. After joining, the new workspace becomes the active workspace.',
      inputSchema: {
        api_key: z.string().describe('Workspace API key starting with "rk_live_"'),
        name: z.string().describe('Agent name to register in the target workspace'),
        workspace_name: z.string().optional().describe('Optional custom label to save for easier switching. The canonical workspace name is fetched automatically from the API.'),
        type: z.enum(['agent', 'human']).optional().describe('Whether this identity represents an AI agent or a human user'),
        persona: z.string().optional().describe('Free-text persona description'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ api_key, name, workspace_name, type, persona }) => {
      if (!api_key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const canonicalWorkspaceName = await fetchWorkspaceName(api_key, baseUrl);

      // Save current workspace context before switching.
      if (session.workspaceKey && session.agentToken && session.agentName) {
        saveWorkspaceContext(
          session,
          session.workspaceKey,
          session.agentToken,
          session.agentName,
        );
      }

      // Check if already joined this workspace.
      const existing = session.workspaces.get(api_key);
      if (existing) {
        if (canonicalWorkspaceName && existing.workspaceName !== canonicalWorkspaceName) {
          existing.workspaceName = canonicalWorkspaceName;
        }
        if (workspace_name && existing.workspaceLabel !== workspace_name) {
          existing.workspaceLabel = workspace_name;
        }
        setSession({
          workspaceKey: api_key,
          agentToken: existing.agentToken,
          agentName: existing.agentName,
        });
        const result = {
          message: `Already joined workspace as "${existing.agentName}". Switched to it.`,
          agent_name: existing.agentName,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      }

      // Switch to new workspace and register.
      setSession({ workspaceKey: api_key, agentToken: null, agentName: null });

      const relay = getRelay();
      const regResult = await relay.agents.registerOrRotate({ name, type, persona });
      setSession({ agentToken: regResult.token, agentName: name });

      // Save the new workspace context.
      const updatedSession = getSession();
      saveWorkspaceContext(updatedSession, api_key, regResult.token, name, {
        workspaceName: canonicalWorkspaceName,
        workspaceLabel: workspace_name,
      });

      const result = {
        message: `Joined workspace and registered as "${name}".`,
        ...regResult,
        agent_name: name,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  // Tool 7: switch_workspace
  server.registerTool(
    'workspace.switch',
    {
      title: 'Switch Workspace',
      description:
        'Switch the active workspace to a previously joined workspace. Provide either a full api_key, workspace_ref from "workspace.list", or workspace_name matching either the canonical workspace record name or a saved custom label. The agent identity and WebSocket connection for the target workspace are restored from the saved session context.',
      inputSchema: {
        api_key: z.string().optional().describe('Full workspace API key to switch to (must have been previously joined)'),
        workspace_ref: z.string().optional().describe('Stable workspace reference from "workspace.list"'),
        workspace_name: z.string().optional().describe('Canonical workspace name from the API, or a saved custom label from "workspace.join"'),
      },
      outputSchema: {
        message: z.string().describe('Confirmation message'),
        agent_name: z.string().describe('The restored agent name in the target workspace'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ api_key, workspace_ref, workspace_name }) => {
      if (!api_key && !workspace_ref && !workspace_name) {
        throw new Error('Provide "api_key", "workspace_ref", or "workspace_name".');
      }
      if (api_key && !api_key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const resolved = resolveSavedWorkspace(session, api_key, workspace_ref, workspace_name);
      if (!resolved) {
        throw new Error(
          'Workspace not found in session. Use "workspace.join" to join it first, or "workspace.set_key" to connect without a saved context.',
        );
      }
      const { workspaceKey: targetWorkspaceKey, context: saved } = resolved;

      // Save current workspace context.
      if (session.workspaceKey && session.agentToken && session.agentName) {
        saveWorkspaceContext(
          session,
          session.workspaceKey,
          session.agentToken,
          session.agentName,
        );
      }

      // Restore the target workspace context.
      setSession({
        workspaceKey: targetWorkspaceKey,
        agentToken: saved.agentToken,
        agentName: saved.agentName,
      });

      const result = {
        message: `Switched to workspace. Restored agent identity "${saved.agentName}".`,
        agent_name: saved.agentName,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}

function createWorkspaceRef(workspaceKey: string): string {
  return `ws_${createHash('sha256').update(workspaceKey).digest('hex').slice(0, 12)}`;
}

function resolveSavedWorkspace(
  session: SessionState,
  apiKey?: string,
  workspaceRef?: string,
  workspaceName?: string,
): { workspaceKey: string; context: WorkspaceContext } | null {
  if (apiKey) {
    const exact = session.workspaces.get(apiKey);
    if (exact) {
      return { workspaceKey: apiKey, context: exact };
    }

    const maskedMatches = Array.from(session.workspaces.entries()).filter(
      ([workspaceKey]) => maskKey(workspaceKey) === apiKey,
    );
    if (maskedMatches.length > 1) {
      throw new Error(
        'Masked workspace key is ambiguous. Use "workspace_ref" from "workspace.list" or the full api_key.',
      );
    }
    if (maskedMatches.length === 1) {
      const [workspaceKey, context] = maskedMatches[0];
      return { workspaceKey, context };
    }
  }

  if (workspaceRef) {
    for (const [workspaceKey, context] of session.workspaces.entries()) {
      if (createWorkspaceRef(workspaceKey) === workspaceRef) {
        return { workspaceKey, context };
      }
    }
  }

  if (workspaceName) {
    const nameMatches = Array.from(session.workspaces.entries()).filter(
      ([, ctx]) =>
        ctx.workspaceName?.toLowerCase() === workspaceName.toLowerCase()
        || ctx.workspaceLabel?.toLowerCase() === workspaceName.toLowerCase(),
    );
    if (nameMatches.length > 1) {
      throw new Error(
        `Multiple workspaces match name "${workspaceName}". Use "workspace_ref" or "api_key" instead.`,
      );
    }
    if (nameMatches.length === 1) {
      const [workspaceKey, context] = nameMatches[0];
      return { workspaceKey, context };
    }
  }

  return null;
}

/** Mask a workspace key for display, showing only first 12 and last 4 chars. */
function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}
