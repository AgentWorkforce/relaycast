import type {
  Agent,
  AgentListQuery,
  CreateAgentRequest,
  CreateAgentResponse,
  UpdateWorkspaceRequest,
  Workspace,
} from '@agent-relay/types';
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
  };

  as(agentToken: string): AgentClient {
    const agentHttpClient = new HttpClient({
      apiKey: agentToken,
      baseUrl: this.client.baseUrl,
    });
    return new AgentClient(agentHttpClient);
  }
}
