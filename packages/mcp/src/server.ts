import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ListToolsResult,
  type ServerNotification,
  type ServerRequest,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
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
import { resolveToolName } from './tool-aliases.js';
import type { McpWorkspaceConfig } from './workspaces.js';
import { findWorkspaceContext } from './workspaces.js';
import type { RegisteredAgent } from './types.js';

export const MCP_VERSION = '0.1.2';

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
  telemetryTransport?: 'stdio' | 'http';
  telemetry?: McpTelemetry;
  /** Multi-workspace configs parsed from RELAY_WORKSPACES_JSON. */
  workspaces?: McpWorkspaceConfig[];
  /** Default workspace ID or alias to use as the active workspace. */
  defaultWorkspace?: string;
}

type AgentRouting = {
  workspace_id?: string;
  workspace_alias?: string;
  as?: string;
};

type ResolvedAgentIdentity = {
  workspaceKey: string;
  agentToken: string;
  agentName: string;
};

type RelayErrorLike = {
  code?: unknown;
  rawCode?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

type ServerRequestHandler<TRequest, TResult extends ServerResult = ServerResult> = (
  request: TRequest,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => TResult | Promise<TResult>;

function normalizeErrorField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function isInvalidAgentTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as RelayErrorLike;
  const code = normalizeErrorField(err.code);
  const rawCode = normalizeErrorField(err.rawCode);
  const message = typeof err.message === 'string' ? err.message.trim() : '';
  const status = typeof err.status === 'number'
    ? err.status
    : typeof err.statusCode === 'number'
      ? err.statusCode
      : undefined;

  if (code === 'agent_token_invalid' || rawCode === 'agent_token_invalid') {
    return true;
  }

  return message === 'Invalid agent token'
    && status === 401
    && (code === 'unauthorized' || rawCode === 'unauthorized');
}

function isInvalidAgentTokenToolResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const toolResult = result as {
    isError?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (toolResult.isError !== true || !Array.isArray(toolResult.content)) {
    return false;
  }

  return toolResult.content.some((entry) => (
    entry.type === 'text'
    && typeof entry.text === 'string'
    && entry.text.trim() === 'Invalid agent token'
  ));
}

function extractToolCallRouting(request: CallToolRequest): AgentRouting {
  const args = request.params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};

  const values = args as Record<string, unknown>;
  return {
    workspace_id: typeof values.workspace_id === 'string' ? values.workspace_id : undefined,
    workspace_alias: typeof values.workspace_alias === 'string' ? values.workspace_alias : undefined,
    as: typeof values.as === 'string' ? values.as : undefined,
  };
}

function agentTokenRecoveryMessage(): string {
  return [
    'agent_token_invalid: The selected Relaycast agent token is no longer valid.',
    'The stale token was cleared from this MCP session.',
    'Call the "agent.register" tool with the configured agent name to obtain a fresh token, then retry the failed operation.',
  ].join(' ');
}

