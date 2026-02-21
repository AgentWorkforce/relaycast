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
