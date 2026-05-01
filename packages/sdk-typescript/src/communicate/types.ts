import type { AgentClient } from '../agent.js';
import type { InboxResponse, MessageWithMeta, SendDmResponse } from '../types.js';

export interface Message {
  id: string;
  sender: string;
  channel?: string;
  text: string;
  createdAt: string;
  threadId?: string | null;
}

export type MessageCallback = (message: Message) => void | Promise<void>;

export interface RelayConfig {
  agentClient: AgentClient;
}

export interface RelayLike {
  readonly agents: AgentClient;
  post(channel: string, text: string): Promise<MessageWithMeta>;
  send(toAgent: string, text: string): Promise<SendDmResponse>;
  reply(messageId: string, text: string): Promise<MessageWithMeta>;
  inbox(): Promise<InboxResponse>;
  onMessage(cb: MessageCallback): () => void;
}
