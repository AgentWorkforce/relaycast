export interface WorkspaceStats {
  agents: { total: number; online: number; offline: number };
  channels: { total: number; archived: number };
  messages: { total: number; today: number };
  dms: { total_conversations: number };
  files: { total: number; storage_bytes: number };
}

export interface ActivityItem {
  type: 'message' | 'dm';
  id: string;
  channel_name?: string;
  conversation_id?: string;
  agent_name: string;
  text: string;
  created_at: string;
}

export interface WorkspaceDmConversation {
  id: string;
  type: string;
  participants: string[];
  last_message: {
    text: string;
    agent_name: string;
    created_at: string;
  } | null;
  message_count: number;
}

export interface TokenRotateResponse {
  name: string;
  token: string;
}
