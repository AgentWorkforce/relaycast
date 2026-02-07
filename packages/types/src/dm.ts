export type DmType = '1:1' | 'group';

export interface DmConversation {
  id: string;
  workspace_id: string;
  channel_id: string;
  dm_type: DmType;
  name: string | null;
  created_at: string;
}

export interface DmParticipant {
  conversation_id: string;
  agent_id: string;
  joined_at: string;
  left_at: string | null;
}

export interface SendDmRequest {
  to: string;
  text: string;
}

export interface CreateGroupDmRequest {
  participants: string[];
  name?: string;
  text: string;
}

export interface DmConversationSummary {
  id: string;
  type: DmType;
  name: string | null;
  participants: string[];
  last_message: string | null;
  unread_count: number;
}
