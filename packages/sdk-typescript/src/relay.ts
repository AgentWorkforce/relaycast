import type {
  A2aAgentCard,
  A2aAgentRecord,
  Agent,
  AgentListQuery,
  AgentPresenceInfo,
  Channel,
  ChannelMemberInfo,
  CreateAgentRequest,
  CreateAgentResponse,
  UpdateAgentRequest,
  UpdateWorkspaceRequest,
  Workspace,
  CreateWorkspaceResponse,
  WorkspaceLookup,
  SystemPrompt,
  SetSystemPromptRequest,
  CreateWebhookRequest,
  CreateWebhookResponse,
  Webhook,
  WebhookTriggerRequest,
  WebhookTriggerResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  EventSubscription,
  ActivityItem,
  DmMessage,
  DmReceivedEvent,
  WorkspaceDmConversation,
  TokenRotateResponse,
  MessageListQuery,
  MessageCreatedEvent,
  MessageReadEvent,
  MessageReactedEvent,
  MessageUpdatedEvent,
  MessageWithMeta,
  ReactionGroup,
  SpawnAgentRequest,
  SpawnAgentResponse,
  ReleaseAgentRequest,
  ReleaseAgentResponse,
  RegisterA2aOptions,
  RegisterA2aResponse,
  RemoveA2aAgentResponse,
  DirectoryAgent,
  DirectorySearchResult,
  ImportSkillsRequest,
  PublishToDirectoryRequest,
  RouteResult,
  RoutingConfig,
  SearchDirectoryQuery,
  UpdateRoutingConfigRequest,
  ListDirectoryQuery,
  UpdateDirectoryAgentRequest,
  DirectoryRating,
  RateDirectoryAgentRequest,
  RouteFeedbackRequest,
  RouteFeedbackResult,
  SkillSearchQuery,
  SkillSearchResult,
  ActionDefinition,
  RegisterActionRequest,
  SessionEvent,
  EmitSessionEventRequest,
  ListSessionEventsQuery,
  CertificationRun,
  SubmitCertificationRequest,
  MonitorCertificationRequest,
  ConsoleMessageLog,
  ConsoleMessagesQuery,
  ConsoleOverview,
  ConsoleAgentStat,
  ConsoleAgentStatsQuery,
  ConsoleWindowQuery,
  ConsoleCostStats,
  ThreadReplyEvent,
  WsClientEvent,
  AgentStatusActiveEvent,
  AgentStatusChangedEvent,
  AgentStatusOfflineEvent,
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelArchivedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  ChannelMutedEvent,
  ChannelUnmutedEvent,
  FileUploadedEvent,
  WebhookReceivedEvent,
  ActionInvokedEvent,
  ActionCompletedEvent,
  ActionDeniedEvent,
  ActionFailedEvent,
  DeliveryAcceptedEvent,
  DeliveryDeliveredEvent,
  DeliveryDeferredEvent,
  DeliveryFailedEvent,
  GroupDmReceivedEvent,
  WsReconnectingEvent,
  WsPermanentlyDisconnectedEvent,
} from './types.js';
import { ApiResponseSchema, CreateWorkspaceResponseSchema, WorkspaceLookupSchema } from '@relaycast/types';
import { AgentClient, type AgentClientOptions } from './agent.js';
import { HttpClient, type RetryPolicyInput } from './client.js';
import { WsClient, type WsClientOptions, withInternalWsOrigin } from './ws.js';
import { RelayError, relayErrorFromApi } from './errors.js';
import {
  appendLegacySuffix,
  emitCompatibilityTelemetry,
  isNameConflictError,
  type RegisterAgentInput,
  type RegisterOrRotateInput,
  type ResolvedIdentity,
} from './identity.js';
import { SDK_VERSION } from './version.js';
import { SDK_ORIGIN } from './origin.js';
import { camelizeKeys } from './casing.js';

