import { z } from 'zod';

// Durable delivery status lifecycle:
//   queued    -> durable row accepted, not yet sent to the current location
//   delivered -> sent to the current location, awaiting cumulative ack
//   acked     -> recipient location acknowledged through the seq cursor
//
// Failed/dead-lettered rows are terminal failure states used for explicit
// failure reports and TTL expiry respectively.
export const DeliveryStatusSchema = z.enum(['queued', 'delivered', 'acked', 'failed', 'dead_lettered']);
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
  seq: z.number(),
  location_type: z.string(),
  location_node_id: z.string().nullable(),
  mode: z.string(),
  reason: z.string().nullable(),
  priority: z.string(),
  retryable: z.boolean().nullable(),
  error: z.string().nullable(),
  available_at: z.string().nullable(),
  deadline: z.string().nullable(),
  expires_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  dead_lettered_at: z.string().nullable(),
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
