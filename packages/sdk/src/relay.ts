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
} from '@relaycast/types';
import { ApiErrorSchema, CreateWorkspaceResponseSchema } from '@relaycast/types';
import { AgentClient } from './agent.js';
import { BillingClient } from './billing.js';
import { HttpClient, RelayError } from './client.js';
import { SDK_VERSION } from './version.js';

export interface RelayCastOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface WorkspaceStreamConfig {
  enabled: boolean;
  default_enabled: boolean;
  override: boolean | null;
}

export class RelayCast {
  private client: HttpClient;
  billing: BillingClient;

  constructor(options: RelayCastOptions) {
    this.client = new HttpClient(options);
    this.billing = new BillingClient(this.client);
  }

  static async createWorkspace(
    name: string,
    baseUrl?: string,
  ): Promise<CreateWorkspaceResponse> {
    const url = new URL('/v1/workspaces', baseUrl ?? 'https://api.relaycast.dev');
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SDK-Version': SDK_VERSION,
      },
      body: JSON.stringify({ name }),
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new RelayError(
        'invalid_response',
        `Failed to parse response as JSON: ${err instanceof Error ? err.message : 'unknown error'}`,
        res.status,
      );
    }

    if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed) || typeof parsed.ok !== 'boolean') {
      throw new RelayError(
        'invalid_response',
        'Response is not a valid Relay API response object',
        res.status,
      );
    }

    if (!parsed.ok) {
      const errResult = ApiErrorSchema.safeParse(parsed);
      throw new RelayError(
        errResult.success ? errResult.data.error.code : 'unknown_error',
        errResult.success ? errResult.data.error.message : 'Unknown error',
        res.status,
      );
    }

    if (!('data' in parsed)) {
      throw new RelayError(
        'invalid_response',
        'Response is missing required "data" field',
        res.status,
      );
    }

    const data = (parsed as { data: unknown }).data;
    return CreateWorkspaceResponseSchema.parse(data);
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
    list: (opts?: { include_archived?: boolean }): Promise<Channel[]> => {
      const query: Record<string, string> = {};
      if (opts?.include_archived) query.include_archived = 'true';
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
    register: (data: CreateAgentRequest): Promise<CreateAgentResponse> =>
      this.client.post('/v1/agents', data),
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
      try {
        return await this.agents.register(data);
      } catch (err) {
        if (err instanceof RelayError && err.code === 'agent_already_exists') {
          const agent = await this.agents.get(data.name);
          const { token } = await this.agents.rotateToken(agent.name);
          return {
            id: agent.id,
            name: agent.name,
            token,
            status: agent.status,
            created_at: agent.created_at,
          };
        }
        throw err;
      }
    },
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
    register: (data: CreateCommandRequest): Promise<CreateCommandResponse> =>
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

  dmMessages = (conversationId: string, opts?: { limit?: number; before?: string; after?: string }): Promise<Array<{ id: string; agent_id: string; agent_name: string; text: string; created_at: string }>> => {
    const query: Record<string, string> = {};
    if (opts?.limit !== undefined) query.limit = String(opts.limit);
    if (opts?.before) query.before = opts.before;
    if (opts?.after) query.after = opts.after;
    return this.client.get(`/v1/dm/conversations/${encodeURIComponent(conversationId)}/messages`, query);
  };

  as(agentToken: string): AgentClient {
    const agentHttpClient = new HttpClient({
      apiKey: agentToken,
      baseUrl: this.client.baseUrl,
    });
    return new AgentClient(agentHttpClient);
  }
}
