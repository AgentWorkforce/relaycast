export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  channel_type: number;
  topic: string | null;
  created_by: string | null;
  created_at: string;
  is_archived: boolean;
}

export interface ChannelMember {
  channel_id: string;
  agent_id: string;
  role: 'owner' | 'member';
  joined_at: string;
  last_read_id: string | null;
}

export interface CreateChannelRequest {
  name: string;
  topic?: string;
}

export interface UpdateChannelRequest {
  topic?: string;
}

export interface ChannelMemberInfo {
  agent_id: string;
  agent_name: string;
  role: 'owner' | 'member';
  joined_at: string;
}

export interface InviteRequest {
  agent: string;
}