export interface RelayCastOptions {
  apiKey: string;
  baseUrl?: string;
  retryPolicy?: RetryPolicyInput;
  ws?: Omit<WsClientOptions, 'token' | 'baseUrl'>;
  /**
   * Optional User-Agent-style identifier for the harness driving requests
   * (e.g. `'claude-code/2.3 (model=opus-4.8)'`, `'codex'`, `'human'`). Sent as
   * the `X-Relaycast-Harness` header on every request so server-side telemetry
   * can attribute traffic to a harness.
   */
  harness?: string;
}

export interface WorkspaceStreamConfig {
  enabled: boolean;
  defaultEnabled: boolean;
  override: boolean | null;
}

export interface WorkspaceBootstrapOptions {
  apiKey?: string;
  baseUrl?: string;
}

export interface AgentReconnectOptions {
  apiToken: string;
  agent?: AgentClientOptions;
}

export type EnsureWorkspaceResponse = { existed: boolean; name: string } & CreateWorkspaceResponse;

interface ChannelListOptions {
  includeArchived?: boolean;
}

type RegisterTypedIdentityInput = Omit<CreateAgentRequest, 'type'>;
type RegisterIdentityType = NonNullable<CreateAgentRequest['type']>;

function resolveWorkspaceBootstrapOptions(
  options?: string | WorkspaceBootstrapOptions,
): WorkspaceBootstrapOptions {
  if (typeof options === 'string') {
    return { baseUrl: options };
  }
  return options ?? {};
}

export class RelayCast {
  private client: HttpClient;
  private ws: WsClient | null = null;
  private wsOptions: Omit<WsClientOptions, 'token' | 'baseUrl'>;
  private identityHint: { agentId: string; name: string } | null = null;
  private workspaceIdHint: string | null = null;

  constructor(options: RelayCastOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error('RelayCast apiKey is required');
    }

