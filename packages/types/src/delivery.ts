import { z } from 'zod';

// Durable delivery status lifecycle:
//   accepted  -> queued for the recipient, awaiting handling
//   delivered -> recipient acked (terminal success)
//   deferred  -> recipient asked to retry no earlier than available_at
//   failed    -> recipient failed to handle; retryable indicates whether a retry is sane
//
// `delivered` is the only terminal state — nothing reopens an acked delivery.
// `failed` is intentionally NOT terminal: a retryable failure may later be acked
// (the retry succeeded) or deferred (retry later). `failDelivery` is still
// idempotent — repeating a fail preserves the original error/retryable.
export const DeliveryStatusSchema = z.enum(['accepted', 'delivered', 'deferred', 'failed']);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

// The message payload carried alongside a queued delivery item so an offline
// consumer can recover what it missed without a second round-trip.
export const DeliveryMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  text: z.string(),
  thread_id: z.string().nullable(),
  created_at: z.string(),
});
export type DeliveryMessage = z.infer<typeof DeliveryMessageSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  message_id: z.string(),
  channel_id: z.string(),
  agent_id: z.string(),
  status: DeliveryStatusSchema,
  mode: z.string(),
  reason: z.string().nullable(),
  priority: z.string(),
  retryable: z.boolean().nullable(),
  error: z.string().nullable(),
  available_at: z.string().nullable(),
  deadline: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

// A queued delivery item: the delivery record plus the message it carries.
export const DeliveryItemSchema = DeliverySchema.extend({
  message: DeliveryMessageSchema.nullable(),
});
export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

export const ListDeliveriesQuerySchema = z.object({
  status: DeliveryStatusSchema.optional(),
  // Coerce so the same schema validates both typed callers and raw HTTP query strings.
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type ListDeliveriesQuery = z.infer<typeof ListDeliveriesQuerySchema>;

export const FailDeliveryRequestSchema = z.object({
  error: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type FailDeliveryRequest = z.infer<typeof FailDeliveryRequestSchema>;

export const DeferDeliveryRequestSchema = z.object({
  available_at: z.iso.datetime(),
  reason: z.string().optional(),
});
export type DeferDeliveryRequest = z.infer<typeof DeferDeliveryRequestSchema>;
