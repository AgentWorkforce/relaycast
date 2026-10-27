export type WebSocketFeedCategory =
  | 'message'
  | 'action'
  | 'presence'
  | 'reaction'
  | 'channel'
  | 'delivery'
  | 'system';

export interface WebSocketFeedEvent {
  id: string;
  eventType: string;
  summary: string;
  category: WebSocketFeedCategory;
  timestamp: string;
}
