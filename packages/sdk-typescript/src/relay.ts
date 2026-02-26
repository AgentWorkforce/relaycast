import type {
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
  CreateCommandRequest,
  CreateCommandResponse,
  AgentCommand,
  ActivityItem,
  WorkspaceDmConversation,
  TokenRotateResponse,
  MessageListQuery,
  MessageWithMeta,
  ReactionGroup,
  SpawnAgentRequest,
  SpawnAgentResponse,
  ReleaseAgentRequest,
  ReleaseAgentResponse,
} from './types.js';
import { ApiErrorSchema, CreateWorkspaceResponseSchema } from '@relaycast/types';
import { AgentClient, type AgentClientOptions } from './agent.js';
import { HttpClient, type RetryPolicyInput } from './client.js';
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
}

export interface WorkspaceStreamConfig {
  enabled: boolean;
  defaultEnabled: boolean;
  override: boolean | null;
}

interface ChannelListOptions {
  includeArchived?: boolean;
}

interface CommandRegisterInput {
  command: string;
  description: string;
  handlerAgent: string;
  parameters?: CreateCommandRequest['parameters'];
}

interface WorkspaceDmMessage {
  id: string;
  agentId: string;
  agentName: string;
  text: string;
  createdAt: string;
}

type RegisterTypedIdentityInput = Omit<CreateAgentRequest, 'type'>;
type RegisterIdentityType = NonNullable<CreateAgentRequest['type']>;

export class RelayCast {
  private client: HttpClient;
  private identityHint: { agentId: string; name: string } | null = null;
  private workspaceIdHint: string | null = null;

  constructor(options: RelayCastOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error('RelayCast apiKey is required');
    }

    // Preserve hidden internal-origin metadata on options when created via
    // createInternalRelayCast() so downstream requests use the correct origin headers.
    this.client = new HttpClient(options);
  }

  static async createWorkspace(
    name: string,
    baseUrl?: string,
  ): Promise<CreateWorkspaceResponse> {
    const requestBaseUrl = baseUrl ?? 'https://api.relaycast.dev';

    const url = new URL('/v1/workspaces', requestBaseUrl);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

    if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed) || typeof parsed.ok !== 'boolean') {
      throw new RelayError(
        'transport_error',
        'Response is not a valid Relay API response object',
        { statusCode: res.status, retryable: false },
      );
    }

    if (!parsed.ok) {
      const errResult = ApiErrorSchema.safeParse(parsed);
      const rawCode = errResult.success ? errResult.data.error.code : undefined;
      const message = errResult.success ? errResult.data.error.message : 'Unknown error';
      throw relayErrorFromApi(rawCode, message, res.status);
    }

    if (!('data' in parsed)) {
      throw new RelayError(
        'transport_error',
        'Response is missing required "data" field',
        { statusCode: res.status, retryable: false },
      );
    }

    const data = (parsed as { data: unknown }).data;
    return camelizeKeys(CreateWorkspaceResponseSchema.parse(data));
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

  agent(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('agent', data);
  }

  human(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('human', data);
  }

  system(data: RegisterTypedIdentityInput): Promise<CreateAgentResponse> {
    return this.registerTypedIdentity('system', data);
  }

  workspace = {
    info: (): Promise<Workspace> => this.client.get('/v1/workspace'),
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
  };

  webhooks = {
    create: (data: CreateWebhookRequest): Promise<CreateWebhookResponse> =>
      this.client.post('/v1/webhooks', data),

    list: (): Promise<Webhook[]> =>
      this.client.get('/v1/webhooks'),

    delete: (id: string): Promise<void> =>
      this.client.delete(`/v1/webhooks/${encodeURIComponent(id)}`),

    trigger: (webhookId: string, data: WebhookTriggerRequest): Promise<WebhookTriggerResponse> =>
      this.client.post(`/v1/hooks/${encodeURIComponent(webhookId)}`, data),
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

  commands = {
    register: (data: CommandRegisterInput): Promise<CreateCommandResponse> =>
      this.client.post('/v1/commands', data),

    list: (): Promise<AgentCommand[]> =>
      this.client.get('/v1/commands'),

    delete: (command: string): Promise<void> =>
      this.client.delete(`/v1/commands/${encodeURIComponent(command)}`),
  };

  activity = (limit?: number): Promise<ActivityItem[]> => {
    const params: Record<string, string> = {};
    if (limit !== undefined) params.limit = String(limit);
    return this.client.get('/v1/activity', params);
  };

  allDmConversations = (): Promise<WorkspaceDmConversation[]> =>
    this.client.get('/v1/dm/conversations/all');

  dmMessages = async (conversationId: string, opts?: { limit?: number; before?: string; after?: string }): Promise<WorkspaceDmMessage[]> => {
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
