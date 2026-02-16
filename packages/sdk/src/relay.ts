import type {
  Agent,
  AgentListQuery,
  AgentPresenceInfo,
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
  WorkspaceStats,
  ActivityItem,
  WorkspaceDmConversation,
  TokenRotateResponse,
} from '@relaycast/types';
import { ApiErrorSchema, CreateWorkspaceResponseSchema } from '@relaycast/types';
import { AgentClient } from './agent.js';
import { BillingClient } from './billing.js';
import { HttpClient, RelayError } from './client.js';
import { SDK_VERSION } from './version.js';

export interface RelayOptions {
  apiKey: string;
  baseUrl?: string;
}

export class Relay {
  private client: HttpClient;
  billing: BillingClient;

  constructor(options: RelayOptions) {
    this.client = new HttpClient(options);
    this.billing = new BillingClient(this.client);
  }

  static async createWorkspace(
    name: string,
    baseUrl?: string,
  ): Promise<CreateWorkspaceResponse> {
    const url = new URL('/v1/workspaces', baseUrl ?? 'https://api.agentrelay.dev');
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
  };

  systemPrompt = {
    get: (): Promise<SystemPrompt> => this.client.get('/v1/workspace/system-prompt'),
    set: (data: SetSystemPromptRequest): Promise<SystemPrompt> =>
      this.client.put('/v1/workspace/system-prompt', data),
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

  stats = (): Promise<WorkspaceStats> =>
    this.client.get('/v1/workspace/stats');

  activity = (limit?: number): Promise<ActivityItem[]> => {
    const params: Record<string, string> = {};
    if (limit !== undefined) params.limit = String(limit);
    return this.client.get('/v1/activity', params);
  };

  allDmConversations = (): Promise<WorkspaceDmConversation[]> =>
    this.client.get('/v1/dm/conversations/all');

  as(agentToken: string): AgentClient {
    const agentHttpClient = new HttpClient({
      apiKey: agentToken,
      baseUrl: this.client.baseUrl,
    });
    return new AgentClient(agentHttpClient);
  }
}
