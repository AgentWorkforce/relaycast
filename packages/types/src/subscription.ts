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
  'agent.exited',
  'node.status.online',
  'node.status.offline',
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
export const SubscriptionSignatureSchemeSchema = z.enum(['legacy', 'standard-webhooks']);
export type SubscriptionSignatureScheme = z.infer<typeof SubscriptionSignatureSchemeSchema>;

export const EventSubscriptionSchema = z.object({
  id: z.string(),
  events: z.array(SubscribableEventTypeSchema),
  filter: SubscriptionFilterSchema.nullable(),
  url: z.string(),
  headers: SubscriptionHeadersSchema.nullable().optional(),
  signature_scheme: SubscriptionSignatureSchemeSchema,
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
  signature_scheme: SubscriptionSignatureSchemeSchema.optional(),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

export const CreateSubscriptionResponseSchema = z.object({
  id: z.string(),
  events: z.array(SubscribableEventTypeSchema),
  filter: SubscriptionFilterSchema.nullable(),
  url: z.string(),
  headers: SubscriptionHeadersSchema.nullable().optional(),
  signature_scheme: SubscriptionSignatureSchemeSchema,
  is_active: z.boolean(),
  created_at: z.string(),
});
export type CreateSubscriptionResponse = z.infer<typeof CreateSubscriptionResponseSchema>;

export const WebhookDeliveryStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'dead_letter']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  event_id: z.string(),
  event_type: z.string(),
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.string().nullable(),
  last_error: z.string().nullable(),
  last_status: z.number().int().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const ReplayWebhookDeliveryResponseSchema = z.object({
  id: z.string(),
  status: z.literal('pending'),
});
export type ReplayWebhookDeliveryResponse = z.infer<typeof ReplayWebhookDeliveryResponseSchema>;
