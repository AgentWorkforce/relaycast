export type AgentType = 'agent' | 'human';
export type AgentStatus = 'online' | 'offline' | 'away';

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  type: AgentType;
  token_hash: string;
  status: AgentStatus;
  persona: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen: string;
}

export interface CreateAgentRequest {
  name: string;
  type?: AgentType;
  persona?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentResponse {
  id: string;
  name: string;
  token: string;
  status: AgentStatus;
  created_at: string;
}

export interface UpdateAgentRequest {
  status?: AgentStatus;
  persona?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentListQuery {
  status?: AgentStatus | 'all';
}
