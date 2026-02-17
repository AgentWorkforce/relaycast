export interface Agent {
  name: string;
  status: string;
  type: string;
  cli: string;
  currentTask: string;
  persona: string | null;
  metadata: Record<string, unknown>;
  lastSeen: string;
  createdAt: string;
}

export interface Reaction {
  emoji: string;
  agents: string[];
  count: number;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  thread?: string;
  reactions: Reaction[];
  replyCount: number;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  visibility: string;
  status: string;
  createdAt: string;
  createdBy: string;
  memberCount: number;
  unreadCount: number;
  hasMentions: boolean;
  isDm: boolean;
}

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

export interface DashboardData {
  agents: Agent[];
  messages: Message[];
  sessions: unknown[];
}
