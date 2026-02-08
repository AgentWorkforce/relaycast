export type SubscribableEventType =
  | 'message.created'
  | 'message.updated'
  | 'thread.reply'
  | 'reaction.added'
  | 'reaction.removed'
  | 'agent.online'
  | 'agent.offline'
  | 'channel.created'
  | 'channel.updated'
  | 'channel.archived'
  | 'member.joined'
  | 'member.left'
  | 'dm.received'
  | 'group_dm.received'
  | 'message.read'
  | 'file.uploaded'
  | 'webhook.received'
  | 'command.invoked';

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