    // Preserve hidden internal-origin metadata on options when created via
    // createInternalRelayCast() so downstream requests use the correct origin headers.
    this.client = new HttpClient(options);
    this.wsOptions = options.ws ?? {};
  }

  connect(): void {
    if (this.ws) return;
    this.ws = new WsClient(withInternalWsOrigin(
      {
        token: this.client.apiKey,
        baseUrl: this.client.baseUrl,
        ...this.wsOptions,
      },
      {
        surface: this.client.originSurface,
        client: this.client.originClient,
        version: this.client.originVersion,
        ...(this.client.originHarness ? { harness: this.client.originHarness } : {}),
      },
    ));
    this.ws.connect();
  }

  disconnect(): void {
    if (!this.ws) return;
    this.ws.disconnect();
    this.ws = null;
  }

  private onEvent<T extends WsClientEvent>(eventType: string, handler: (e: T) => void): () => void {
    if (!this.ws) {
      throw new Error('WebSocket not connected. Call connect() first.');
    }
    return this.ws.on(eventType, handler as (e: WsClientEvent) => void);
  }

  on = {
    messageCreated:  (handler: (e: MessageCreatedEvent) => void): (() => void)  => this.onEvent('message.created', handler),
    messageUpdated:  (handler: (e: MessageUpdatedEvent) => void): (() => void)  => this.onEvent('message.updated', handler),
    threadReply:     (handler: (e: ThreadReplyEvent) => void): (() => void)     => this.onEvent('thread.reply', handler),
    messageRead:     (handler: (e: MessageReadEvent) => void): (() => void)     => this.onEvent('message.read', handler),
    messageReacted:  (handler: (e: MessageReactedEvent) => void): (() => void)  => this.onEvent('message.reacted', handler),
    dmReceived:      (handler: (e: DmReceivedEvent) => void): (() => void)      => this.onEvent('dm.received', handler),
    groupDmReceived: (handler: (e: GroupDmReceivedEvent) => void): (() => void) => this.onEvent('group_dm.received', handler),
    agentStatusChanged: (handler: (e: AgentStatusChangedEvent) => void): (() => void) => this.onEvent('agent.status.changed', handler),
    agentActive:     (handler: (e: AgentStatusActiveEvent) => void): (() => void)  => this.onEvent('agent.status.active', handler),
    agentOffline:    (handler: (e: AgentStatusOfflineEvent) => void): (() => void) => this.onEvent('agent.status.offline', handler),
    channelCreated:  (handler: (e: ChannelCreatedEvent) => void): (() => void)  => this.onEvent('channel.created', handler),
    channelUpdated:  (handler: (e: ChannelUpdatedEvent) => void): (() => void)  => this.onEvent('channel.updated', handler),
    channelArchived: (handler: (e: ChannelArchivedEvent) => void): (() => void) => this.onEvent('channel.archived', handler),
    memberJoined:    (handler: (e: MemberJoinedEvent) => void): (() => void)    => this.onEvent('member.joined', handler),
    memberLeft:      (handler: (e: MemberLeftEvent) => void): (() => void)      => this.onEvent('member.left', handler),
    channelMuted:    (handler: (e: ChannelMutedEvent) => void): (() => void)    => this.onEvent('member.channel_muted', handler),
    channelUnmuted:  (handler: (e: ChannelUnmutedEvent) => void): (() => void)  => this.onEvent('member.channel_unmuted', handler),
    fileUploaded:    (handler: (e: FileUploadedEvent) => void): (() => void)    => this.onEvent('file.uploaded', handler),
    webhookReceived: (handler: (e: WebhookReceivedEvent) => void): (() => void) => this.onEvent('webhook.received', handler),
    actionInvoked:   (handler: (e: ActionInvokedEvent) => void): (() => void)   => this.onEvent('action.invoked', handler),
    actionCompleted: (handler: (e: ActionCompletedEvent) => void): (() => void) => this.onEvent('action.completed', handler),
    actionFailed:    (handler: (e: ActionFailedEvent) => void): (() => void)    => this.onEvent('action.failed', handler),
    actionDenied:    (handler: (e: ActionDeniedEvent) => void): (() => void)    => this.onEvent('action.denied', handler),
    deliveryAccepted:  (handler: (e: DeliveryAcceptedEvent) => void): (() => void)  => this.onEvent('delivery.accepted', handler),
    deliveryDelivered: (handler: (e: DeliveryDeliveredEvent) => void): (() => void) => this.onEvent('delivery.delivered', handler),
    deliveryDeferred:  (handler: (e: DeliveryDeferredEvent) => void): (() => void)  => this.onEvent('delivery.deferred', handler),
    deliveryFailed:    (handler: (e: DeliveryFailedEvent) => void): (() => void)    => this.onEvent('delivery.failed', handler),
    connected:    (handler: () => void): (() => void) => this.onEvent('open', handler as (e: never) => void),
    disconnected: (handler: () => void): (() => void) => this.onEvent('close', handler as (e: never) => void),
    error:        (handler: () => void): (() => void) => this.onEvent('error', handler as (e: never) => void),
    reconnecting: (handler: (attempt: number) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('reconnecting', (e: WsClientEvent) => handler((e as WsReconnectingEvent).attempt));
    },
    permanentlyDisconnected: (handler: (attempt: number) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('permanently_disconnected', (e: WsClientEvent) =>
        handler((e as WsPermanentlyDisconnectedEvent).attempt));
    },
    any: (handler: (e: WsClientEvent) => void): (() => void) => {
      if (!this.ws) {
        throw new Error('WebSocket not connected. Call connect() first.');
      }
      return this.ws.on('*', handler);
    },
  };

  static async createWorkspace(
    name: string,
    options?: string | WorkspaceBootstrapOptions,
  ): Promise<CreateWorkspaceResponse> {
    const { data } = await RelayCast.createWorkspaceWithStatus(name, options);
    return data;
  }

  private static async createWorkspaceWithStatus(
    name: string,
    options?: string | WorkspaceBootstrapOptions,
  ): Promise<{ data: CreateWorkspaceResponse; statusCode: number }> {
    const { apiKey, baseUrl } = resolveWorkspaceBootstrapOptions(options);
    const requestBaseUrl = baseUrl ?? 'https://gateway.relaycast.dev';

    const url = new URL('/v1/workspaces', requestBaseUrl);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'X-SDK-Version': SDK_VERSION,
        'X-Relaycast-Origin-Surface': SDK_ORIGIN.surface,
        'X-Relaycast-Origin-Client': SDK_ORIGIN.client,
        'X-Relaycast-Origin-Version': SDK_ORIGIN.version,
      },
      body: JSON.stringify({ name }),
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new RelayError(
        'transport_error',
        `Failed to parse response as JSON: ${err instanceof Error ? err.message : 'unknown error'}`,
        { statusCode: res.status, retryable: false, cause: err },
      );
    }

    const envelope = ApiResponseSchema(CreateWorkspaceResponseSchema).safeParse(parsed);
    if (!envelope.success) {
      throw new RelayError(
        'transport_error',
        'Response is not a valid Relay API response object',
        { statusCode: res.status, retryable: false },
      );
    }

    if (!envelope.data.ok) {
      throw relayErrorFromApi(envelope.data.error.code, envelope.data.error.message, res.status);
    }

    return {
      data: camelizeKeys(envelope.data.data),
      statusCode: res.status,
    };
  }

  static async lookupWorkspace(name: string, baseUrl?: string): Promise<WorkspaceLookup | null> {
    const requestBaseUrl = baseUrl ?? 'https://gateway.relaycast.dev';

    const url = new URL(`/v1/workspaces/by-name/${encodeURIComponent(name)}`, requestBaseUrl);
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Version': SDK_VERSION,
        'X-Relaycast-Origin-Surface': SDK_ORIGIN.surface,
        'X-Relaycast-Origin-Client': SDK_ORIGIN.client,
        'X-Relaycast-Origin-Version': SDK_ORIGIN.version,
      },
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new RelayError(
        'transport_error',
        `Failed to parse response as JSON: ${err instanceof Error ? err.message : 'unknown error'}`,
        { statusCode: res.status, retryable: false, cause: err },
      );
    }

    const envelope = ApiResponseSchema(WorkspaceLookupSchema).safeParse(parsed);
    if (!envelope.success) {
      throw new RelayError(
        'transport_error',
        'Response is not a valid Relay API response object',
        { statusCode: res.status, retryable: false },
      );
    }

    if (!envelope.data.ok) {
      if (res.status === 404) {
        return null;
      }
      throw relayErrorFromApi(envelope.data.error.code, envelope.data.error.message, res.status);
    }

    return camelizeKeys(envelope.data.data);
  }

  static async ensureWorkspace(
    name: string,
    options?: string | WorkspaceBootstrapOptions,
  ): Promise<EnsureWorkspaceResponse> {
    const { data, statusCode } = await RelayCast.createWorkspaceWithStatus(name, options);
    return { ...data, existed: statusCode === 200, name };
  }

  private rememberIdentity(agentId: string, name: string): void {
    this.identityHint = { agentId, name };
  }

  private async resolveWorkspaceId(): Promise<string> {
    if (this.workspaceIdHint) {
      return this.workspaceIdHint;
    }
    const workspace = await this.workspace.info();
    this.workspaceIdHint = workspace.id;
    return workspace.id;
  }

  private async resolveIdentityInternal(): Promise<ResolvedIdentity> {
    if (!this.identityHint) {
      throw new RelayError('not_found', 'No identity is available. Register or rotate an agent first.', {
        statusCode: 404,
      });
    }

    return {
      agentId: this.identityHint.agentId,
      name: this.identityHint.name,
      workspaceId: await this.resolveWorkspaceId(),
    };
  }

  private async registerWithLegacySuffix(data: CreateAgentRequest): Promise<CreateAgentResponse> {
    const maxAttempts = 5;
    let candidateName = data.name;

    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.agents.register({ ...data, name: candidateName });
      } catch (err) {
        if (!isNameConflictError(err) || attempt === maxAttempts) {
          throw err;
        }
        candidateName = appendLegacySuffix(data.name);
      }
    }

    throw new RelayError('transport_error', 'Failed to register agent identity after suffix retries');
  }

  private registerTypedIdentity(
    type: RegisterIdentityType,
    data: RegisterTypedIdentityInput,
  ): Promise<CreateAgentResponse> {
    return this.agents.register({ ...data, type });
  }

  async registerAgent(data: RegisterAgentInput): Promise<CreateAgentResponse> {
    const { strict, ...request } = data;
    if (strict) {
      return this.agents.register(request);
    }

    emitCompatibilityTelemetry('agents.registerAgent.legacy_suffix', {
      requested_name: data.name,
    });
    return this.registerWithLegacySuffix(request);
  }

  async registerOrRotate(data: RegisterOrRotateInput): Promise<CreateAgentResponse> {
    try {
      return await this.registerAgent({ ...data, strict: true });
    } catch (err) {
      if (isNameConflictError(err)) {
        const agent = await this.agents.get(data.name);
        const { token } = await this.agents.rotateToken(agent.name);
        this.rememberIdentity(agent.id, agent.name);
        const createdAt = agent.createdAt ?? agent.lastSeen;
        return {
          id: agent.id,
          name: agent.name,
          token,
          status: agent.status,
          createdAt,
        };
      }
      throw err;
    }
  }

  async resolveIdentity(): Promise<ResolvedIdentity> {
    return this.resolveIdentityInternal();
  }

  async reconnect(data: AgentReconnectOptions, options?: AgentClientOptions): Promise<AgentClient> {
    const agentClient = this.as(data.apiToken, data.agent ?? options);
    const agent = await agentClient.me();
    this.rememberIdentity(agent.id, agent.name);
    return agentClient;
  }

  agent(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('agent', data);
  }

  human(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('human', data);
  }

  system(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('system', data);
  }

  registerA2a(options: RegisterA2aOptions): Promise<RegisterA2aResponse> {
    return this.client.post('/v1/a2a/register', options);
  }

  listA2aAgents(): Promise<A2aAgentRecord[]> {
    return this.client.get('/v1/a2a/agents');
  }

  removeA2aAgent(name: string): Promise<RemoveA2aAgentResponse> {
    return this.client.request('DELETE', `/v1/a2a/agents/${encodeURIComponent(name)}`);
  }

  getA2aAgentCard(name: string): Promise<A2aAgentCard> {
    return this.client.get(`/v1/a2a/agents/${encodeURIComponent(name)}/card`);
  }

  route(skill: string, message?: string): Promise<RouteResult> {
    return this.client.post('/v1/route', { skill, message });
  }

  searchDirectory(query: SearchDirectoryQuery): Promise<DirectorySearchResult[]> {
    const params: Record<string, string> = {};
    if (query.q) params.q = query.q;
    if (query.tags?.length) params.tags = query.tags.join(',');
    if (query.status) params.status = query.status;
    if (query.limit != null) params.limit = String(query.limit);
    return this.client.get('/v1/directory/search', params);
  }

  publishToDirectory(data: PublishToDirectoryRequest): Promise<DirectoryAgent> {
    return this.client.post('/v1/directory/agents', data);
  }

  importSkills(data: ImportSkillsRequest): Promise<DirectoryAgent | null> {
    return this.client.post('/v1/skills/sync', data);
  }

  searchSkills(query?: SkillSearchQuery): Promise<SkillSearchResult[]> {
    const params: Record<string, string> = {};
    if (query?.q) params.q = query.q;
    if (query?.limit != null) params.limit = String(query.limit);
    return this.client.get('/v1/skills/search', params);
  }

  routeFeedback(data: RouteFeedbackRequest): Promise<RouteFeedbackResult> {
    return this.client.post('/v1/route/feedback', data);
  }

  listDirectory(query?: ListDirectoryQuery): Promise<DirectoryAgent[]> {
    const params: Record<string, string> = {};
    if (query?.status) params.status = query.status;
    if (query?.limit != null) params.limit = String(query.limit);
    return this.client.get('/v1/directory/agents', params);
  }

  getDirectoryAgent(slug: string): Promise<DirectoryAgent> {
    return this.client.get(`/v1/directory/agents/${encodeURIComponent(slug)}`);
  }

  updateDirectoryAgent(slug: string, data: UpdateDirectoryAgentRequest): Promise<DirectoryAgent> {
    return this.client.patch(`/v1/directory/agents/${encodeURIComponent(slug)}`, data);
  }

  deleteDirectoryAgent(slug: string): Promise<void> {
    return this.client.delete(`/v1/directory/agents/${encodeURIComponent(slug)}`);
  }

  listDirectoryRatings(slug: string): Promise<DirectoryRating[]> {
    return this.client.get(`/v1/directory/agents/${encodeURIComponent(slug)}/ratings`);
  }

  rateDirectoryAgent(slug: string, data: RateDirectoryAgentRequest): Promise<DirectoryRating> {
    return this.client.post(`/v1/directory/agents/${encodeURIComponent(slug)}/ratings`, data);
  }

  getRoutingConfig(): Promise<RoutingConfig> {
    return this.client.get('/v1/routing/config');
  }

  updateRoutingConfig(data: UpdateRoutingConfigRequest): Promise<RoutingConfig> {
    return this.client.put('/v1/routing/config', data);
  }

  workspace = {
    info: (): Promise<Workspace> => this.client.get('/v1/workspace'),
    reconnect: (data: AgentReconnectOptions, options?: AgentClientOptions): Promise<AgentClient> =>
      this.reconnect(data, options),
    update: (data: UpdateWorkspaceRequest): Promise<Workspace> =>
      this.client.patch('/v1/workspace', data),
    delete: (): Promise<void> => this.client.delete('/v1/workspace'),
    stream: {
      get: (): Promise<WorkspaceStreamConfig> => this.client.get('/v1/workspace/stream'),
      set: (enabled: boolean): Promise<WorkspaceStreamConfig> =>
        this.client.put('/v1/workspace/stream', { enabled }),
      inherit: (): Promise<WorkspaceStreamConfig> =>
        this.client.put('/v1/workspace/stream', { mode: 'inherit' }),
    },
  };

  systemPrompt = {
    get: (): Promise<SystemPrompt> => this.client.get('/v1/workspace/system-prompt'),
    set: (data: SetSystemPromptRequest): Promise<SystemPrompt> =>
      this.client.put('/v1/workspace/system-prompt', data),
  };

  channels = {
    list: (opts?: ChannelListOptions): Promise<Channel[]> => {
      const query: Record<string, string> = {};
      if (opts?.includeArchived) query.includeArchived = 'true';
      return this.client.get('/v1/channels', query);
    },
    get: (name: string): Promise<Channel & { members: ChannelMemberInfo[] }> =>
      this.client.get(`/v1/channels/${encodeURIComponent(name)}`),
  };

  messages = {
    list: (channel: string, opts?: MessageListQuery): Promise<MessageWithMeta[]> => {
      const name = channel.startsWith('#') ? channel.slice(1) : channel;
      const query: Record<string, string> = {};
      if (opts?.limit != null) query.limit = String(opts.limit);
      if (opts?.before) query.before = opts.before;
      if (opts?.after) query.after = opts.after;
      return this.client.get(`/v1/channels/${encodeURIComponent(name)}/messages`, query);
    },
    get: (id: string): Promise<MessageWithMeta> =>
      this.client.get(`/v1/messages/${encodeURIComponent(id)}`),
    thread: (id: string, opts?: MessageListQuery): Promise<{ parent: MessageWithMeta; replies: MessageWithMeta[] }> => {
      const query: Record<string, string> = {};
      if (opts?.limit != null) query.limit = String(opts.limit);
      if (opts?.before) query.before = opts.before;
      if (opts?.after) query.after = opts.after;
      return this.client.get(`/v1/messages/${encodeURIComponent(id)}/replies`, query);
    },
    reactions: (id: string): Promise<ReactionGroup[]> =>
      this.client.get(`/v1/messages/${encodeURIComponent(id)}/reactions`),
  };

  agents = {
    register: async (data: CreateAgentRequest): Promise<CreateAgentResponse> => {
      const created = await this.client.post<CreateAgentResponse>('/v1/agents', data);
      this.rememberIdentity(created.id, created.name);
      return created;
    },
    list: (query?: AgentListQuery): Promise<Agent[]> => {
      const params: Record<string, string> = {};
      if (query?.status) params.status = query.status;
      return this.client.get('/v1/agents', params);
    },
    get: (name: string): Promise<Agent> =>
      this.client.get(`/v1/agents/${encodeURIComponent(name)}`),
    me: (apiToken?: string): Promise<Agent> =>
      (apiToken ? this.client.withApiKey(apiToken) : this.client).get('/v1/agent'),
    rotateToken: (name: string): Promise<TokenRotateResponse> =>
      this.client.post(`/v1/agents/${encodeURIComponent(name)}/rotate-token`, {}),
    update: (name: string, data: UpdateAgentRequest): Promise<Agent> =>
      this.client.patch(`/v1/agents/${encodeURIComponent(name)}`, data),
    delete: (name: string): Promise<void> =>
      this.client.delete(`/v1/agents/${encodeURIComponent(name)}`),
    presence: (): Promise<AgentPresenceInfo[]> =>
      this.client.get('/v1/agents/presence'),
    registerOrGet: async (data: CreateAgentRequest): Promise<CreateAgentResponse> => {
      emitCompatibilityTelemetry('agents.registerOrGet.deprecated', {
        replacement: 'agents.registerOrRotate',
      });
      return this.registerOrRotate(data);
    },
    registerAgent: (data: RegisterAgentInput): Promise<CreateAgentResponse> =>
      this.registerAgent(data),
    registerOrRotate: (data: RegisterOrRotateInput): Promise<CreateAgentResponse> =>
      this.registerOrRotate(data),
    resolveIdentity: (): Promise<ResolvedIdentity> =>
      this.resolveIdentity(),
    spawn: (data: SpawnAgentRequest): Promise<SpawnAgentResponse> =>
      this.client.post('/v1/agents/spawn', data),
    release: (data: ReleaseAgentRequest): Promise<ReleaseAgentResponse> =>
      this.client.post('/v1/agents/release', data),
    events: {
      emit: (name: string, data: EmitSessionEventRequest): Promise<SessionEvent> =>
        this.client.post(`/v1/agents/${encodeURIComponent(name)}/events`, data),
      list: (name: string, query?: ListSessionEventsQuery): Promise<SessionEvent[]> => {
        const params: Record<string, string> = {};
        if (query?.type) params.type = query.type;
        if (query?.limit != null) params.limit = String(query.limit);
        return this.client.get(`/v1/agents/${encodeURIComponent(name)}/events`, params);
      },
    },
  };

  webhooks = {
    create: (data: CreateWebhookRequest): Promise<CreateWebhookResponse> =>
      this.client.post('/v1/webhooks', data),

    createInbound: (data: CreateWebhookRequest): Promise<CreateWebhookResponse> =>
      this.client.post('/v1/webhooks', data),

    list: (): Promise<Webhook[]> =>
      this.client.get('/v1/webhooks'),

    delete: (id: string): Promise<void> =>
      this.client.delete(`/v1/webhooks/${encodeURIComponent(id)}`),

    trigger: (
      webhookId: string,
      data: WebhookTriggerRequest,
      token: string,
    ): Promise<WebhookTriggerResponse> => {
      return this.client.withApiKey(token).post(`/v1/hooks/${encodeURIComponent(webhookId)}`, data);
    },
  };

  subscriptions = {
    create: (data: CreateSubscriptionRequest): Promise<CreateSubscriptionResponse> =>
      this.client.post('/v1/subscriptions', data),

    list: (): Promise<EventSubscription[]> =>
      this.client.get('/v1/subscriptions'),

    get: (id: string): Promise<EventSubscription> =>
      this.client.get(`/v1/subscriptions/${encodeURIComponent(id)}`),

    delete: (id: string): Promise<void> =>
      this.client.delete(`/v1/subscriptions/${encodeURIComponent(id)}`),
  };

  actions = {
    register: (data: RegisterActionRequest): Promise<ActionDefinition> =>
      this.client.post('/v1/actions', data),

    list: (): Promise<ActionDefinition[]> =>
      this.client.get('/v1/actions'),

    get: (name: string): Promise<ActionDefinition> =>
      this.client.get(`/v1/actions/${encodeURIComponent(name)}`),

    delete: (name: string): Promise<void> =>
      this.client.delete(`/v1/actions/${encodeURIComponent(name)}`),
  };

  certify = {
    submit: (data: SubmitCertificationRequest): Promise<CertificationRun> =>
      this.client.post('/v1/certify', data),

    get: (id: string): Promise<CertificationRun> =>
      this.client.get(`/v1/certify/${encodeURIComponent(id)}`),

    /** Public badge SVG URL for a certification run (served without an auth header). */
    badgeUrl: (id: string): string =>
      new URL(`/v1/certify/${encodeURIComponent(id)}/badge.svg`, this.client.baseUrl).toString(),

    monitor: (data: MonitorCertificationRequest): Promise<CertificationRun> =>
      this.client.post('/v1/certify/monitor', data),
  };

  console = {
    messages: (query?: ConsoleMessagesQuery): Promise<ConsoleMessageLog[]> => {
      const params: Record<string, string> = {};
      if (query?.limit != null) params.limit = String(query.limit);
      if (query?.before) params.before = query.before;
      if (query?.agentId) params.agentId = query.agentId;
      if (query?.channelId) params.channelId = query.channelId;
      if (query?.conversationId) params.conversationId = query.conversationId;
      if (query?.deliveryKind) params.deliveryKind = query.deliveryKind;
      return this.client.get('/v1/console/messages', params);
    },
    stats: (query?: ConsoleWindowQuery): Promise<ConsoleOverview> => {
      const params: Record<string, string> = {};
      if (query?.days != null) params.days = String(query.days);
      return this.client.get('/v1/console/stats', params);
    },
    agents: (query?: ConsoleAgentStatsQuery): Promise<ConsoleAgentStat[]> => {
      const params: Record<string, string> = {};
      if (query?.days != null) params.days = String(query.days);
      if (query?.limit != null) params.limit = String(query.limit);
      return this.client.get('/v1/console/agents', params);
    },
    costs: (query?: ConsoleWindowQuery): Promise<ConsoleCostStats> => {
      const params: Record<string, string> = {};
      if (query?.days != null) params.days = String(query.days);
      return this.client.get('/v1/console/costs', params);
    },
  };

  activity = (limit?: number): Promise<ActivityItem[]> => {
    const params: Record<string, string> = {};
    if (limit !== undefined) params.limit = String(limit);
    return this.client.get('/v1/activity', params);
  };

  allDmConversations = (): Promise<WorkspaceDmConversation[]> =>
    this.client.get('/v1/dm/conversations/all');

  dmMessages = async (conversationId: string, opts?: { limit?: number; before?: string; after?: string }): Promise<DmMessage[]> => {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.before) query.before = opts.before;
    if (opts?.after) query.after = opts.after;
    return this.client.get(`/v1/dm/conversations/${encodeURIComponent(conversationId)}/messages`, query);
  };

  as(agentToken: string, options?: AgentClientOptions): AgentClient {
    const agentHttpClient = this.client.withApiKey(agentToken);
    return new AgentClient(agentHttpClient, options);
  }
}