export function createRelayMcpServer(options: McpServerOptions): McpServer {
  const session: SessionState = createInitialSession({
    workspaceKey: options.apiKey ?? null,
    agentToken: options.agentToken ?? null,
    agentName: options.agentName ?? null,
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
  const getRelay = (
    wsRouting?: { workspace_id?: string; workspace_alias?: string },
    asAgent?: string,
  ) => {
    if (!session.workspaceKey) {
      throw new Error(
        'Workspace key not configured. Set RELAY_API_KEY at startup, or call "workspace.create" or "workspace.set_key" first.',
      );
    }
    if (!wsRouting && !asAgent) {
      return createInternalRelayCast({
        apiKey: session.workspaceKey,
        baseUrl: options.baseUrl,
      }, mcpOrigin);
    }

    const identity = resolveAgentIdentity(wsRouting, asAgent);
    return createInternalRelayCast({
      apiKey: identity.workspaceKey,
      baseUrl: options.baseUrl,
    }, mcpOrigin);
  };
  const syncActiveWorkspaceContext = () => {
    if (!session.workspaceKey || !session.agentToken || !session.agentName) {
      return;
    }

    const existing = session.workspaces.get(session.workspaceKey);
    const agents = new Map(existing?.agents ?? []);
    for (const [agentName, agent] of session.agents) {
      agents.set(agentName, agent);
    }
    agents.set(session.agentName, {
      agentName: session.agentName,
      agentToken: session.agentToken,
    });

    session.workspaces.set(session.workspaceKey, {
      workspaceKey: session.workspaceKey,
      agentToken: session.agentToken,
      agentName: session.agentName,
      agents,
      workspaceName: existing?.workspaceName,
      workspaceLabel: existing?.workspaceLabel,
      wsBridge: session.wsBridge,
      subscriptions: session.subscriptions,
      wsInitAttempted: session.wsInitAttempted,
    });
  };
  const notifySubscribers = () => {
    const uris = session.subscriptions?.getAll() ?? [];
    for (const uri of uris) {
      mcpServer.server.sendResourceUpdated({ uri }).catch(() => {});
    }
  };

  const setSession = (partial: Partial<SessionState>) => {
    const switchingWorkspace = partial.workspaceKey !== undefined && partial.workspaceKey !== session.workspaceKey;
    const changingToken = partial.agentToken !== undefined && partial.agentToken !== session.agentToken;

    // In a single MCP process the bridge tracks the active workspace, not
    // every agent token update inside that workspace. Rebuild it only when
    // the workspace itself changes.
    if (switchingWorkspace) {
      // Notify subscribers before tearing down so clients know data changed
      notifySubscribers();
      session.wsBridge?.stop();
      session.subscriptions?.clear();
      session.wsBridge = null;
      session.subscriptions = null;
      session.wsInitAttempted = false;
    }

    // Apply the partial state update
    Object.assign(session, partial);

    // When the agent token changes within the same workspace, notify
    // subscribers that resource data may have changed.
    if (!switchingWorkspace && changingToken) {
      notifySubscribers();
    }

    // If we have a token but no bridge yet, and we haven't failed initialization, try to start it.
    if (session.agentToken && !session.wsBridge && !session.wsInitAttempted) {
      try {
        const subscriptions = new SubscriptionManager();
        const wsClient = createInternalWsClient({
          token: session.agentToken,
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
        session.wsBridge = wsBridge;
        session.subscriptions = subscriptions;
        session.wsInitAttempted = true;
      } catch {
        // In non-WS runtimes (e.g. some test environments), keep session usable
        // without real-time resource updates.
        session.wsBridge = null;
        session.subscriptions = null;
        session.wsInitAttempted = true;
      }
      telemetry.capture('relaycast_mcp_session_authenticated', {
        source_surface: 'mcp',
        agent_name: session.agentName,
      });
    }

    syncActiveWorkspaceContext();
  };

  const resolveRegisteredToken = (
    agents: Map<string, RegisteredAgent>,
    agentName?: string,
  ): string | null => {
    if (!agentName) return null;
    return agents.get(agentName)?.agentToken ?? null;
  };

  const invalidateActiveAgentToken = (
    routing?: { workspace_id?: string; workspace_alias?: string },
    asAgent?: string,
  ) => {
    const routedContext = routing && (routing.workspace_id || routing.workspace_alias)
      ? findWorkspaceContext(session, routing, options.workspaces)
      : undefined;
    const targetWorkspaceKey = routedContext?.workspaceKey ?? session.workspaceKey;
    if (!targetWorkspaceKey) return;

    const isActiveWorkspace = targetWorkspaceKey === session.workspaceKey;
    const targetContext = routedContext ?? session.workspaces.get(targetWorkspaceKey);
    const currentAgentName = isActiveWorkspace
      ? session.agentName
      : targetContext?.agentName ?? null;
    const invalidAgentName = asAgent ?? currentAgentName ?? undefined;
    const sourceAgents = isActiveWorkspace ? session.agents : (targetContext?.agents ?? []);
    const nextAgents = new Map(sourceAgents);
    if (invalidAgentName) {
      nextAgents.delete(invalidAgentName);
    }

    const invalidatesDefaultAgent = !asAgent || asAgent === currentAgentName;
    if (isActiveWorkspace && invalidatesDefaultAgent) {
      session.wsBridge?.stop();
      session.subscriptions?.clear();
      setSession({
        agentToken: null,
        agents: nextAgents,
        wsBridge: null,
        subscriptions: null,
        wsInitAttempted: false,
      });
    } else if (isActiveWorkspace) {
      setSession({ agents: nextAgents });
    }

    const existing = targetContext ?? session.workspaces.get(targetWorkspaceKey);
    if (!existing) return;

    session.workspaces.set(targetWorkspaceKey, {
      ...existing,
      agentToken: invalidatesDefaultAgent ? '' : existing.agentToken,
      agents: nextAgents,
      wsBridge: isActiveWorkspace && invalidatesDefaultAgent ? null : existing.wsBridge,
      subscriptions: isActiveWorkspace && invalidatesDefaultAgent ? null : existing.subscriptions,
      wsInitAttempted: isActiveWorkspace && invalidatesDefaultAgent ? false : existing.wsInitAttempted,
    });
  };

  const resolveAgentIdentity = (
    wsRouting?: { workspace_id?: string; workspace_alias?: string },
    asAgent?: string,
  ): ResolvedAgentIdentity => {
    if (wsRouting && (wsRouting.workspace_id || wsRouting.workspace_alias)) {
      const ctx = findWorkspaceContext(session, wsRouting, options.workspaces);
      if (!ctx) {
        throw new Error(
          `Workspace not found: ${wsRouting.workspace_id ?? wsRouting.workspace_alias}. ` +
          'Join the workspace first via "workspace.join" or bootstrap via RELAY_WORKSPACES_JSON.',
        );
      }
      const routedToken = resolveRegisteredToken(ctx.agents, asAgent) ?? ctx.agentToken;
      if (asAgent && !resolveRegisteredToken(ctx.agents, asAgent)) {
        throw new Error(
          `Unknown agent identity "${asAgent}" for workspace ${wsRouting.workspace_id ?? wsRouting.workspace_alias}. Register it first.`,
        );
      }
      return {
        workspaceKey: ctx.workspaceKey,
        agentToken: routedToken,
        agentName: asAgent ?? ctx.agentName,
      };
    }

    const activeToken = resolveRegisteredToken(session.agents, asAgent) ?? session.agentToken;
    if (asAgent && !resolveRegisteredToken(session.agents, asAgent)) {
      throw new Error(`Unknown agent identity "${asAgent}". Register it first.`);
    }

    if (!activeToken) {
      throw new Error('Not registered. Call the "agent.register" tool first.');
    }

    return {
      workspaceKey: session.workspaceKey ?? activeToken,
      agentToken: activeToken,
      agentName: asAgent ?? session.agentName ?? '',
    };
  };

  const getAgentClient = (
    wsRouting?: { workspace_id?: string; workspace_alias?: string },
    asAgent?: string,
  ): AgentClient => {
    const identity = resolveAgentIdentity(wsRouting, asAgent);
    return createInternalRelayCast({
      apiKey: identity.agentToken,
      baseUrl: options.baseUrl,
    }, mcpOrigin).as(identity.agentToken);
  };

  // Enable piggybacking of unread messages on all tool responses
  enablePiggyback(
    mcpServer,
    getSession,
    getAgentClient,
    telemetry,
    (routing?: AgentRouting) => resolveAgentIdentity(routing, routing?.as),
  );

  // Register resource definitions (inbox, agents, channels, etc.)
  registerResourceDefinitions(mcpServer, getAgentClient, getRelay);

  // Register subscribe/unsubscribe handlers so clients can track resource changes
  mcpServer.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    session.subscriptions?.subscribe(req.params.uri);
    return {};
  });
  mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    session.subscriptions?.unsubscribe(req.params.uri);
    return {};
  });

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
  registerProgrammabilityTools(mcpServer, getRelay);

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
  type RequestHandlerMap = Map<string, ServerRequestHandler<unknown>>;
  const handlers = (mcpServer.server as unknown as { _requestHandlers: RequestHandlerMap })._requestHandlers;
  const origToolsListHandler = handlers.get('tools/list') as ServerRequestHandler<
    ListToolsRequest,
    ListToolsResult
  > | undefined;
  if (origToolsListHandler) {
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = await origToolsListHandler(req, extra);
      if (result?.tools) {
        result.tools = result.tools.map(t => {
          const { execution: _execution, outputSchema: _outputSchema, _meta, ...clean } = t;
          return clean;
        });
      }
      return result;
    });
  }

  const origCallToolHandler = handlers.get('tools/call') as ServerRequestHandler<CallToolRequest> | undefined;
  if (origCallToolHandler) {
    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const resolvedName = resolveToolName(req.params.name);
      const request = resolvedName === req.params.name
        ? req
        : {
            ...req,
            params: {
              ...req.params,
              name: resolvedName,
            },
          };
      try {
        const result = await origCallToolHandler(request, extra);
        if (isInvalidAgentTokenToolResult(result)) {
          const routing = extractToolCallRouting(request);
          invalidateActiveAgentToken(routing, routing.as);
          const errorResult = result as typeof result & {
            content?: Array<{ type: 'text'; text: string }>;
          };
          return {
            ...result,
            content: [
              ...(Array.isArray(errorResult.content) ? errorResult.content : []),
              { type: 'text' as const, text: agentTokenRecoveryMessage() },
            ],
          };
        }
        return result;
      } catch (error) {
        if (isInvalidAgentTokenError(error)) {
          const routing = extractToolCallRouting(request);
          invalidateActiveAgentToken(routing, routing.as);
          throw new Error(agentTokenRecoveryMessage());
        }
        throw error;
      }
    });
  }

  // Populate workspace contexts from options so routing works without
  // external code reaching into server internals.
  if (options.workspaces?.length) {
    for (const ws of options.workspaces) {
      if (ws.agent_token && ws.agent_name) {
        const existing = session.workspaces.get(ws.api_key);
        const agents = new Map(existing?.agents ?? []);
        agents.set(ws.agent_name, {
          agentName: ws.agent_name,
          agentToken: ws.agent_token,
        });
        session.workspaces.set(ws.api_key, {
          workspaceKey: ws.api_key,
          agentToken: ws.agent_token,
          agentName: ws.agent_name,
          agents,
          workspaceName: ws.workspace_name ?? existing?.workspaceName,
          workspaceLabel: existing?.workspaceLabel,
          wsBridge: null,
          subscriptions: null,
          wsInitAttempted: false,
        });
      }
    }
  }

  if (session.workspaceKey && session.agentToken && session.agentName) {
    const existing = session.workspaces.get(session.workspaceKey);
    session.workspaces.set(session.workspaceKey, {
      workspaceKey: session.workspaceKey,
      agentToken: session.agentToken,
      agentName: session.agentName,
      agents: new Map(session.agents),
      workspaceName: existing?.workspaceName,
      workspaceLabel: existing?.workspaceLabel,
      wsBridge: existing?.wsBridge ?? session.wsBridge,
      subscriptions: existing?.subscriptions ?? session.subscriptions,
      wsInitAttempted: existing?.wsInitAttempted ?? session.wsInitAttempted,
    });
  }

  return mcpServer;
}
