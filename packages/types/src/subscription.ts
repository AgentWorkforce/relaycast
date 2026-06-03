import { z } from 'zod';

export const SubscribableEventTypeSchema = z.enum([
  'message.created',
  'message.updated',
  'thread.reply',
  'message.reacted',
  'agent.status.changed',
  'agent.status.idle',
  'agent.status.active',
  'agent.status.blocked',
  'agent.status.waiting',
  'agent.status.offline',
  'channel.created',
  'channel.updated',
  'channel.archived',
  'member.joined',
  'member.left',
  'dm.received',
  'group_dm.received',
  'message.read',
  'file.uploaded',
  'webhook.received',
  'command.invoked',
  'delivery.accepted',
  'delivery.delivered',
  'delivery.deferred',
  'delivery.failed',
  'action.invoked',
  'action.completed',
  'action.failed',
  'action.denied',
]);
export type SubscribableEventType = z.infer<typeof SubscribableEventTypeSchema>;

export const SubscriptionFilterSchema = z.object({
  channel: z.string().optional(),
  mentions: z.string().optional(),
});
export type SubscriptionFilter = z.infer<typeof SubscriptionFilterSchema>;

const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const HeaderValueSchema = z.string().refine((value) => !/[\r\n]/.test(value), 'header values cannot contain CR/LF');
const SubscriptionHeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema);

export const EventSubscriptionSchema = z.object({
  id: z.string(),
  events: z.array(SubscribableEventTypeSchema),
  filter: SubscriptionFilterSchema.nullable(),
  url: z.string(),
  headers: SubscriptionHeadersSchema.nullable().optional(),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type EventSubscription = z.infer<typeof EventSubscriptionSchema>;

export const CreateSubscriptionRequestSchema = z.object({
  events: z.array(SubscribableEventTypeSchema),
  filter: SubscriptionFilterSchema.optional(),
  url: z.string(),
  headers: SubscriptionHeadersSchema.optional(),
  secret: z.string().optional(),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

export const CreateSubscriptionResponseSchema = z.object({
  id: z.string(),
  events: z.array(SubscribableEventTypeSchema),
  filter: SubscriptionFilterSchema.nullable(),
  url: z.string(),
  headers: SubscriptionHeadersSchema.nullable().optional(),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type CreateSubscriptionResponse = z.infer<typeof CreateSubscriptionResponseSchema>;
