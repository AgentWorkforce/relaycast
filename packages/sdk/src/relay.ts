import type {
  Agent,
  AgentListQuery,
  CreateAgentRequest,
  CreateAgentResponse,
  UpdateWorkspaceRequest,
  Workspace,
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
import { AgentClient } from './agent.js';
import { BillingClient } from './billing.js';
import { HttpClient } from './client.js';

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

  workspace = {
    info: (): Promise<Workspace> => this.client.get('/v1/workspace'),
    update: (data: UpdateWorkspaceRequest): Promise<Workspace> =>
      this.client.patch('/v1/workspace', data),
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
