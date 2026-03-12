import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentClient, type RelayCast, type WorkspaceRef } from '@relaycast/sdk';
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
import {
  buildMultiWorkspaceManager,
  resolveDefaultWorkspaceId,
  validateWorkspaceConfigs,
  type McpWorkspaceConfig,
} from './workspaces.js';

export const MCP_VERSION = '0.1.2';

type SelectedWorkspace =
  | { kind: 'configured'; workspaceId: string }
  | { kind: 'legacy' }
  | null;

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
  /** Multi-workspace bootstrap config for stdio/embedded use. */
  workspaces?: McpWorkspaceConfig[];
  /** Default workspace ID or alias used when a tool call omits workspace routing. */
  defaultWorkspace?: string;
  telemetryTransport?: 'stdio' | 'http';
  telemetry?: McpTelemetry;
}

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const configuredWorkspaces = validateWorkspaceConfigs(options.workspaces ?? []).map((workspace) => ({
    ...workspace,
  }));
  const workspaceById = new Map(configuredWorkspaces.map((workspace) => [workspace.workspaceId, workspace]));
  const defaultWorkspaceId = resolveDefaultWorkspaceId(configuredWorkspaces, options.defaultWorkspace);
  let selectedWorkspace: SelectedWorkspace = defaultWorkspaceId
    ? { kind: 'configured', workspaceId: defaultWorkspaceId }
    : configuredWorkspaces.length === 0 && (options.apiKey || options.agentToken || options.agentName)
      ? { kind: 'legacy' }
      : null;
  let multiWorkspaceManager = buildMultiWorkspaceManager(
    configuredWorkspaces,
    defaultWorkspaceId,
    options.baseUrl,
  );
  const selectedConfiguredWorkspace = selectedWorkspace?.kind === 'configured'
    ? workspaceById.get(selectedWorkspace.workspaceId) ?? null
    : null;
  const session: SessionState = createInitialSession({
    workspaceKey: selectedConfiguredWorkspace?.workspaceKey ?? options.apiKey ?? null,
    agentToken: selectedConfiguredWorkspace?.agentToken ?? options.agentToken ?? null,
    agentName: selectedConfiguredWorkspace?.agentName ?? options.agentName ?? null,
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
  const matchConfiguredWorkspaceByKey = (workspaceKey: string | null | undefined): string | null => {
    if (!workspaceKey) return null;
    for (const workspace of configuredWorkspaces) {
      if (workspace.workspaceKey === workspaceKey) {
        return workspace.workspaceId;
      }
    }
    return null;
  };
  const rebuildMultiWorkspaceState = (): void => {
    multiWorkspaceManager = buildMultiWorkspaceManager(
      configuredWorkspaces,
      defaultWorkspaceId,
      options.baseUrl,
    );
  };
  const resolveConfiguredWorkspaceId = (workspace?: WorkspaceRef): string => {
    const workspaceId = workspace?.workspaceId?.trim();
    if (workspaceId) {
      if (!workspaceById.has(workspaceId)) {
        throw new Error(`Workspace "${workspaceId}" is not configured.`);
      }
      return workspaceId;
    }

    const workspaceAlias = workspace?.workspaceAlias?.trim();
    if (workspaceAlias) {
      const matchedWorkspace = configuredWorkspaces.find(
        (membership) => membership.workspaceAlias === workspaceAlias,
      );
      if (!matchedWorkspace) {
        throw new Error(`Workspace alias "${workspaceAlias}" is not configured.`);
      }
      return matchedWorkspace.workspaceId;
    }

    if (selectedWorkspace?.kind === 'configured') {
      return selectedWorkspace.workspaceId;
    }

    if (defaultWorkspaceId) {
      return defaultWorkspaceId;
    }

    if (configuredWorkspaces.length === 1) {
      return configuredWorkspaces[0]!.workspaceId;
    }

    throw new Error('Ambiguous workspace selection. Provide workspace_id or workspace_alias.');
  };
  const getRelay = (workspace?: WorkspaceRef): RelayCast => {
    const workspaceKey = selectedWorkspace?.kind === 'legacy' && !workspace
      ? session.workspaceKey
      : (() => {
        if (configuredWorkspaces.length === 0 && !workspace) {
          return session.workspaceKey;
        }
        const configuredWorkspace = workspaceById.get(resolveConfiguredWorkspaceId(workspace));
        return configuredWorkspace?.workspaceKey ?? null;
      })();
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
    let nextPartial = { ...partial };

    if (partial.workspaceKey !== undefined) {
      const matchedWorkspaceId = matchConfiguredWorkspaceByKey(partial.workspaceKey);
      if (matchedWorkspaceId) {
        selectedWorkspace = { kind: 'configured', workspaceId: matchedWorkspaceId };
        const configuredWorkspace = workspaceById.get(matchedWorkspaceId)!;
        nextPartial = {
          ...nextPartial,
          workspaceKey: configuredWorkspace.workspaceKey ?? partial.workspaceKey ?? null,
          agentToken: partial.agentToken === undefined
            ? configuredWorkspace.agentToken ?? null
            : partial.agentToken,
          agentName: partial.agentName === undefined
            ? configuredWorkspace.agentName ?? null
            : partial.agentName,
        };
      } else if (partial.workspaceKey) {
        selectedWorkspace = { kind: 'legacy' };
      } else {
        selectedWorkspace = defaultWorkspaceId
          ? { kind: 'configured', workspaceId: defaultWorkspaceId }
          : configuredWorkspaces.length === 0
            ? null
            : configuredWorkspaces.length === 1
              ? { kind: 'configured', workspaceId: configuredWorkspaces[0]!.workspaceId }
              : null;
      }
    }

    const nextAgentToken =
      nextPartial.agentToken === undefined ? session.agentToken : nextPartial.agentToken;
    const nextAgentName = nextPartial.agentName ?? session.agentName ?? null;
    const shouldResetBridge =
      nextPartial.agentToken !== undefined && nextPartial.agentToken !== session.agentToken;

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
        Object.assign(session, nextPartial, {
          wsBridge,
          subscriptions,
          wsInitAttempted: true,
        });
      } catch {
        // In non-WS runtimes (e.g. some test environments), keep session usable
        // without real-time resource updates.
        Object.assign(session, nextPartial, {
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
      Object.assign(session, nextPartial);
    }

    if (selectedWorkspace?.kind === 'configured') {
      const configuredWorkspace = workspaceById.get(selectedWorkspace.workspaceId);
      if (configuredWorkspace) {
        configuredWorkspace.workspaceKey = session.workspaceKey ?? undefined;
        configuredWorkspace.agentToken = session.agentToken ?? undefined;
        configuredWorkspace.agentName = session.agentName ?? undefined;
        rebuildMultiWorkspaceState();
      }
    }
  };

  const getAgentClient = (workspace?: WorkspaceRef): AgentClient => {
    if (workspace) {
      const workspaceId = resolveConfiguredWorkspaceId(workspace);
      const configuredWorkspace = workspaceById.get(workspaceId)!;
      if (!configuredWorkspace.agentToken || !multiWorkspaceManager) {
        throw new Error(
          `Agent token not configured for workspace "${workspaceId}". Call "register" for that workspace first.`,
        );
      }
      return multiWorkspaceManager.agentFor({ workspaceId });
    }

    if (selectedWorkspace?.kind === 'legacy') {
      if (!session.agentToken) {
        throw new Error('Not registered. Call the "register" tool first.');
      }
      return createInternalRelayCast({
        apiKey: session.agentToken,
        baseUrl: options.baseUrl,
      }, mcpOrigin).as(
        session.agentToken,
      );
    }

    if (configuredWorkspaces.length > 0) {
      const workspaceId = resolveConfiguredWorkspaceId();
      const configuredWorkspace = workspaceById.get(workspaceId)!;
      if (!configuredWorkspace.agentToken || !multiWorkspaceManager) {
        throw new Error(
          `Agent token not configured for workspace "${workspaceId}". Call "register" for that workspace first.`,
        );
      }
      return multiWorkspaceManager.agentFor({ workspaceId });
    }

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
