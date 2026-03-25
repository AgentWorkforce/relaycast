export type ActivityEventType =
  | 'message_sent'
  | 'connection'
  | 'agent_idle'
  | 'reaction'
  | 'thread_reply';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  summary: string;
  timestamp: string;
  agent?: string;
}

export interface WebSocketFeedEvent {
  id: string;
  eventType: string;
  summary: string;
  timestamp: string;
}

export interface ConsoleMessageLog {
  id: string;
  message_id: string;
  channel_id: string;
  channel_name: string | null;
  agent_id: string;
  agent_name: string | null;
  conversation_id: string | null;
  delivery_kind: 'channel' | 'dm';
  text: string;
  content_type: string | null;
  metadata: Record<string, unknown>;
  attachment_count: number;
  mention_count: number;
  latency_ms: number;
  created_at: string;
}

export interface ConsoleOverview {
  window_days: number;
  since: string;
  total_messages: number;
  channel_messages: number;
  dm_messages: number;
  unique_agents: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  attachment_count: number;
  mention_count: number;
}

export interface ConsoleAgentStat {
  agent_id: string;
  agent_name: string;
  message_count: number;
  channel_count: number;
  dm_count: number;
  avg_latency_ms: number;
  last_message_at: string | null;
}

export interface ConsoleCostAgentStat {
  agent_id: string;
  agent_name: string;
  message_count: number;
  total_cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ConsoleCostStats {
  window_days: number;
  totals: {
    total_cost_usd: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  agents: ConsoleCostAgentStat[];
}
