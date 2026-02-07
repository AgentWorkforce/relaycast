import type { FileAttachment } from './file.js';
import type { ReactionGroup } from './reaction.js';

export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  thread_id: string | null;
  body: string;
  has_attachments: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface MessageWithMeta {
  id: string;
  agent_name: string;
  agent_id: string;
  text: string;
  attachments: FileAttachment[];
  created_at: string;
  reply_count: number;
  reactions: ReactionGroup[];
  read_by_count: number;
}

export interface PostMessageRequest {
  text: string;
  attachments?: string[];
}

export interface MessageListQuery {
  limit?: number;
  before?: string;
  after?: string;
}

export interface ThreadReplyRequest {
  text: string;
}
