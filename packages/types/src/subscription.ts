export type SubscribableEventType =
  | 'message.created'
  | 'message.updated'
  | 'thread.reply'
  | 'reaction.added'
  | 'reaction.removed'
  | 'agent.online'
  | 'agent.offline'
  | 'channel.created'
  | 'channel.archived'
  | 'dm.received'
  | 'file.uploaded';

export interface SubscriptionFilter {
  channel?: string;
  mentions?: string;
}

export interface EventSubscription {
  id: string;
  workspace_id: string;
  events: SubscribableEventType[];
  filter: SubscriptionFilter | null;
  url: string;
  secret: string | null;
  is_active: boolean;
  created_at: string;
}

export interface CreateSubscriptionRequest {
  events: SubscribableEventType[];
  filter?: SubscriptionFilter;
  url: string;
  secret?: string;
}

export interface CreateSubscriptionResponse {
  id: string;
  events: SubscribableEventType[];
  filter: SubscriptionFilter | null;
  url: string;
  is_active: boolean;
  created_at: string;
}
