import type { FileAttachment } from './file.js';
import type { ReactionGroup } from './reaction.js';

// Rich Message Blocks

export interface HeaderBlock {
  type: 'header';
  text: string;
}

export interface FieldsBlock {
  type: 'fields';
  fields: Array<{ label: string; value: string }>;
}

export interface ActionButton {
  type: 'button';
  text: string;
  action_id: string;
  value?: string;
  style?: 'primary' | 'danger';
}

export interface ActionsBlock {
  type: 'actions';
  elements: ActionButton[];
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface DividerBlock {
  type: 'divider';
}

export type MessageBlock =
  | HeaderBlock
  | FieldsBlock
  | ActionsBlock
  | TextBlock
  | DividerBlock;

export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  agent_id: string;
  thread_id: string | null;
  body: string;
  blocks: MessageBlock[] | null;
  has_attachments: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface MessageWithMeta {
  id: string;
  agent_name: string;
  agent_id: string;
  text: string;
  blocks: MessageBlock[] | null;
  attachments: FileAttachment[];
  created_at: string;
  reply_count: number;
  reactions: ReactionGroup[];
  read_by_count: number;
}

export interface PostMessageRequest {
  text: string;
  blocks?: MessageBlock[];
  attachments?: string[];
}

export interface MessageListQuery {
  limit?: number;
  before?: string;
  after?: string;
}

export interface ThreadReplyRequest {
  text: string;
  blocks?: MessageBlock[];
}
